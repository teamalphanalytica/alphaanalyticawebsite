// Read-only queries behind the admin command centre. Everything here is admin-only and never writes.

import { connectionStates, clientHealth, buildInsights, sourceBucket, likePattern, clean, toInt } from "./util.mjs";

const londonToday = () => new Date().toLocaleDateString("en-CA", { timeZone: "Europe/London" });

/** Lead counts by channel and campaign, with ad spend alongside so each channel gets a cost per enquiry. */
export async function channelFigures(db) {
  const rows = await db.sql`
    SELECT client_id, type, source, campaign, status, (gclid IS NOT NULL) AS has_gclid, (fbc IS NOT NULL OR fbp IS NOT NULL) AS has_fb, COUNT(*)::int AS n
    FROM leads WHERE received_at > NOW() - INTERVAL '30 days' AND source IS DISTINCT FROM 'Test enquiry'
    GROUP BY 1, 2, 3, 4, 5, 6, 7`;
  const spend = await db.sql`
    SELECT platform, COALESCE(SUM(spend_pence), 0)::int AS spend_pence, COALESCE(SUM(clicks), 0)::int AS clicks, COALESCE(SUM(impressions), 0)::int AS impressions
    FROM ad_stats WHERE day >= CURRENT_DATE - 30 GROUP BY platform`;
  const spendBy = Object.fromEntries(spend.map((s) => [s.platform, s]));

  const channels = new Map();
  const campaigns = new Map();
  const bump = (map, key, r) => {
    const o = map.get(key) || { name: key, enquiries: 0, spam: 0, qualified: 0, customers: 0, calls: 0 };
    if (r.status === "spam") o.spam += r.n;
    else {
      o.enquiries += r.n;
      if (r.type === "call") o.calls += r.n;
      if (r.status === "qualified" || r.status === "customer") o.qualified += r.n;
      if (r.status === "customer") o.customers += r.n;
    }
    map.set(key, o);
  };
  for (const r of rows) {
    bump(channels, sourceBucket({ source: r.source, type: r.type, has_gclid: r.has_gclid, has_fb: r.has_fb }), r);
    if (r.campaign) bump(campaigns, r.campaign, r);
  }
  const platformFor = { "Google ads": "google", "Facebook / Instagram": "meta" };
  const out = [...channels.values()].map((c) => {
    const s = spendBy[platformFor[c.name]];
    const spend_pence = s ? s.spend_pence : null;
    return {
      ...c, spend_pence, clicks: s ? s.clicks : null,
      cost_per_enquiry_pence: spend_pence && c.enquiries ? Math.round(spend_pence / c.enquiries) : null,
      spam_pct: c.enquiries + c.spam ? Math.round((c.spam / (c.enquiries + c.spam)) * 100) : 0,
    };
  }).sort((a, b) => b.enquiries - a.enquiries);
  return { channels: out, campaigns: [...campaigns.values()].sort((a, b) => b.enquiries - a.enquiries).slice(0, 15), spendBy };
}

export async function overviewData(db) {
  const today = londonToday();
  const clients = await db.sql`
    SELECT c.id, c.name, c.sector, c.created_at, c.google_customer_id, c.meta_ad_account_id, c.google_last_push, c.meta_last_sync, c.meta_last_error,
      c.price_per_enquiry_pence AS price, c.payment_ready,
      COUNT(l.id) FILTER (WHERE l.status <> 'spam' AND l.received_at > NOW() - INTERVAL '7 days')::int AS enq7,
      COUNT(l.id) FILTER (WHERE l.status <> 'spam' AND l.received_at <= NOW() - INTERVAL '7 days' AND l.received_at > NOW() - INTERVAL '14 days')::int AS enq_prev7,
      COUNT(l.id) FILTER (WHERE l.status <> 'spam' AND l.received_at > NOW() - INTERVAL '30 days')::int AS enq30,
      COUNT(l.id) FILTER (WHERE l.status = 'customer' AND l.received_at > NOW() - INTERVAL '30 days')::int AS customers30,
      COUNT(l.id) FILTER (WHERE l.status <> 'spam' AND l.received_at >= date_trunc('month', NOW()))::int AS month_enq,
      MAX(l.received_at) FILTER (WHERE l.status <> 'spam') AS last_enquiry_at
    FROM clients c
    LEFT JOIN leads l ON l.client_id = c.id AND l.source IS DISTINCT FROM 'Test enquiry' AND l.received_at > NOW() - INTERVAL '45 days'
    GROUP BY c.id ORDER BY c.name`;
  const calls = await db.sql`
    SELECT client_id, COUNT(*)::int AS calls30, COUNT(*) FILTER (WHERE status = 'completed')::int AS answered30
    FROM calls WHERE started_at > NOW() - INTERVAL '30 days' GROUP BY client_id`;
  const ads = await db.sql`SELECT client_id, COALESCE(SUM(spend_pence), 0)::int AS spend30 FROM ad_stats WHERE day >= CURRENT_DATE - 30 GROUP BY client_id`;
  const steps = await db.sql`SELECT client_id, COUNT(*) FILTER (WHERE status = 'done')::int AS done, COUNT(*)::int AS total FROM build_steps GROUP BY client_id`;
  const daily = await db.sql`
    SELECT to_char((received_at AT TIME ZONE 'Europe/London')::date, 'YYYY-MM-DD') AS day, type, COUNT(*)::int AS n
    FROM leads WHERE status <> 'spam' AND source IS DISTINCT FROM 'Test enquiry' AND received_at > NOW() - INTERVAL '31 days' GROUP BY 1, 2`;
  const [callTotals] = await db.sql`
    SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE status = 'completed')::int AS answered,
           COUNT(*) FILTER (WHERE summary->>'genuine' = 'false')::int AS not_genuine,
           COUNT(*) FILTER (WHERE summary IS NOT NULL)::int AS reviewed
    FROM calls WHERE started_at > NOW() - INTERVAL '30 days'`;
  const [open] = await db.sql`SELECT COUNT(*)::int AS disputes FROM leads WHERE dispute_state = 'open'`;
  const { channels } = await channelFigures(db);

  const by = (rows) => Object.fromEntries(rows.map((r) => [r.client_id, r]));
  const callBy = by(calls), adBy = by(ads), stepBy = by(steps);
  const nowMs = Date.now();

  const out = clients.map((c) => {
    const k = callBy[c.id] || { calls30: 0, answered30: 0 };
    const spend30 = (adBy[c.id] || {}).spend30 || 0;
    const st = stepBy[c.id] || { done: 0, total: 0 };
    const conn = connectionStates(c, today);
    const row = {
      id: c.id, name: c.name, sector: c.sector, price: c.price, payment_ready: c.payment_ready,
      enq7: c.enq7, enqPrev7: c.enq_prev7, enq30: c.enq30, customers30: c.customers30, month_enq: c.month_enq,
      calls30: k.calls30, answered30: k.answered30, spend30, last_enquiry_at: c.last_enquiry_at,
      cpe: spend30 && c.enq30 ? Math.round(spend30 / c.enq30) : null,
      setupDone: st.done, setupTotal: st.total, connections: conn,
      ageDays: Math.floor((nowMs - new Date(c.created_at).getTime()) / 86400000),
      googleState: conn.google.state, metaState: conn.meta.state,
    };
    row.health = clientHealth(row);
    return row;
  });

  // fill every day of the last 30 so quiet days show as gaps, not missing bars
  const series = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(Date.parse(`${today}T12:00:00Z`) - i * 86400000).toISOString().slice(0, 10);
    series.push({ day: d, forms: 0, calls: 0 });
  }
  for (const r of daily) { const s = series.find((x) => x.day === r.day); if (s) s[r.type === "call" ? "calls" : "forms"] = r.n; }

  const sum = (f) => out.reduce((t, c) => t + f(c), 0);
  const totals = {
    clients: out.length,
    enquiries_today: (series[series.length - 1].forms + series[series.length - 1].calls),
    enq7: sum((c) => c.enq7), enqPrev7: sum((c) => c.enqPrev7), enq30: sum((c) => c.enq30), customers30: sum((c) => c.customers30),
    spend30: sum((c) => c.spend30),
    calls30: callTotals.total, answered30: callTotals.answered,
    month_revenue_pence: sum((c) => (c.price ? c.price * c.month_enq : 0)),
    open_disputes: open.disputes,
  };
  totals.cpe = totals.spend30 && totals.enq30 ? Math.round(totals.spend30 / totals.enq30) : null;

  const platforms = channels.filter((c) => c.spend_pence).map((c) => ({ name: c.name.replace(" ads", ""), enquiries: c.enquiries, spend_pence: c.spend_pence }));
  const insights = buildInsights({ clients: out, platforms, calls: callTotals });
  const rank = { bad: 0, watch: 1, new: 2, good: 3 };
  out.sort((a, b) => rank[a.health.level] - rank[b.health.level] || a.name.localeCompare(b.name));
  return { totals, series, clients: out, insights, callTotals };
}

export async function performanceData(db) {
  const { channels, campaigns } = await channelFigures(db);
  const byClient = await db.sql`
    SELECT c.id, c.name,
      COUNT(l.id) FILTER (WHERE l.status <> 'spam')::int AS enquiries,
      COUNT(l.id) FILTER (WHERE l.status = 'spam')::int AS spam,
      COUNT(l.id) FILTER (WHERE l.status IN ('qualified', 'customer'))::int AS qualified,
      COUNT(l.id) FILTER (WHERE l.status = 'customer')::int AS customers,
      (SELECT COALESCE(SUM(spend_pence), 0)::int FROM ad_stats a WHERE a.client_id = c.id AND a.day >= CURRENT_DATE - 30) AS spend_pence
    FROM clients c LEFT JOIN leads l ON l.client_id = c.id AND l.received_at > NOW() - INTERVAL '30 days' AND l.source IS DISTINCT FROM 'Test enquiry'
    GROUP BY c.id ORDER BY enquiries DESC, c.name`;
  const clients = byClient.map((c) => ({
    ...c,
    cost_per_enquiry_pence: c.spend_pence && c.enquiries ? Math.round(c.spend_pence / c.enquiries) : null,
    spam_pct: c.enquiries + c.spam ? Math.round((c.spam / (c.enquiries + c.spam)) * 100) : 0,
    customer_pct: c.enquiries ? Math.round((c.customers / c.enquiries) * 100) : 0,
  }));
  const outcomes = await db.sql`
    SELECT summary->>'outcome' AS outcome, COUNT(*)::int AS n FROM calls
    WHERE summary IS NOT NULL AND started_at > NOW() - INTERVAL '30 days' GROUP BY 1 ORDER BY n DESC`;
  return { channels, campaigns, clients, call_outcomes: outcomes };
}

/** The live feed of enquiries across every client, with filters and "load more". */
export async function feedData(db, q) {
  const client = toInt(q.client, { min: 1 });
  const type = ["form", "call"].includes(q.type) ? q.type : null;
  const status = ["new", "qualified", "customer", "spam"].includes(q.status) ? q.status : null;
  const source = likePattern(q.source);
  const search = likePattern(q.q);
  const before = toInt(q.before, { min: 1 });
  const limit = Math.min(toInt(q.limit, { min: 1, max: 100 }) ?? 40, 100);
  const rows = await db.sql`
    SELECT l.id, l.received_at, l.type, l.name, l.email, l.phone, l.message, l.source, l.campaign, l.status, l.value_pence,
           l.dispute_state, l.page_url, (l.gclid IS NOT NULL) AS has_gclid, (l.fbc IS NOT NULL OR l.fbp IS NOT NULL) AS has_fb,
           c.id AS client_id, c.name AS client,
           k.id AS call_id, k.duration_seconds, (k.transcript IS NOT NULL) AS has_transcript, k.summary->>'summary' AS call_summary
    FROM leads l JOIN clients c ON c.id = l.client_id LEFT JOIN calls k ON k.call_sid = l.call_sid
    WHERE (${client}::int IS NULL OR l.client_id = ${client}::int)
      AND (${type}::text IS NULL OR l.type = ${type}::text)
      AND (${status}::text IS NULL OR l.status = ${status}::text)
      AND (${source}::text IS NULL OR l.source ILIKE ${source}::text)
      AND (${search}::text IS NULL OR l.name ILIKE ${search}::text OR l.email ILIKE ${search}::text OR l.phone ILIKE ${search}::text OR l.message ILIKE ${search}::text)
      AND (${before}::int IS NULL OR l.id < ${before}::int)
    ORDER BY l.id DESC LIMIT ${limit + 1}`;
  const more = rows.length > limit;
  return { leads: rows.slice(0, limit), more };
}

export async function callsData(db, q) {
  const client = toInt(q.client, { min: 1 });
  const status = clean(q.status, 20);
  const outcome = clean(q.outcome, 30);
  const search = likePattern(q.q);
  const before = toInt(q.before, { min: 1 });
  const limit = Math.min(toInt(q.limit, { min: 1, max: 100 }) ?? 40, 100);
  const rows = await db.sql`
    SELECT k.id, k.started_at, k.from_number, k.label, k.status, k.duration_seconds, k.transcript_status,
           (k.recording_sid IS NOT NULL) AS has_recording, (k.transcript IS NOT NULL) AS has_transcript, (k.media_deleted_at IS NOT NULL) AS media_deleted,
           k.summary, c.id AS client_id, c.name AS client,
           (SELECT l.id FROM leads l WHERE l.call_sid = k.call_sid) AS lead_id
    FROM calls k JOIN clients c ON c.id = k.client_id
    WHERE (${client}::int IS NULL OR k.client_id = ${client}::int)
      AND (${status}::text IS NULL OR k.status = ${status}::text)
      AND (${outcome}::text IS NULL OR k.summary->>'outcome' = ${outcome}::text)
      AND (${search}::text IS NULL OR k.from_number ILIKE ${search}::text OR k.summary->>'summary' ILIKE ${search}::text OR k.transcript::text ILIKE ${search}::text)
      AND (${before}::int IS NULL OR k.id < ${before}::int)
    ORDER BY k.id DESC LIMIT ${limit + 1}`;
  return { calls: rows.slice(0, limit), more: rows.length > limit };
}

export async function callDetail(db, id) {
  const [row] = await db.sql`
    SELECT k.id, k.started_at, k.from_number, k.label, k.status, k.duration_seconds, k.recording_sid IS NOT NULL AS has_recording,
           k.recording_seconds, k.transcript_status, k.transcript_error, k.transcript, k.summary, k.media_deleted_at,
           c.id AS client_id, c.name AS client
    FROM calls k JOIN clients c ON c.id = k.client_id WHERE k.id = ${id}`;
  return row || null;
}
