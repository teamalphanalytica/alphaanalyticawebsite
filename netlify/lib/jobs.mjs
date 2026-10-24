// Scheduled work: pull Facebook results, and draft the weekly reports.
// Used by the scheduled functions and by the "Run now" buttons in Admin.

import { addDays, mondayOf, parseMetaInsights, buildReport, clean } from "./util.mjs";

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
