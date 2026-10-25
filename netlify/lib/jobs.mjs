// Scheduled work: pull Facebook results, and draft the weekly reports.
// Used by the scheduled functions and by the "Run now" buttons in Admin.

import { addDays, mondayOf, parseMetaInsights, buildReport, clean, findAlerts, attentionEmail, reportReadyEmail, parseAdminEmails, metaLeadEvent, metaEventUsable, toInt } from "./util.mjs";
import { stripeOn } from "./billing.mjs";
import { sendEmail } from "./email.mjs";

const GRAPH = "https://graph.facebook.com/v21.0";

/** Pull the last 7 days of Facebook/Instagram results for every client with a Meta ad account id. */
export async function syncMeta(db) {
  const token = Netlify.env.get("META_ACCESS_TOKEN");
  const clients = await db.sql`SELECT id, meta_ad_account_id FROM clients WHERE meta_ad_account_id IS NOT NULL`;
  const result = { clients: clients.length, saved: 0, failed: 0, skipped: !token };
  if (!token) {
    for (const c of clients) {
      await db.sql`UPDATE clients SET meta_last_error = 'No Facebook access token has been added to the site yet.' WHERE id = ${c.id}`;
    }
    return result;
  }
  for (const c of clients) {
    try {
      const url = `${GRAPH}/act_${c.meta_ad_account_id}/insights?level=account&time_increment=1&date_preset=last_7d&fields=spend,impressions,clicks,actions`;
      const res = await fetch(url, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(clean(data?.error?.message, 160) || `Facebook said ${res.status}`);
      for (const r of parseMetaInsights(data)) {
        await db.sql`
          INSERT INTO ad_stats (client_id, day, platform, spend_pence, impressions, clicks, enquiries)
          VALUES (${c.id}, ${r.day}, 'meta', ${r.spend_pence}, ${r.impressions}, ${r.clicks}, ${r.enquiries})
          ON CONFLICT (client_id, day, platform) DO UPDATE SET
            spend_pence = EXCLUDED.spend_pence, impressions = EXCLUDED.impressions,
            clicks = EXCLUDED.clicks, enquiries = EXCLUDED.enquiries`;
        result.saved++;
      }
      await db.sql`UPDATE clients SET meta_last_sync = NOW(), meta_last_error = NULL WHERE id = ${c.id}`;
    } catch (e) {
      result.failed++;
      console.error("meta sync failed", c.id, e);
      await db.sql`UPDATE clients SET meta_last_error = ${clean(e.message, 200) || "Sync failed"} WHERE id = ${c.id}`;
    }
  }
  return result;
}

async function weekFacts(db, clientId, from, toExclusive) {
  const [l] = await db.sql`
    SELECT COUNT(*)::int AS enquiries FROM leads
    WHERE client_id = ${clientId} AND status <> 'spam' AND received_at >= ${from} AND received_at < ${toExclusive}`;
  const [c] = await db.sql`
    SELECT COUNT(*)::int AS calls, COUNT(*) FILTER (WHERE status = 'completed')::int AS answered FROM calls
    WHERE client_id = ${clientId} AND started_at >= ${from} AND started_at < ${toExclusive}`;
  const [a] = await db.sql`
    SELECT COALESCE(SUM(spend_pence), 0)::int AS spend_pence, COALESCE(SUM(clicks), 0)::int AS clicks FROM ad_stats
    WHERE client_id = ${clientId} AND day >= ${from} AND day < ${toExclusive}`;
  const sources = await db.sql`
    SELECT COALESCE(source, 'Website') AS source, COUNT(*)::int AS n FROM leads
    WHERE client_id = ${clientId} AND status <> 'spam' AND received_at >= ${from} AND received_at < ${toExclusive}
    GROUP BY 1 ORDER BY n DESC LIMIT 8`;
  return { ...l, ...c, ...a, sources };
}

/** Draft last week's report (Monday to Sunday) for every client. Safe to run more than once. */
export async function draftWeeklyReports(db, todayDay = new Date().toISOString().slice(0, 10)) {
  const thisMonday = mondayOf(todayDay);
  const weekStart = addDays(thisMonday, -7);
  const clients = await db.sql`SELECT id, name FROM clients`;
  let created = 0;
  for (const c of clients) {
    const cur = await weekFacts(db, c.id, weekStart, thisMonday);
    const prev = await weekFacts(db, c.id, addDays(weekStart, -7), weekStart);
    const { title, body } = buildReport({ name: c.name, weekStart, cur, prev });
    const done = await db.sql`
      INSERT INTO reports (client_id, week_start, title, body, published, auto)
      VALUES (${c.id}, ${weekStart}, ${title}, ${body}, FALSE, TRUE)
      ON CONFLICT (client_id, week_start) WHERE auto DO NOTHING RETURNING id`;
    created += done.length;
  }
  return { weekStart, clients: clients.length, created };
}


const portalUrl = () => `${(Netlify.env.get("PUBLIC_BASE_URL") || "https://alpha-analytica.netlify.app").replace(/\/$/, "")}/portal/`;

/** Everything that needs a human, across all clients. */
export async function attentionItems(db, today = new Date().toISOString().slice(0, 10)) {
  const rows = await db.sql`
    SELECT c.id, c.name, c.website_url, c.created_at, c.google_customer_id, c.meta_ad_account_id,
           c.google_last_push, c.meta_last_sync, c.meta_last_error,
           (c.intake <> '{}'::jsonb) AS has_intake,
           (SELECT MAX(received_at) FROM leads l WHERE l.client_id = c.id AND l.status <> 'spam') AS last_lead_at,
           (SELECT COUNT(*)::int FROM calls k WHERE k.client_id = c.id AND k.started_at > NOW() - INTERVAL '7 days'
              AND k.status IN ('failed', 'busy')) AS failed_calls_7d,
           (SELECT COUNT(*)::int FROM reports r WHERE r.client_id = c.id AND NOT r.published) AS drafts
    FROM clients c ORDER BY c.name`;
  const items = [];
  for (const r of rows) for (const a of findAlerts(r, today)) items.push({ client_id: r.id, client: r.name, ...a });

  // money: disputes to review, drafts to approve, failed payments, missing payment methods
  const money = await db.sql`
    SELECT c.id, c.name, c.payment_ready, c.created_at,
      (SELECT COUNT(*)::int FROM leads l WHERE l.client_id = c.id AND l.dispute_state = 'open') AS open_disputes,
      (SELECT COUNT(*)::int FROM invoices i WHERE i.client_id = c.id AND i.status = 'draft') AS drafts,
      (SELECT COUNT(*)::int FROM invoices i WHERE i.client_id = c.id AND i.status = 'failed') AS failed
    FROM clients c ORDER BY c.name`;
  for (const m of money) {
    if (m.failed) items.push({ client_id: m.id, client: m.name, level: "bad", message: `A payment failed (${m.failed} invoice${m.failed === 1 ? "" : "s"}). Stripe is retrying; contact them if it stays unpaid.` });
    if (m.open_disputes) items.push({ client_id: m.id, client: m.name, level: "check", message: `${m.open_disputes} enquiry dispute${m.open_disputes === 1 ? "" : "s"} to review. Their invoice waits until you decide.` });
    if (m.drafts) items.push({ client_id: m.id, client: m.name, level: "check", message: `${m.drafts} invoice${m.drafts === 1 ? " is" : "s are"} waiting for your approval.` });
    if (stripeOn() && !m.payment_ready && Date.now() - new Date(m.created_at).getTime() > 3 * 86400000) {
      items.push({ client_id: m.id, client: m.name, level: "check", message: "They haven't saved a payment method yet." });
    }
  }
  return items;
}

/** Monday email to the admins listing what needs attention. */
export async function sendAttentionEmail(db) {
  const items = await attentionItems(db);
  const to = parseAdminEmails(Netlify.env.get("ADMIN_EMAILS"));
  return sendEmail({ to, ...attentionEmail({ items, portalUrl: portalUrl() }) });
}

/** Tell a client's logins that a report is ready. Sends once per report. */
export async function notifyReportPublished(db, reportId) {
  const [r] = await db.sql`
    SELECT r.id, r.title, r.emailed_at, r.published, c.id AS client_id, c.name
    FROM reports r JOIN clients c ON c.id = r.client_id WHERE r.id = ${reportId}`;
  if (!r || !r.published || r.emailed_at) return { skipped: true };
  const users = await db.sql`SELECT email FROM client_users WHERE client_id = ${r.client_id}`;
  const result = await sendEmail({ to: users.map((u) => u.email), ...reportReadyEmail({ clientName: r.name, title: r.title, portalUrl: portalUrl() }) });
  if (result.sent) await db.sql`UPDATE reports SET emailed_at = NOW() WHERE id = ${reportId}`;
  return result;
}


/* ---------- genuine enquiries back to Facebook (Meta Conversions API) ---------- */

/** Hours to wait before sending, so you can mark spam first. Default 6. */
export const conversionDelayHours = () => toInt(Netlify.env.get("CONVERSION_DELAY_HOURS"), { min: 0, max: 72 }) ?? 6;

export async function sendMetaConversions(db) {
  const token = Netlify.env.get("META_CAPI_TOKEN") || Netlify.env.get("META_ACCESS_TOKEN");
  const result = { pixels: 0, sent: 0, failed: 0, unusable: 0, skipped: !token };
  if (!token) return result;
  const delay = conversionDelayHours();
  const leads = await db.sql`
    SELECT l.id, l.client_id, l.type, l.received_at, l.email, l.phone, l.fbc, l.fbp, l.ip, l.user_agent, l.page_url,
           c.meta_pixel_id
    FROM leads l JOIN clients c ON c.id = l.client_id
    WHERE l.meta_sent_at IS NULL AND l.status <> 'spam' AND c.meta_pixel_id IS NOT NULL
      AND l.received_at < NOW() - make_interval(hours => ${delay}::int)
      AND l.received_at > NOW() - INTERVAL '6 days 20 hours'
    ORDER BY l.received_at LIMIT 1000`;
  const byPixel = new Map();
  for (const l of leads) {
    const ev = metaLeadEvent(l);
    if (!metaEventUsable(ev)) {
      result.unusable++;
      await db.sql`UPDATE leads SET meta_error = 'No email, phone or Facebook click to match on' WHERE id = ${l.id}`;
      continue;
    }
    if (!byPixel.has(l.meta_pixel_id)) byPixel.set(l.meta_pixel_id, []);
    byPixel.get(l.meta_pixel_id).push({ id: l.id, ev });
  }
  result.pixels = byPixel.size;
  for (const [pixel, items] of byPixel) {
    for (let i = 0; i < items.length; i += 500) {
      const batch = items.slice(i, i + 500);
      const ids = batch.map((b) => b.id);
      try {
        const body = { data: batch.map((b) => b.ev) };
        const testCode = Netlify.env.get("META_TEST_EVENT_CODE");
        if (testCode) body.test_event_code = testCode;
        const res = await fetch(`https://graph.facebook.com/v21.0/${pixel}/events`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(20_000),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(clean(data?.error?.message, 200) || `Facebook said ${res.status}`);
        await db.sql`UPDATE leads SET meta_sent_at = NOW(), meta_error = NULL WHERE id = ANY(${ids})`;
        result.sent += ids.length;
      } catch (e) {
        console.error("meta conversions failed", pixel, e);
        result.failed += ids.length;
        await db.sql`UPDATE leads SET meta_error = ${clean(e.message, 200) || "Send failed"} WHERE id = ANY(${ids})`;
      }
    }
  }
  return result;
}
