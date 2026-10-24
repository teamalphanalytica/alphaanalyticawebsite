// Alpha Analytica portal API. One function, routed by path under /api/*.
//
// Security model:
//  - Every request except POST /api/ingest needs a logged-in Netlify Identity user.
//  - A client user can only ever see rows for the client their email is linked to.
//    The client id is always looked up on the server, never taken from the request.
//  - Admins are the emails listed in the ADMIN_EMAILS environment variable.
//  - Every write from a browser must come from this site's own origin (CSRF guard).
//  - All SQL goes through parameterised template literals.

import { randomBytes } from "node:crypto";
import { getDatabase } from "@netlify/database";
import { getUser } from "@netlify/identity";
import {
  LEAD_STATUSES, STEP_STATUSES, PLATFORMS, DEFAULT_STEPS, HANGUP_TWIML,
  clean, toInt, isEmail, isE164, isDay, safeUrl, slugify, parseLead, readBody, sameOrigin, parseAdminEmails,
  safeEqual, validTwilioSignature, dialTwiml, sayHangupTwiml, countsAsEnquiry, parseAdRows,
} from "../lib/util.mjs";

export const config = { path: "/api/*" };

const json = (data, status = 200) => Response.json(data, { status, headers: { "cache-control": "no-store" } });
const fail = (status, message) => json({ error: message }, status);

export default async (req) => {
  try {
    const url = new URL(req.url);
    const parts = url.pathname.replace(/^\/api\/?/, "").split("/").filter(Boolean);
    const method = req.method;
    const db = getDatabase();

    // Public, key-protected endpoint used by form webhooks
    if (parts[0] === "ingest" && parts.length === 1) {
      if (method !== "POST") return fail(405, "Use POST.");
      return await ingest(req, url, db);
    }

    // Ad results pushed in by a Google Ads script, a Meta connector, etc. (shared secret)
    if (parts[0] === "ingest-ads" && parts.length === 1) {
      if (method !== "POST") return fail(405, "Use POST.");
      return await ingestAds(req, db);
    }

    // Twilio call webhooks (signed by Twilio, so no login)
    if (parts[0] === "twilio" && parts.length === 2 && method === "POST") {
      if (parts[1] === "voice") return await twilioVoice(req, db);
      if (parts[1] === "status") return await twilioStatus(req, db);
    }

    const me = await whoami(db);
    if (!me) return fail(401, "Please log in.");

    if (method !== "GET" && !sameOrigin(req)) return fail(403, "Request blocked.");

    if (parts[0] === "me" && method === "GET") return json(me);

    if (parts[0] === "portal" && method === "GET") return await portal(db, me, url);

    if (parts[0] === "leads" && parts.length === 2 && method === "PATCH") {
      return await updateLead(req, db, me, toInt(parts[1], { min: 1 }));
    }

    if (parts[0] === "admin") {
      if (!me.isAdmin) return fail(403, "Admins only.");
      return await admin(req, db, parts.slice(1), method);
    }

    return fail(404, "Not found.");
  } catch (e) {
    console.error("api error", e);
    return fail(500, "Something went wrong. Please try again.");
  }
};

/* ---------- who is calling ---------- */

async function whoami(db) {
  const user = await getUser();
  if (!user || !user.email) return null;
  const email = String(user.email).toLowerCase();
  const isAdmin = parseAdminEmails(Netlify.env.get("ADMIN_EMAILS")).includes(email);
  const rows = await db.sql`
    SELECT c.id, c.name FROM clients c
    JOIN client_users u ON u.client_id = c.id
    WHERE u.email = ${email}`;
  return { email, isAdmin, client: rows[0] || null };
}

/* ---------- client portal data ---------- */

async function portal(db, me, url) {
  let clientId = me.client ? me.client.id : null;
  // Admins can look at any client's portal ("view as")
  if (me.isAdmin && url.searchParams.get("client")) {
    clientId = toInt(url.searchParams.get("client"), { min: 1 });
  }
  if (!clientId) return fail(404, "No business is linked to this login yet.");

  const [client] = await db.sql`
    SELECT id, name, sector, website_url, preview_url, call_min_seconds FROM clients WHERE id = ${clientId}`;
  if (!client) return fail(404, "Business not found.");

  const steps = await db.sql`
    SELECT id, position, title, detail, status, updated_at
    FROM build_steps WHERE client_id = ${clientId} ORDER BY position`;
  const leads = await db.sql`
    SELECT id, received_at, type, name, email, phone, message, source, campaign, status, value_pence
    FROM leads WHERE client_id = ${clientId} ORDER BY received_at DESC LIMIT 200`;
  const stats = await db.sql`
    SELECT day, platform, spend_pence, impressions, clicks, enquiries
    FROM ad_stats WHERE client_id = ${clientId} AND day >= CURRENT_DATE - 120
    ORDER BY day DESC, platform`;
  const reports = await db.sql`
    SELECT id, week_start, title, body, created_at
    FROM reports WHERE client_id = ${clientId} ORDER BY week_start DESC LIMIT 20`;

  const numbers = await db.sql`
    SELECT id, number, forward_to, label FROM tracking_numbers WHERE client_id = ${clientId} ORDER BY id`;
  const calls = await db.sql`
    SELECT c.id, c.started_at, c.from_number, c.label, c.status, c.duration_seconds,
           (l.id IS NOT NULL) AS counted
    FROM calls c LEFT JOIN leads l ON l.call_sid = c.call_sid
    WHERE c.client_id = ${clientId} ORDER BY c.started_at DESC LIMIT 200`;

  return json({ client, steps, leads, stats, reports, numbers, calls });
}

async function updateLead(req, db, me, leadId) {
  if (!leadId) return fail(400, "Bad lead id.");
  const parsed = await readBody(req);
  if (!parsed.value) return fail(400, "Bad request.");
  const status = clean(parsed.value.status, 20);
  if (!LEAD_STATUSES.includes(status)) return fail(400, "Unknown status.");
  const value = toInt(parsed.value.value_pence);

  const [lead] = await db.sql`SELECT id, client_id FROM leads WHERE id = ${leadId}`;
  if (!lead) return fail(404, "Lead not found.");
  const allowed = me.isAdmin || (me.client && me.client.id === lead.client_id);
  if (!allowed) return fail(404, "Lead not found."); // same answer as missing, so ids can't be probed

  await db.sql`
    UPDATE leads SET status = ${status}, value_pence = COALESCE(${value}, value_pence)
    WHERE id = ${leadId}`;
  return json({ ok: true });
}

/* ---------- enquiries arriving from client sites ---------- */

async function ingest(req, url, db) {
  const key = clean(req.headers.get("x-ingest-key") || url.searchParams.get("key"), 200);
  if (!key) return fail(401, "Missing key.");
  const [client] = await db.sql`SELECT id FROM clients WHERE ingest_key = ${key}`;
  if (!client) return fail(401, "Unknown key.");

  const parsed = await readBody(req);
  if (parsed.tooLarge) return fail(413, "Too large.");
  if (!parsed.value) return fail(400, "Bad request.");

  const lead = parseLead(parsed.value);
  if (!lead) return fail(400, "Nothing to save.");
  if (lead.spam) return json({ ok: true }); // pretend success so bots learn nothing

  await db.sql`
    INSERT INTO leads (client_id, type, name, email, phone, message, source, campaign)
    VALUES (${client.id}, 'form', ${lead.name}, ${lead.email}, ${lead.phone}, ${lead.message}, ${lead.source}, ${lead.campaign})`;
  return json({ ok: true }, 201);
}

/* ---------- admin ---------- */

async function admin(req, db, p, method) {
  // GET /api/admin/clients
  if (p[0] === "clients" && p.length === 1 && method === "GET") {
    const rows = await db.sql`
      SELECT c.id, c.name, c.sector, c.website_url,
        (SELECT COUNT(*)::int FROM leads l WHERE l.client_id = c.id AND l.received_at > NOW() - INTERVAL '30 days' AND l.status <> 'spam') AS leads_30d,
        (SELECT COUNT(*)::int FROM build_steps s WHERE s.client_id = c.id AND s.status = 'done') AS steps_done,
        (SELECT COUNT(*)::int FROM build_steps s WHERE s.client_id = c.id) AS steps_total
      FROM clients c ORDER BY c.created_at DESC`;
    return json({ clients: rows });
  }

  // POST /api/admin/clients
  if (p[0] === "clients" && p.length === 1 && method === "POST") {
    const { value } = await readBody(req);
    const name = clean(value?.name, 120);
    if (!name) return fail(400, "Business name is required.");
    const sector = clean(value?.sector, 80);
    const website = value?.website_url ? safeUrl(value.website_url) : null;
    const preview = value?.preview_url ? safeUrl(value.preview_url) : null;
    if ((value?.website_url && !website) || (value?.preview_url && !preview)) return fail(400, "URLs must start with http:// or https://");

    const slug = `${slugify(name)}-${randomBytes(2).toString("hex")}`;
    const ingestKey = randomBytes(24).toString("hex");
    const [row] = await db.sql`
      INSERT INTO clients (name, slug, sector, website_url, preview_url, ingest_key)
      VALUES (${name}, ${slug}, ${sector}, ${website}, ${preview}, ${ingestKey})
      RETURNING id`;
    for (let i = 0; i < DEFAULT_STEPS.length; i++) {
      const [title, detail] = DEFAULT_STEPS[i];
      await db.sql`INSERT INTO build_steps (client_id, position, title, detail) VALUES (${row.id}, ${i + 1}, ${title}, ${detail})`;
    }
    return json({ id: row.id }, 201);
  }

  const clientId = p[0] === "clients" ? toInt(p[1], { min: 1 }) : null;

  // GET /api/admin/clients/:id
  if (clientId && p.length === 2 && method === "GET") {
    const [client] = await db.sql`
      SELECT id, name, sector, website_url, preview_url, ingest_key,
             google_customer_id, meta_ad_account_id, call_min_seconds
      FROM clients WHERE id = ${clientId}`;
    if (!client) return fail(404, "Business not found.");
    const users = await db.sql`SELECT email FROM client_users WHERE client_id = ${clientId} ORDER BY email`;
    const numbers = await db.sql`
      SELECT id, number, forward_to, label FROM tracking_numbers WHERE client_id = ${clientId} ORDER BY id`;
    return json({ client, users: users.map((u) => u.email), numbers });
  }

  // PATCH /api/admin/clients/:id/accounts  (ad account ids and the call-length rule)
  if (clientId && p[2] === "accounts" && p.length === 3 && method === "PATCH") {
    const { value } = await readBody(req);
    const google = clean(value?.google_customer_id, 30)?.replace(/\D/g, "") || null;
    const meta = clean(value?.meta_ad_account_id, 30)?.replace(/\D/g, "") || null;
    const minSeconds = toInt(value?.call_min_seconds, { min: 0, max: 3600 });
    if (minSeconds === null) return fail(400, "Call length must be a whole number of seconds.");
    try {
      await db.sql`
        UPDATE clients SET google_customer_id = ${google}, meta_ad_account_id = ${meta}, call_min_seconds = ${minSeconds}
        WHERE id = ${clientId}`;
    } catch {
      return fail(409, "Another client already uses one of those account ids.");
    }
    return json({ ok: true });
  }

  // POST /api/admin/clients/:id/numbers  (a tracking number and where it forwards to)
  if (clientId && p[2] === "numbers" && p.length === 3 && method === "POST") {
    const { value } = await readBody(req);
    const number = clean(value?.number, 20)?.replace(/[\s()-]/g, "");
    const forwardTo = clean(value?.forward_to, 20)?.replace(/[\s()-]/g, "");
    const label = clean(value?.label, 60);
    if (!isE164(number) || !isE164(forwardTo)) return fail(400, "Use international format, like +441612345678.");
    if (!label) return fail(400, "Say where this number is used, like Google ads.");
    if (number === forwardTo) return fail(400, "The tracking number and the forwarding number must be different.");
    try {
      await db.sql`
        INSERT INTO tracking_numbers (client_id, number, forward_to, label)
        VALUES (${clientId}, ${number}, ${forwardTo}, ${label})`;
    } catch {
      return fail(409, "That tracking number is already in use.");
    }
    return json({ ok: true }, 201);
  }

  // DELETE /api/admin/numbers/:id
  if (p[0] === "numbers" && p.length === 2 && method === "DELETE") {
    const numberId = toInt(p[1], { min: 1 });
    if (!numberId) return fail(400, "Bad id.");
    await db.sql`DELETE FROM tracking_numbers WHERE id = ${numberId}`;
    return json({ ok: true });
  }

  // PATCH /api/admin/clients/:id  (website and preview links)
  if (clientId && p.length === 2 && method === "PATCH") {
    const { value } = await readBody(req);
    const website = value?.website_url ? safeUrl(value.website_url) : null;
    const preview = value?.preview_url ? safeUrl(value.preview_url) : null;
    if ((value?.website_url && !website) || (value?.preview_url && !preview)) return fail(400, "URLs must start with http:// or https://");
    await db.sql`UPDATE clients SET website_url = ${website}, preview_url = ${preview} WHERE id = ${clientId}`;
    return json({ ok: true });
  }

  // POST /api/admin/clients/:id/users  (link a login email to this client)
  if (clientId && p[2] === "users" && p.length === 3 && method === "POST") {
    const { value } = await readBody(req);
    const email = clean(value?.email, 254)?.toLowerCase();
    if (!isEmail(email)) return fail(400, "Enter a valid email.");
    await db.sql`
      INSERT INTO client_users (email, client_id) VALUES (${email}, ${clientId})
      ON CONFLICT (email) DO UPDATE SET client_id = EXCLUDED.client_id`;
    return json({ ok: true });
  }

  // PUT /api/admin/clients/:id/stats  (one day, one platform)
  if (clientId && p[2] === "stats" && p.length === 3 && method === "PUT") {
    const { value } = await readBody(req);
    const day = clean(value?.day, 10);
    const platform = clean(value?.platform, 10);
    const spend = toInt(value?.spend_pence);
    const impressions = toInt(value?.impressions) ?? 0;
    const clicks = toInt(value?.clicks) ?? 0;
    const enquiries = toInt(value?.enquiries) ?? 0;
    if (!isDay(day) || !PLATFORMS.includes(platform) || spend === null) return fail(400, "Check the date, platform and spend.");
    await db.sql`
      INSERT INTO ad_stats (client_id, day, platform, spend_pence, impressions, clicks, enquiries)
      VALUES (${clientId}, ${day}, ${platform}, ${spend}, ${impressions}, ${clicks}, ${enquiries})
      ON CONFLICT (client_id, day, platform) DO UPDATE SET
        spend_pence = EXCLUDED.spend_pence, impressions = EXCLUDED.impressions,
        clicks = EXCLUDED.clicks, enquiries = EXCLUDED.enquiries`;
    return json({ ok: true });
  }

  // POST /api/admin/clients/:id/reports
  if (clientId && p[2] === "reports" && p.length === 3 && method === "POST") {
    const { value } = await readBody(req, 60_000);
    const weekStart = clean(value?.week_start, 10);
    const title = clean(value?.title, 160);
    const body = clean(value?.body, 20_000);
    if (!isDay(weekStart) || !title || !body) return fail(400, "A date, title and report text are required.");
    await db.sql`INSERT INTO reports (client_id, week_start, title, body) VALUES (${clientId}, ${weekStart}, ${title}, ${body})`;
    return json({ ok: true }, 201);
  }

  // PATCH /api/admin/steps/:id
  if (p[0] === "steps" && p.length === 2 && method === "PATCH") {
    const stepId = toInt(p[1], { min: 1 });
    const { value } = await readBody(req);
    const status = clean(value?.status, 10);
    if (!stepId || !STEP_STATUSES.includes(status)) return fail(400, "Unknown status.");
    await db.sql`UPDATE build_steps SET status = ${status}, updated_at = NOW() WHERE id = ${stepId}`;
    return json({ ok: true });
  }

  return fail(404, "Not found.");
}

/* ---------- ad results pushed in from outside ---------- */

async function ingestAds(req, db) {
  const expected = Netlify.env.get("ADS_PUSH_KEY");
  const key = clean(req.headers.get("x-push-key"), 200);
  if (!expected || !key || !safeEqual(key, expected)) return fail(401, "Unauthorised.");

  const parsed = await readBody(req, 200_000);
  if (parsed.tooLarge) return fail(413, "Too large.");
  if (!parsed.value || !Array.isArray(parsed.value.rows)) return fail(400, "Send { rows: [...] }.");

  const { rows, errors } = parseAdRows(parsed.value.rows.slice(0, 500));
  let saved = 0;
  let unknown = 0;
  for (const r of rows) {
    const found = r.platform === "google"
      ? await db.sql`SELECT id FROM clients WHERE google_customer_id = ${r.ident}`
      : await db.sql`SELECT id FROM clients WHERE meta_ad_account_id = ${r.ident}`;
    if (!found[0]) { unknown++; continue; }
    await db.sql`
      INSERT INTO ad_stats (client_id, day, platform, spend_pence, impressions, clicks, enquiries)
      VALUES (${found[0].id}, ${r.day}, ${r.platform}, ${r.spend_pence}, ${r.impressions}, ${r.clicks}, ${r.enquiries})
      ON CONFLICT (client_id, day, platform) DO UPDATE SET
        spend_pence = EXCLUDED.spend_pence, impressions = EXCLUDED.impressions,
        clicks = EXCLUDED.clicks, enquiries = EXCLUDED.enquiries`;
    saved++;
  }
  return json({ saved, unknown_account: unknown, rejected: errors.length });
}

/* ---------- phone calls via Twilio ---------- */

const XML = { "content-type": "text/xml; charset=utf-8", "cache-control": "no-store" };
const twiml = (xml) => new Response(xml, { status: 200, headers: XML });

// Last known number settings, so a brief database hiccup doesn't drop a customer's call
const numberCache = new Map();

/** Read a Twilio webhook and check its signature. Returns the fields, or null if it isn't genuinely from Twilio. */
async function twilioParams(req) {
  const token = Netlify.env.get("TWILIO_AUTH_TOKEN");
  const text = await req.text();
  if (text.length > 20_000) return null;
  const params = Object.fromEntries(new URLSearchParams(text));
  const u = new URL(req.url);
  const base = (Netlify.env.get("PUBLIC_BASE_URL") || u.origin).replace(/\/$/, "");
  const ok = validTwilioSignature(`${base}${u.pathname}${u.search}`, params, token, req.headers.get("x-twilio-signature"));
  return ok ? params : null;
}

function publicBase(req) {
  return (Netlify.env.get("PUBLIC_BASE_URL") || new URL(req.url).origin).replace(/\/$/, "");
}

// Someone dialled a tracking number: forward the call, and log it
async function twilioVoice(req, db) {
  const params = await twilioParams(req);
  if (!params) return new Response("Forbidden", { status: 403 });
  const to = params.To;
  const sid = params.CallSid;

  let row = null;
  try {
    const found = await db.sql`
      SELECT id, client_id, forward_to, label FROM tracking_numbers WHERE number = ${to}`;
    row = found[0] || null;
    if (row) numberCache.set(to, row);
  } catch (e) {
    console.error("number lookup failed", e);
    row = numberCache.get(to) || null;
  }
  if (!row) return twiml(sayHangupTwiml("Sorry, this number is not connected right now. Please try again later."));

  // Logging must never stop the call from connecting
  try {
    await db.sql`
      INSERT INTO calls (client_id, tracking_number_id, call_sid, from_number, label)
      VALUES (${row.client_id}, ${row.id}, ${sid}, ${clean(params.From, 30)}, ${row.label})
      ON CONFLICT (call_sid) DO NOTHING`;
  } catch (e) {
    console.error("call log failed", e);
  }

  return twiml(dialTwiml({
    forwardTo: row.forward_to,
    callerId: to,
    actionUrl: `${publicBase(req)}/api/twilio/status`,
    timeout: 25,
  }));
}

// The forwarded leg has finished: record how it went, and count it as an enquiry if it was long enough
async function twilioStatus(req, db) {
  const params = await twilioParams(req);
  if (!params) return new Response("Forbidden", { status: 403 });
  const sid = params.CallSid;
  const status = clean(params.DialCallStatus, 20) || "failed";
  const seconds = toInt(params.DialCallDuration) ?? 0;

  try {
    const updated = await db.sql`
      UPDATE calls SET status = ${status}, duration_seconds = ${seconds}
      WHERE call_sid = ${sid}
      RETURNING client_id, from_number, label`;
    const call = updated[0];
    if (call) {
      const [client] = await db.sql`SELECT call_min_seconds FROM clients WHERE id = ${call.client_id}`;
      if (client && countsAsEnquiry(status, seconds, client.call_min_seconds)) {
        await db.sql`
          INSERT INTO leads (client_id, type, phone, message, source, call_sid)
          VALUES (${call.client_id}, 'call', ${call.from_number}, ${`Phone call, ${seconds} seconds`}, ${call.label}, ${sid})
          ON CONFLICT (call_sid) DO NOTHING`;
      }
    }
  } catch (e) {
    console.error("call status failed", e);
  }

  return twiml(status === "completed" ? HANGUP_TWIML : sayHangupTwiml("Sorry, we could not reach anyone. Please try again shortly."));
}
