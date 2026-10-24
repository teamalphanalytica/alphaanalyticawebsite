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
  LEAD_STATUSES, STEP_STATUSES, PLATFORMS, DEFAULT_STEPS,
  clean, toInt, isEmail, isDay, safeUrl, slugify, parseLead, readBody, sameOrigin, parseAdminEmails,
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
    SELECT id, name, sector, website_url, preview_url FROM clients WHERE id = ${clientId}`;
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

  return json({ client, steps, leads, stats, reports });
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
      SELECT id, name, sector, website_url, preview_url, ingest_key FROM clients WHERE id = ${clientId}`;
    if (!client) return fail(404, "Business not found.");
    const users = await db.sql`SELECT email FROM client_users WHERE client_id = ${clientId} ORDER BY email`;
    return json({ client, users: users.map((u) => u.email) });
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
