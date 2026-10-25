// The weekly AI review of every client's advertising.
// Claude reads last week's real numbers (spend, enquiries, spam, customers, calls, by platform and campaign)
// against the week before, and writes what is working, what is not, and the changes to make next.
// It recommends only. A person checks each change and makes it in the ad account. Nothing is changed automatically.

import { addDays, mondayOf, clean } from "./util.mjs";

/** Last week's numbers against the week before, for one client. Everything here is counted from our own records. */
export async function reviewFacts(db, clientId, weekStart) {
  const from = weekStart, to = addDays(weekStart, 7), pFrom = addDays(weekStart, -7);
  const period = async (a, b) => {
    const platforms = await db.sql`
      SELECT platform, COALESCE(SUM(spend_pence),0)::int AS spend_pence, COALESCE(SUM(impressions),0)::int AS impressions,
             COALESCE(SUM(clicks),0)::int AS clicks, COALESCE(SUM(enquiries),0)::int AS platform_conversions
      FROM ad_stats WHERE client_id = ${clientId} AND day >= ${a} AND day < ${b} GROUP BY platform ORDER BY platform`;
    const campaigns = await db.sql`
      SELECT COALESCE(NULLIF(campaign, ''), '(no campaign name)') AS campaign, COALESCE(source, 'Website') AS source,
             COUNT(*) FILTER (WHERE status <> 'spam')::int AS enquiries,
             COUNT(*) FILTER (WHERE status = 'qualified')::int AS qualified,
             COUNT(*) FILTER (WHERE status = 'customer')::int AS customers,
             COUNT(*) FILTER (WHERE status = 'spam')::int AS spam
      FROM leads WHERE client_id = ${clientId} AND received_at >= ${a} AND received_at < ${b} AND source IS DISTINCT FROM 'Test enquiry'
      GROUP BY 1, 2 ORDER BY enquiries DESC LIMIT 12`;
    const [calls] = await db.sql`
      SELECT COUNT(*)::int AS calls, COUNT(*) FILTER (WHERE status = 'completed')::int AS answered
      FROM calls WHERE client_id = ${clientId} AND started_at >= ${a} AND started_at < ${b}`;
    return { platforms, campaigns, calls };
  };
  const [client] = await db.sql`SELECT name, sector, price_per_enquiry_pence FROM clients WHERE id = ${clientId}`;
  return { business: client?.name, sector: client?.sector || null, week_start: from, last_week: await period(from, to), week_before: await period(pFrom, from) };
}

/** Nothing to say about a client with no ad data and no enquiries at all. */
export const hasSomethingToReview = (f) => {
  const w = f.last_week;
  return w.platforms.some((p) => p.spend_pence > 0 || p.clicks > 0) || w.campaigns.length > 0 || w.calls.calls > 0;
};

export function reviewRequest(facts) {
  const system = [
    "You are the weekly advertising reviewer for Alpha Analytica, a small Manchester agency that runs Google and Facebook ads for local businesses and charges per genuine enquiry.",
    "You are given one client's real numbers for last week and the week before. Review how their advertising is doing and say what to change.",
    "Use ONLY the numbers provided. Never invent figures, benchmarks, competitor behaviour or causes you cannot see in the data. If the data is too thin to say, say that plainly and say what data would settle it.",
    "Money is in pence in the data: show it as pounds. Work out cost per enquiry as spend divided by enquiries and say when there are too few enquiries (under about 5) for that to mean much.",
    "You recommend, a person decides. Every change must be something a person can do in the Google Ads or Meta Ads account, such as pausing a campaign, moving budget, adding negative keywords, changing wording, or testing a new advert. Never say you have changed anything.",
    "Plain British English, no jargon, no hype, no exclamation marks.",
    "Reply with ONE JSON object only, in exactly this shape:",
    '{"headline": string (one sentence on how the week went), "working": [string] (up to 3), "not_working": [string] (up to 3), "changes": [{"action": string, "why": string}] (2 to 4, most important first), "test_next": string (one specific test for next week), "client_note": string (2 or 3 sentences for the client to read: what we saw and what we are changing, no jargon)}',
  ].join("\n");
  return { system, user: "This client's numbers:\n" + JSON.stringify(facts, null, 2) };
}

export function parseReview(text) {
  if (typeof text !== "string") return null;
  const a = text.indexOf("{"), b = text.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  let o;
  try { o = JSON.parse(text.slice(a, b + 1)); } catch { return null; }
  const s = (v, n) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, n) : "");
  const list = (v, n, f) => (Array.isArray(v) ? v.slice(0, n).map(f).filter(Boolean) : []);
  const out = {
    headline: s(o.headline, 260),
    working: list(o.working, 3, (x) => s(x, 300)),
    not_working: list(o.not_working, 3, (x) => s(x, 300)),
    changes: list(o.changes, 4, (c) => (c && s(c.action, 240) && s(c.why, 300) ? { action: s(c.action, 240), why: s(c.why, 300) } : null)),
    test_next: s(o.test_next, 300),
    client_note: s(o.client_note, 600),
  };
  return out.headline && out.changes.length && out.client_note ? out : null;
}

export async function claudeReview(facts, { fetchImpl = fetch } = {}) {
  const key = globalThis.Netlify?.env?.get?.("ANTHROPIC_API_KEY");
  if (!key) return { skipped: "no ANTHROPIC_API_KEY" };
  const req = reviewRequest(facts);
  try {
    const res = await fetchImpl("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: Netlify.env.get("REVIEW_MODEL") || "claude-sonnet-5-5", max_tokens: 1500, system: req.system, messages: [{ role: "user", content: req.user }] }),
      signal: AbortSignal.timeout(25_000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Anthropic ${res.status}`);
    const review = parseReview(data?.content?.find((b) => b.type === "text")?.text);
    return review ? { review } : { error: "Couldn't read the review" };
  } catch (e) {
    return { error: String(e.message).slice(0, 100) };
  }
}

/** Review one client for one week and save it. Also adds the client-facing note to that week's unpublished draft report. */
export async function reviewClient(db, clientId, weekStart, opts) {
  const facts = await reviewFacts(db, clientId, weekStart);
  if (!hasSomethingToReview(facts)) return { skipped: "nothing to review yet" };
  const r = await claudeReview(facts, opts);
  if (!r.review) return r;
  await db.sql`
    INSERT INTO ad_reviews (client_id, week_start, review, facts) VALUES (${clientId}, ${weekStart}, ${JSON.stringify(r.review)}::jsonb, ${JSON.stringify(facts)}::jsonb)
    ON CONFLICT (client_id, week_start) DO UPDATE SET review = EXCLUDED.review, facts = EXCLUDED.facts, created_at = NOW()`;
  await db.sql`
    UPDATE reports SET body = body || ${"\n\nOur weekly review\n" + r.review.client_note}
    WHERE client_id = ${clientId} AND week_start = ${weekStart} AND auto AND NOT published AND body NOT LIKE '%Our weekly review%'`;
  return { reviewed: true };
}

/** Every client, last week. Safe to run twice: a client already reviewed is left alone unless force is set. */
export async function runWeeklyReviews(db, { today = new Date().toISOString().slice(0, 10), force = false, clientId = null, fetchImpl, deadlineMs = 24_000 } = {}) {
  const started = Date.now();
  const weekStart = addDays(mondayOf(today), -7);
  const clients = clientId ? await db.sql`SELECT id, name FROM clients WHERE id = ${clientId}` : await db.sql`SELECT id, name FROM clients ORDER BY id`;
  const result = { weekStart, clients: clients.length, reviewed: 0, skipped: 0, failed: 0, noKey: false };
  for (const c of clients) {
    if (Date.now() - started > deadlineMs - 8000) { result.skipped++; continue; }
    if (!force) {
      const [done] = await db.sql`SELECT 1 AS x FROM ad_reviews WHERE client_id = ${c.id} AND week_start = ${weekStart}`;
      if (done) { result.skipped++; continue; }
    }
    const r = await reviewClient(db, c.id, weekStart, { fetchImpl });
    if (r.reviewed) result.reviewed++;
    else if (r.skipped === "no ANTHROPIC_API_KEY") { result.noKey = true; result.skipped++; }
    else if (r.skipped) result.skipped++;
    else { result.failed++; console.error("ad review failed", c.id, r.error); }
  }
  return result;
}
