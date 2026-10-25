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
  safeEqual, normaliseUkPhone, monthRange, googleConversionValue, parseCallClick, pickCallClick, toCsv, googleConversionTime, connectionStates, cleanIntake, validateNewClient, launchChecklist, disputeAllowed, DISPUTE_REASONS, verifyStripeSignature, clientWelcomeMessage, findAlerts, validTwilioSignature, dialTwiml, sayHangupTwiml, countsAsEnquiry, parseAdRows,
} from "../lib/util.mjs";
import { stripeOn, billingMode, disputeDays, createPaymentSetup, runBilling, approveInvoice, discardInvoice, handleStripeEvent } from "../lib/billing.mjs";
import { sendEmail } from "../lib/email.mjs";
import { recordingOn, recordingNotice, retentionDays, handleRecordingCallback, startTranscript, summariseCall, fetchRecording } from "../lib/calls.mjs";
import { overviewData, performanceData, feedData, callsData, callDetail } from "../lib/admin-data.mjs";
import { findProspects, polishTemplates, addProspect, buildProposition, nicheFor, pickNiche, PROSPECT_STATUSES, NICHES } from "../lib/prospects.mjs";
import { buildProposalPdf } from "../lib/pdf.mjs";
import { syncMeta, draftWeeklyReports, attentionItems, sendAttentionEmail, notifyReportPublished, sendMetaConversions } from "../lib/jobs.mjs";

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

    // A visitor tapped a tracking number on a client website (public: sent by the browser, no secret)
    if (parts[0] === "call-click" && parts.length === 1) {
      if (method !== "POST") return fail(405, "Use POST.");
      return await callClick(req, db);
    }

    // Ad results pushed in by a Google Ads script, a Meta connector, etc. (shared secret)
    if (parts[0] === "ingest-ads" && parts.length === 1) {
      if (method !== "POST") return fail(405, "Use POST.");
      return await ingestAds(req, db);
    }

    // Google Ads script collects enquiries to upload as conversions, then confirms them (shared secret)
    if (parts[0] === "conversions" && parts[1] === "google" && parts.length === 2 && method === "GET") {
      return await googleConversionsExport(req, db);
    }
    if (parts[0] === "conversions" && parts[1] === "google" && parts[2] === "ack" && parts.length === 3 && method === "POST") {
      return await googleConversionsAck(req, db);
    }

    // Stripe tells us about payments (signed by Stripe, so no login)
    if (parts[0] === "stripe" && parts[1] === "webhook" && parts.length === 2) {
      if (method !== "POST") return fail(405, "Use POST.");
      return await stripeWebhook(req, db);
    }

    // Twilio call webhooks (signed by Twilio, so no login)
    if (parts[0] === "twilio" && parts.length === 2 && method === "POST") {
      if (parts[1] === "voice") return await twilioVoice(req, db);
      if (parts[1] === "status") return await twilioStatus(req, db);
      if (parts[1] === "recording") return await twilioRecording(req, db);
    }

    const me = await whoami(db);
    if (!me) return fail(401, "Please log in.");

    if (method !== "GET" && !sameOrigin(req)) return fail(403, "Request blocked.");

    if (parts[0] === "me" && method === "GET") return json(me);

    if (parts[0] === "portal" && method === "GET") return await portal(db, me, url);

    if (parts[0] === "portal" && parts[1] === "intake" && parts.length === 2 && method === "POST") {
      return await saveIntake(req, db, me);
    }
    if (parts[0] === "portal" && parts[1] === "accounts" && parts.length === 2 && method === "POST") {
      return await saveOwnAccounts(req, db, me);
    }
    if (parts[0] === "portal" && parts[1] === "phone" && parts.length === 2 && method === "POST") {
      return await setupPhone(req, db, me);
    }

    if (parts[0] === "portal" && parts[1] === "payment-setup" && parts.length === 2 && method === "POST") {
      return await paymentSetup(db, me);
    }
    if (parts[0] === "portal" && parts[1] === "leads" && parts[3] === "dispute" && parts.length === 4 && method === "POST") {
      return await disputeLead(req, db, me, toInt(parts[2], { min: 1 }));
    }

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
    SELECT id, name, sector, website_url, preview_url, call_min_seconds, intake,
           google_customer_id, meta_ad_account_id, google_last_push, meta_last_sync, meta_last_error
    FROM clients WHERE id = ${clientId}`;
  if (!client) return fail(404, "Business not found.");

  const steps = await db.sql`
    SELECT id, position, title, detail, status, updated_at
    FROM build_steps WHERE client_id = ${clientId} ORDER BY position`;
  const leads = await db.sql`
    SELECT id, received_at, type, name, email, phone, message, source, campaign, status, value_pence, dispute_state, dispute_reason,
           (gclid IS NOT NULL OR gbraid IS NOT NULL OR wbraid IS NOT NULL) AS has_gclid, (fbc IS NOT NULL OR fbp IS NOT NULL) AS has_fb
    FROM leads WHERE client_id = ${clientId} AND source IS DISTINCT FROM 'Test enquiry' ORDER BY received_at DESC LIMIT 200`;
  const stats = await db.sql`
    SELECT day, platform, spend_pence, impressions, clicks, enquiries
    FROM ad_stats WHERE client_id = ${clientId} AND day >= CURRENT_DATE - 120
    ORDER BY day DESC, platform`;
  const reports = await db.sql`
    SELECT id, week_start, title, body, created_at
    FROM reports WHERE client_id = ${clientId} AND published ORDER BY week_start DESC LIMIT 20`;

  const numbers = await db.sql`
    SELECT id, number, forward_to, label FROM tracking_numbers WHERE client_id = ${clientId} AND number LIKE '+%' ORDER BY id`;
  const calls = await db.sql`
    SELECT c.id, c.started_at, c.from_number, c.label, c.status, c.duration_seconds,
           (l.id IS NOT NULL) AS counted
    FROM calls c LEFT JOIN leads l ON l.call_sid = c.call_sid
    WHERE c.client_id = ${clientId} ORDER BY c.started_at DESC LIMIT 200`;

  const now = new Date();
  const days = disputeDays();
  for (const l of leads) l.can_dispute = disputeAllowed(l, now, days);
  const invoices = await db.sql`
    SELECT id, period, quantity, unit_pence, total_pence, status, hosted_url, paid_at
    FROM invoices WHERE client_id = ${clientId} AND status NOT IN ('skipped', 'creating', 'draft') ORDER BY period DESC LIMIT 24`;
  const [pay] = await db.sql`SELECT payment_ready FROM clients WHERE id = ${clientId}`;
  const billing = { stripeOn: stripeOn(), paymentReady: !!pay?.payment_ready, invoices, disputeDays: days, reasons: DISPUTE_REASONS };

  const connections = connectionStates(client, new Date().toISOString().slice(0, 10));
  const { google_last_push, meta_last_sync, meta_last_error, ...publicClient } = client;
  const agency = {
    google_manager_id: clean(Netlify.env.get("GOOGLE_MCC_ID"), 20),
    meta_business_id: clean(Netlify.env.get("META_BUSINESS_ID"), 30),
  };
  return json({ client: publicClient, steps, leads, stats, reports, numbers, calls, connections, agency, billing });
}

async function updateLead(req, db, me, leadId) {
  if (!leadId) return fail(400, "Bad lead id.");
  const parsed = await readBody(req);
  if (!parsed.value) return fail(400, "Bad request.");
  const status = clean(parsed.value.status, 20);
  if (!LEAD_STATUSES.includes(status)) return fail(400, "Unknown status.");
  // Spam changes what we bill, so a client raises a dispute and an admin decides
  if (status === "spam" && !me.isAdmin) return fail(403, "To say an enquiry wasn't genuine, use the Dispute option.");
  const value = toInt(parsed.value.value_pence);

  const [lead] = await db.sql`SELECT id, client_id FROM leads WHERE id = ${leadId}`;
  if (!lead) return fail(404, "Lead not found.");
  const allowed = me.isAdmin || (me.client && me.client.id === lead.client_id);
  if (!allowed) return fail(404, "Lead not found."); // same answer as missing, so ids can't be probed

  await db.sql`
    UPDATE leads SET status = ${status}, value_pence = COALESCE(${value}, value_pence),
      customer_at = CASE WHEN ${status} = 'customer' THEN COALESCE(customer_at, NOW()) ELSE customer_at END
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
    INSERT INTO leads (client_id, type, name, email, phone, message, source, campaign,
                       gclid, gbraid, wbraid, fbc, fbp, ip, user_agent, page_url)
    VALUES (${client.id}, 'form', ${lead.name}, ${lead.email}, ${lead.phone}, ${lead.message}, ${lead.source}, ${lead.campaign},
            ${lead.gclid}, ${lead.gbraid}, ${lead.wbraid}, ${lead.fbc}, ${lead.fbp}, ${lead.ip}, ${lead.user_agent}, ${lead.page_url})`;
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

  // POST /api/admin/clients  (the whole "add a client" form: everything is checked first, then created together)
  if (p[0] === "clients" && p.length === 1 && method === "POST") {
    const { value: body } = await readBody(req);
    const { errors, value: v } = validateNewClient(body);
    if (errors.length) return json({ error: errors[0].message, errors }, 400);

    // Check for clashes up front so we never create half a client
    const [emailTaken] = await db.sql`SELECT c.name FROM client_users u JOIN clients c ON c.id = u.client_id WHERE u.email = ${v.owner_email}`;
    if (emailTaken) return json({ error: `${v.owner_email} is already linked to ${emailTaken.name}.`, errors: [{ field: "owner_email", message: `${v.owner_email} is already linked to ${emailTaken.name}.` }] }, 409);
    for (const [col, field, label] of [["google_customer_id", "google_customer_id", "Google Ads"], ["meta_ad_account_id", "meta_ad_account_id", "Facebook"]]) {
      if (!v[field]) continue;
      const [dupe] = col === "google_customer_id"
        ? await db.sql`SELECT name FROM clients WHERE google_customer_id = ${v[field]}`
        : await db.sql`SELECT name FROM clients WHERE meta_ad_account_id = ${v[field]}`;
      if (dupe) return json({ error: `That ${label} account is already used by ${dupe.name}.`, errors: [{ field, message: `That ${label} account is already used by ${dupe.name}.` }] }, 409);
    }

    const slug = `${slugify(v.name)}-${randomBytes(2).toString("hex")}`;
    const ingestKey = randomBytes(24).toString("hex");
    let id = null;
    try {
      const [row] = await db.sql`
        INSERT INTO clients (name, slug, sector, website_url, ingest_key, price_per_enquiry_pence, google_customer_id, meta_ad_account_id, intake)
        VALUES (${v.name}, ${slug}, ${v.sector}, ${v.website_url}, ${ingestKey}, ${v.price_per_enquiry_pence}, ${v.google_customer_id}, ${v.meta_ad_account_id},
                ${JSON.stringify(v.owner_phone ? { contact_phone: v.owner_phone } : {})}::jsonb)
        RETURNING id`;
      id = row.id;
      for (let i = 0; i < DEFAULT_STEPS.length; i++) {
        const [title, detail] = DEFAULT_STEPS[i];
        await db.sql`INSERT INTO build_steps (client_id, position, title, detail) VALUES (${id}, ${i + 1}, ${title}, ${detail})`;
      }
      await db.sql`INSERT INTO client_users (email, client_id) VALUES (${v.owner_email}, ${id})`;
    } catch (e) {
      console.error("create client failed", e);
      if (id) await db.sql`DELETE FROM clients WHERE id = ${id}`; // cascades, so nothing half-built is left
      return fail(500, "Something went wrong and nothing was created. Please try again.");
    }

    // Tracking number: only if we have their phone and automatic buying is switched on. A failure here never blocks the client.
    let number = null;
    let numberNote = null;
    if (v.owner_phone) {
      if (selfServeReady()) {
        const r = await provisionNumber(req, db, { id, name: v.name }, v.owner_phone);
        if (r.ok) number = r.number; else numberNote = r.message;
      } else {
        numberNote = "Automatic numbers aren't switched on yet, so add their tracking number by hand.";
      }
    }
    return json({ id, number, numberNote }, 201);
  }

  const clientId = p[0] === "clients" ? toInt(p[1], { min: 1 }) : null;

  // GET /api/admin/clients/:id
  if (clientId && p.length === 2 && method === "GET") {
    const [client] = await db.sql`
      SELECT id, name, sector, website_url, preview_url, ingest_key,
             google_customer_id, meta_ad_account_id, call_min_seconds, intake, price_per_enquiry_pence, meta_pixel_id, google_conversion_name, google_customer_conversion_name, customer_value_pence,
             google_last_push, meta_last_sync, meta_last_error, payment_ready
      FROM clients WHERE id = ${clientId}`;
    if (!client) return fail(404, "Business not found.");
    const users = await db.sql`SELECT email FROM client_users WHERE client_id = ${clientId} ORDER BY email`;
    const numbers = await db.sql`
      SELECT id, number, forward_to, label FROM tracking_numbers WHERE client_id = ${clientId} AND number LIKE '+%' ORDER BY id`;
    const drafts = await db.sql`
      SELECT id, week_start, title, body FROM reports WHERE client_id = ${clientId} AND NOT published ORDER BY week_start DESC`;
    const connections = connectionStates(client, new Date().toISOString().slice(0, 10));
    const [conv] = await db.sql`
      SELECT COUNT(*) FILTER (WHERE google_sent_at IS NOT NULL)::int AS google_sent,
             COUNT(*) FILTER (WHERE meta_sent_at IS NOT NULL)::int AS meta_sent,
             COUNT(*) FILTER (WHERE meta_error IS NOT NULL AND meta_sent_at IS NULL)::int AS meta_failed,
             COUNT(*) FILTER (WHERE gclid IS NOT NULL)::int AS with_gclid,
             COUNT(*) FILTER (WHERE fbc IS NOT NULL OR fbp IS NOT NULL)::int AS with_fb,
             MAX(meta_error) FILTER (WHERE meta_sent_at IS NULL) AS last_meta_error
      FROM leads WHERE client_id = ${clientId} AND status <> 'spam' AND received_at > NOW() - INTERVAL '30 days'`;
    const [facts] = await db.sql`
      SELECT EXISTS (SELECT 1 FROM leads WHERE client_id = ${clientId} AND type = 'form' AND (status <> 'spam' OR source = 'Test enquiry')) AS has_lead`;
    const intakeKeys = Object.keys(client.intake || {}).filter((k) => k !== "contact_phone");
    const checklist = launchChecklist({
      hasLogin: users.length > 0,
      hasNumber: numbers.length > 0,
      selfServeReady: selfServeReady(),
      forwardPhone: client.intake?.contact_phone || null,
      websiteUrl: client.website_url,
      hasTestOrRealLead: !!facts?.has_lead,
      hasIntake: intakeKeys.length > 0,
      googleId: client.google_customer_id, googleLive: connections.google.state === "live",
      metaId: client.meta_ad_account_id, metaLive: connections.meta.state === "live", metaError: connections.meta.state === "error",
      metaPixel: client.meta_pixel_id,
      googleConversionSent: conv.google_sent > 0, metaConversionSent: conv.meta_sent > 0,
      priceSet: client.price_per_enquiry_pence != null,
      paymentReady: !!client.payment_ready, stripeOn: stripeOn(),
    });
    const welcome = clientWelcomeMessage({
      businessName: client.name,
      portalUrl: (Netlify.env.get("PUBLIC_BASE_URL") || new URL(req.url).origin).replace(/\/$/, ""),
      googleManagerId: clean(Netlify.env.get("GOOGLE_MCC_ID"), 20),
      metaBusinessId: clean(Netlify.env.get("META_BUSINESS_ID"), 30),
    });
    return json({ client, users: users.map((u) => u.email), numbers, drafts, connections, conversions: conv, checklist, welcome, selfServeReady: selfServeReady() });
  }

  // POST /api/admin/clients/:id/test-enquiry  (proves the website-to-portal link works; never counted or billed)
  if (clientId && p[2] === "test-enquiry" && p.length === 3 && method === "POST") {
    const [c] = await db.sql`SELECT id FROM clients WHERE id = ${clientId}`;
    if (!c) return fail(404, "Business not found.");
    await db.sql`
      INSERT INTO leads (client_id, type, name, email, message, source, status)
      VALUES (${clientId}, 'form', 'Test enquiry', 'test@example.com', 'This is a test enquiry from the admin checklist. It is marked as spam so it is never counted or billed.', 'Test enquiry', 'spam')`;
    return json({ ok: true }, 201);
  }

  // POST /api/admin/clients/:id/setup-number  (buy and route their tracking number now)
  if (clientId && p[2] === "setup-number" && p.length === 3 && method === "POST") {
    const { value } = await readBody(req);
    const [c] = await db.sql`SELECT id, name, intake FROM clients WHERE id = ${clientId}`;
    if (!c) return fail(404, "Business not found.");
    const phone = normaliseUkPhone(String(value?.phone ?? c.intake?.contact_phone ?? ""));
    if (!phone) return fail(400, "Enter the client's phone number first, like 07700 900123.");
    const r = await provisionNumber(req, db, c, phone);
    if (!r.ok) return fail(r.status, r.message);
    return json({ ok: true, number: r.number }, 201);
  }

  // PATCH /api/admin/clients/:id/accounts  (ad account ids and the call-length rule)
  if (clientId && p[2] === "accounts" && p.length === 3 && method === "PATCH") {
    const { value } = await readBody(req);
    const google = clean(value?.google_customer_id, 30)?.replace(/\D/g, "") || null;
    const meta = clean(value?.meta_ad_account_id, 30)?.replace(/\D/g, "") || null;
    const minSeconds = toInt(value?.call_min_seconds, { min: 0, max: 3600 });
    if (minSeconds === null) return fail(400, "Call length must be a whole number of seconds.");
    const pixel = clean(value?.meta_pixel_id, 30)?.replace(/\D/g, "") || null;
    const convName = clean(value?.google_conversion_name, 100) || "Portal enquiry";
    const custName = clean(value?.google_customer_conversion_name, 100) || null;
    const custText = clean(value?.customer_value, 12);
    const custValue = custText ? Math.round(Number(custText) * 100) : null;
    if (custText && (!Number.isFinite(custValue) || custValue < 0 || custValue > 100_000_000)) return fail(400, "Customer value must be an amount in pounds, like 400.");
    const priceText = clean(value?.price_per_enquiry, 12);
    const price = priceText ? Math.round(Number(priceText) * 100) : null;
    if (priceText && (!Number.isFinite(price) || price < 0 || price > 10_000_000)) return fail(400, "Price per enquiry must be an amount in pounds, like 25.");
    try {
      await db.sql`
        UPDATE clients SET google_customer_id = ${google}, meta_ad_account_id = ${meta}, call_min_seconds = ${minSeconds},
          price_per_enquiry_pence = ${price}, meta_pixel_id = ${pixel}, google_conversion_name = ${convName},
          google_customer_conversion_name = ${custName}, customer_value_pence = ${custValue}
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

  // GET /api/admin/attention  (everything that needs a human, across all clients)
  if (p[0] === "attention" && p.length === 1 && method === "GET") {
    return json({ items: await attentionItems(db) });
  }

  // GET /api/admin/billing?month=YYYY-MM  (billable enquiries per client)   &format=csv for a download
  if (p[0] === "billing" && p.length === 1 && method === "GET") {
    const url = new URL(req.url);
    const month = url.searchParams.get("month") || new Date().toISOString().slice(0, 7);
    const range = monthRange(month);
    if (!range) return fail(400, "Month must look like 2026-10.");
    const rows = await db.sql`
      SELECT c.id, c.name, c.price_per_enquiry_pence AS price,
        COUNT(l.id) FILTER (WHERE l.status <> 'spam')::int AS billable,
        COUNT(l.id) FILTER (WHERE l.status = 'new')::int AS unreviewed,
        COUNT(l.id) FILTER (WHERE l.status = 'spam')::int AS spam,
        COUNT(l.id) FILTER (WHERE l.status <> 'spam' AND l.type = 'call')::int AS calls,
        COUNT(l.id) FILTER (WHERE l.status <> 'spam' AND l.type = 'form')::int AS forms
      FROM clients c
      LEFT JOIN leads l ON l.client_id = c.id AND l.received_at >= ${range[0]} AND l.received_at < ${range[1]}
      GROUP BY c.id ORDER BY c.name`;
    const out = rows.map((r) => ({ ...r, total_pence: r.price == null ? null : r.price * r.billable }));
    if (url.searchParams.get("format") === "csv") {
      const csv = toCsv(
        ["Client", "Month", "Form enquiries", "Call enquiries", "Billable enquiries", "Not yet reviewed", "Marked spam", "Price per enquiry (GBP)", "Total (GBP)"],
        out.map((r) => [r.name, month, r.forms, r.calls, r.billable, r.unreviewed, r.spam,
          r.price == null ? "" : (r.price / 100).toFixed(2), r.total_pence == null ? "" : (r.total_pence / 100).toFixed(2)]));
      return new Response(csv, { headers: {
        "content-type": "text/csv; charset=utf-8", "cache-control": "no-store",
        "content-disposition": `attachment; filename="alpha-analytica-billing-${month}.csv"` } });
    }
    return json({ month, rows: out });
  }

  // ---- command centre ----
  if (p[0] === "overview" && p.length === 1 && method === "GET") {
    const data = await overviewData(db);
    return json({ ...data, system: { recording: recordingOn(), summaries: !!Netlify.env.get("ANTHROPIC_API_KEY"), retentionDays: retentionDays(), stripeOn: stripeOn() } });
  }
  if (p[0] === "performance" && p.length === 1 && method === "GET") return json(await performanceData(db));
  if (p[0] === "feed" && p.length === 1 && method === "GET") return json(await feedData(db, Object.fromEntries(new URL(req.url).searchParams)));
  if (p[0] === "calls" && p.length === 1 && method === "GET") return json(await callsData(db, Object.fromEntries(new URL(req.url).searchParams)));
  if (p[0] === "calls" && p.length === 2 && method === "GET") {
    const call = await callDetail(db, toInt(p[1], { min: 1 }));
    return call ? json({ call }) : fail(404, "Call not found.");
  }
  // GET /api/admin/calls/:id/recording  (audio streamed through us, so it never has a public link)
  if (p[0] === "calls" && p.length === 3 && p[2] === "recording" && method === "GET") {
    const [call] = await db.sql`SELECT recording_sid FROM calls WHERE id = ${toInt(p[1], { min: 1 })}`;
    if (!call?.recording_sid) return fail(404, "No recording for this call.");
    const upstream = await fetchRecording(call.recording_sid, req.headers.get("range"));
    if (!upstream.ok && upstream.status !== 206) return fail(502, "The recording isn't available right now.");
    const headers = new Headers({ "content-type": "audio/mpeg", "cache-control": "private, no-store", "x-content-type-options": "nosniff" });
    for (const h of ["content-length", "content-range", "accept-ranges"]) if (upstream.headers.get(h)) headers.set(h, upstream.headers.get(h));
    return new Response(upstream.body, { status: upstream.status, headers });
  }
  // POST /api/admin/calls/:id/transcribe  (retry a transcript or summary that didn't finish)
  if (p[0] === "calls" && p.length === 3 && p[2] === "transcribe" && method === "POST") {
    const id = toInt(p[1], { min: 1 });
    const [call] = await db.sql`SELECT transcript_sid, transcript_status, transcript FROM calls WHERE id = ${id}`;
    if (!call) return fail(404, "Call not found.");
    if (call.transcript) return json(await summariseCall(db, id));
    if (call.transcript_status === "failed") await db.sql`UPDATE calls SET transcript_sid = NULL, transcript_status = NULL WHERE id = ${id}`;
    return json(await startTranscript(db, id));
  }

  // GET /api/admin/invoices?month=YYYY-MM  (what's been billed, and what's waiting for approval)
  if (p[0] === "invoices" && p.length === 1 && method === "GET") {
    const month = new URL(req.url).searchParams.get("month");
    const rows = month
      ? await db.sql`SELECT i.id, i.period, i.quantity, i.unit_pence, i.total_pence, i.status, i.hosted_url, i.note, c.name AS client
                     FROM invoices i JOIN clients c ON c.id = i.client_id WHERE i.period = ${month} AND i.status <> 'creating' ORDER BY c.name`
      : await db.sql`SELECT i.id, i.period, i.quantity, i.unit_pence, i.total_pence, i.status, i.hosted_url, i.note, c.name AS client
                     FROM invoices i JOIN clients c ON c.id = i.client_id WHERE i.status IN ('draft', 'failed', 'open') ORDER BY i.period DESC, c.name`;
    return json({ invoices: rows, stripeOn: stripeOn(), mode: billingMode(), disputeDays: disputeDays() });
  }
  if (p[0] === "invoices" && p.length === 3 && p[2] === "approve" && method === "POST") {
    const r = await approveInvoice(db, toInt(p[1], { min: 1 }));
    return r.error ? fail(r.status, r.error) : json(r);
  }
  if (p[0] === "invoices" && p.length === 2 && method === "DELETE") {
    const r = await discardInvoice(db, toInt(p[1], { min: 1 }));
    return r.error ? fail(r.status, r.error) : json(r);
  }
  // POST /api/admin/run/billing  (invoice last month now; add {"period":"2026-09"} for another month)
  if (p[0] === "run" && p[1] === "billing" && p.length === 2 && method === "POST") {
    const { value } = await readBody(req);
    return json(await runBilling(db, { force: true, period: clean(value?.period, 7) }));
  }

  // GET /api/admin/disputes  and  POST /api/admin/disputes/:leadId {decision: accept|reject}
  if (p[0] === "disputes" && p.length === 1 && method === "GET") {
    const rows = await db.sql`
      SELECT l.id, l.received_at, l.disputed_at, l.type, l.name, l.phone, l.email, l.message, l.dispute_reason, c.name AS client, c.id AS client_id
      FROM leads l JOIN clients c ON c.id = l.client_id WHERE l.dispute_state = 'open' ORDER BY l.disputed_at`;
    return json({ disputes: rows, reasons: DISPUTE_REASONS });
  }
  if (p[0] === "disputes" && p.length === 2 && method === "POST") {
    const { value } = await readBody(req);
    const decision = clean(value?.decision, 10);
    if (!["accept", "reject"].includes(decision)) return fail(400, "Choose accept or reject.");
    const leadId = toInt(p[1], { min: 1 });
    const done = decision === "accept"
      ? await db.sql`UPDATE leads SET dispute_state = 'accepted', status = 'spam' WHERE id = ${leadId} AND dispute_state = 'open' RETURNING id`
      : await db.sql`UPDATE leads SET dispute_state = 'rejected' WHERE id = ${leadId} AND dispute_state = 'open' RETURNING id`;
    if (!done[0]) return fail(409, "That dispute has already been decided.");
    return json({ ok: true });
  }

  // GET /api/admin/prospects  (today's batch and everything before it)
  if (p[0] === "prospects" && p.length === 1 && method === "GET") {
    const rows = await db.sql`
      SELECT id, name, niche, address, phone, website, source, entity_type, status, notes, score, audit, proposition, proposition_by, batch_date, found_at, contacted_at, follow_up_on
      FROM prospects ORDER BY batch_date DESC, score ASC NULLS LAST, id DESC LIMIT 200`;
    return json({ prospects: rows, today: pickNiche().label, perDay: Number(Netlify.env.get("PROSPECTS_PER_DAY")) || 5, claude: !!Netlify.env.get("ANTHROPIC_API_KEY"), niches: NICHES.map((n) => n.label) });
  }

  // POST /api/admin/prospects  (add one by hand: name, website and/or phone)
  if (p[0] === "prospects" && p.length === 1 && method === "POST") {
    const { value } = await readBody(req);
    const r = await addProspect(db, value);
    return r.error ? fail(400, r.error) : json({ ok: true, id: r.id }, 201);
  }

  // POST /api/admin/run/prospects  ("Find today's businesses now")
  if (p[0] === "run" && p[1] === "prospects" && p.length === 2 && method === "POST") {
    return json(await findProspects(db));
  }

  // PATCH /api/admin/prospects/:id  (status, notes, company type, follow-up date)
  if (p[0] === "prospects" && p.length === 2 && method === "PATCH") {
    const id = toInt(p[1], { min: 1 });
    const b = (await readBody(req)).value || {};
    const status = b.status === undefined ? null : PROSPECT_STATUSES.includes(b.status) ? b.status : false;
    const entity = b.entity_type === undefined ? null : ["unknown", "company", "sole_trader"].includes(b.entity_type) ? b.entity_type : false;
    const followUp = b.follow_up_on === undefined ? undefined : b.follow_up_on === "" ? null : isDay(b.follow_up_on) ? b.follow_up_on : false;
    if (status === false || entity === false || followUp === false) return fail(400, "That value isn't allowed.");
    const notes = b.notes === undefined ? null : String(b.notes).slice(0, 2000);
    const hasFollow = followUp !== undefined;
    const [row] = await db.sql`
      UPDATE prospects SET
        status = COALESCE(${status}::text, status),
        entity_type = COALESCE(${entity}::text, entity_type),
        notes = COALESCE(${notes}::text, notes),
        follow_up_on = CASE WHEN ${hasFollow} THEN ${hasFollow ? followUp : null}::date ELSE follow_up_on END,
        contacted_at = CASE WHEN ${status}::text IN ('contacted','replied') AND contacted_at IS NULL THEN NOW() ELSE contacted_at END
      WHERE id = ${id} RETURNING id`;
    return row ? json({ ok: true }) : fail(404, "Not found.");
  }

  // POST /api/admin/prospects/:id/proposition  (write the proposal again, with Claude when a key is set)
  if (p[0] === "prospects" && p.length === 3 && p[2] === "proposition" && method === "POST") {
    const [row] = await db.sql`SELECT id, name, niche, website, audit FROM prospects WHERE id = ${toInt(p[1], { min: 1 })}`;
    if (!row) return fail(404, "Not found.");
    const { proposition, by } = await buildProposition(row, row.audit, nicheFor(row.niche) || { label: row.niche, job: "new enquiries" });
    await db.sql`UPDATE prospects SET proposition = ${JSON.stringify(proposition)}::jsonb, proposition_by = ${by} WHERE id = ${row.id}`;
    return json({ ok: true, by });
  }

  // GET /api/admin/prospects/:id/pdf  (the proposal as a PDF to send)
  if (p[0] === "prospects" && p.length === 3 && p[2] === "pdf" && method === "GET") {
    const [row] = await db.sql`SELECT name, website, niche, proposition FROM prospects WHERE id = ${toInt(p[1], { min: 1 })}`;
    if (!row?.proposition) return fail(404, "Not found.");
    const bytes = await buildProposalPdf({ name: row.name, website: row.website, niche: row.niche, proposition: row.proposition, contact: Netlify.env.get("PROPOSAL_CONTACT") || "" });
    const file = "proposal-" + (slugify(row.name) || "business") + ".pdf";
    return new Response(bytes, { headers: { "content-type": "application/pdf", "content-disposition": `inline; filename="${file}"`, "cache-control": "private, no-store", "x-content-type-options": "nosniff" } });
  }

  // POST /api/admin/run/meta-conversions  (send waiting enquiries to Facebook now)
  if (p[0] === "run" && p[1] === "meta-conversions" && p.length === 2 && method === "POST") {
    return json(await sendMetaConversions(db));
  }

  // POST /api/admin/run/attention-email  (send the Monday email now, for testing)
  if (p[0] === "run" && p[1] === "attention-email" && p.length === 2 && method === "POST") {
    return json(await sendAttentionEmail(db));
  }

  // POST /api/admin/run/meta-sync  and  /api/admin/run/weekly-reports  ("Run now" buttons)
  if (p[0] === "run" && p.length === 2 && method === "POST") {
    if (p[1] === "meta-sync") return json(await syncMeta(db));
    if (p[1] === "weekly-reports") return json(await draftWeeklyReports(db));
    return fail(404, "Unknown job.");
  }

  // PATCH /api/admin/reports/:id  (edit a draft, or publish it)   DELETE removes it
  if (p[0] === "reports" && p.length === 2 && (method === "PATCH" || method === "DELETE")) {
    const reportId = toInt(p[1], { min: 1 });
    if (!reportId) return fail(400, "Bad id.");
    if (method === "DELETE") {
      await db.sql`DELETE FROM reports WHERE id = ${reportId}`;
      return json({ ok: true });
    }
    const { value } = await readBody(req, 60_000);
    const title = clean(value?.title, 160);
    const body = clean(value?.body, 20_000);
    if (!title || !body) return fail(400, "A title and report text are required.");
    await db.sql`UPDATE reports SET title = ${title}, body = ${body}, published = ${value?.publish === true} WHERE id = ${reportId}`;
    const email = value?.publish === true ? await notifyReportPublished(db, reportId) : null;
    return json({ ok: true, email });
  }

  // POST /api/admin/clients/:id/reports
  if (clientId && p[2] === "reports" && p.length === 3 && method === "POST") {
    const { value } = await readBody(req, 60_000);
    const weekStart = clean(value?.week_start, 10);
    const title = clean(value?.title, 160);
    const body = clean(value?.body, 20_000);
    if (!isDay(weekStart) || !title || !body) return fail(400, "A date, title and report text are required.");
    const [made] = await db.sql`INSERT INTO reports (client_id, week_start, title, body) VALUES (${clientId}, ${weekStart}, ${title}, ${body}) RETURNING id`;
    const email = await notifyReportPublished(db, made.id);
    return json({ ok: true, email }, 201);
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
    if (r.platform === "google") await db.sql`UPDATE clients SET google_last_push = NOW() WHERE id = ${found[0].id}`;
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

// Remember the ad click behind a tap-to-call for a few minutes, so the call can be credited to it
async function callClick(req, db) {
  const parsed = await readBody(req, 4_000);
  const c = parsed.value ? parseCallClick(parsed.value) : null;
  if (!c) return new Response(null, { status: 204 });
  try {
    const [known] = await db.sql`SELECT 1 AS ok FROM tracking_numbers WHERE number = ${c.number}`;
    if (!known) return new Response(null, { status: 204 });
    // Ignore floods: a real number is not tapped dozens of times a minute
    const [{ n }] = await db.sql`SELECT COUNT(*)::int AS n FROM call_clicks WHERE number = ${c.number} AND clicked_at > NOW() - INTERVAL '5 minutes'`;
    if (n < 20) {
      await db.sql`
        INSERT INTO call_clicks (number, gclid, gbraid, wbraid, fbc, fbp, page_url)
        VALUES (${c.number}, ${c.gclid}, ${c.gbraid}, ${c.wbraid}, ${c.fbc}, ${c.fbp}, ${c.page_url})`;
    }
    if (Math.random() < 0.02) await db.sql`DELETE FROM call_clicks WHERE clicked_at < NOW() - INTERVAL '2 days'`;
  } catch (e) {
    console.error("call click failed", e);
  }
  return new Response(null, { status: 204 });
}

// Credit a call to the website tap that led to it, if there is exactly one candidate
async function creditCallToClick(db, callSid, number) {
  const clicks = await db.sql`
    SELECT id, gclid, gbraid, wbraid, fbc, fbp, page_url, clicked_at FROM call_clicks
    WHERE number = ${number} AND used_at IS NULL AND clicked_at > NOW() - INTERVAL '3 minutes'`;
  const hit = pickCallClick(clicks, new Date());
  if (!hit) return;
  await db.sql`UPDATE call_clicks SET used_at = NOW() WHERE id = ${hit.id}`;
  await db.sql`
    UPDATE calls SET gclid = ${hit.gclid}, gbraid = ${hit.gbraid}, wbraid = ${hit.wbraid}, fbc = ${hit.fbc}, fbp = ${hit.fbp}, page_url = ${hit.page_url}
    WHERE call_sid = ${callSid}`;
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
    await creditCallToClick(db, sid, to);
  } catch (e) {
    console.error("call log failed", e);
  }

  // Recording is opt-in, and always comes with a spoken notice to the caller
  const recording = recordingOn()
    ? { recordingCallbackUrl: `${publicBase(req)}/api/twilio/recording`, notice: recordingNotice() }
    : {};
  return twiml(dialTwiml({
    forwardTo: row.forward_to,
    callerId: to,
    actionUrl: `${publicBase(req)}/api/twilio/status`,
    timeout: 25,
    ...recording,
  }));
}

// Twilio says a recording is ready: store it and start the transcript. Never fails the call flow.
async function twilioRecording(req, db) {
  const params = await twilioParams(req);
  if (!params) return new Response("Forbidden", { status: 403 });
  try {
    await handleRecordingCallback(db, params);
  } catch (e) {
    console.error("recording callback failed", e);
  }
  return new Response(null, { status: 204 });
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
      RETURNING client_id, from_number, label, gclid, gbraid, wbraid, fbc, fbp, page_url`;
    const call = updated[0];
    if (call) {
      const [client] = await db.sql`SELECT call_min_seconds FROM clients WHERE id = ${call.client_id}`;
      if (client && countsAsEnquiry(status, seconds, client.call_min_seconds)) {
        await db.sql`
          INSERT INTO leads (client_id, type, phone, message, source, call_sid, gclid, gbraid, wbraid, fbc, fbp, page_url)
          VALUES (${call.client_id}, 'call', ${call.from_number}, ${`Phone call, ${seconds} seconds`}, ${call.label}, ${sid},
                  ${call.gclid}, ${call.gbraid}, ${call.wbraid}, ${call.fbc}, ${call.fbp}, ${call.page_url})
          ON CONFLICT (call_sid) DO NOTHING`;
      }
    }
  } catch (e) {
    console.error("call status failed", e);
  }

  return twiml(status === "completed" ? HANGUP_TWIML : sayHangupTwiml("Sorry, we could not reach anyone. Please try again shortly."));
}

/* ---------- a customer sets up their own tracking number ---------- */

async function twilioApi(path, { method = "GET", form } = {}) {
  const sid = Netlify.env.get("TWILIO_ACCOUNT_SID");
  const token = Netlify.env.get("TWILIO_AUTH_TOKEN");
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/${path}`, {
    method,
    headers: {
      authorization: "Basic " + Buffer.from(`${sid}:${token}`).toString("base64"),
      ...(form ? { "content-type": "application/x-www-form-urlencoded" } : {}),
    },
    body: form ? new URLSearchParams(form).toString() : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Twilio ${res.status}: ${data.message || "error"}`);
  return data;
}

// Can we buy numbers automatically right now? (Switched on deliberately, because numbers cost money.)
function selfServeConfig() {
  return {
    on: Netlify.env.get("SELF_SERVE_NUMBERS") === "on",
    sid: Netlify.env.get("TWILIO_ACCOUNT_SID"),
    bundle: Netlify.env.get("TWILIO_BUNDLE_SID"),
    address: Netlify.env.get("TWILIO_ADDRESS_SID"),
    max: toInt(Netlify.env.get("SELF_SERVE_MAX_NUMBERS"), { min: 0, max: 1000 }) ?? 20,
  };
}
function selfServeReady() {
  const cfg = selfServeConfig();
  return !!(cfg.on && cfg.sid && Netlify.env.get("TWILIO_AUTH_TOKEN") && cfg.bundle && cfg.address);
}

// Gives a business a tracking number that forwards to `phone`. Returns { ok, number, changed } or { status, message }.
async function provisionNumber(req, db, client, phone) {
  // Already set up? Then this just changes where calls are forwarded. No cost.
  const existing = await db.sql`SELECT id, number FROM tracking_numbers WHERE client_id = ${client.id} AND number LIKE '+%'`;
  if (existing.length) {
    await db.sql`UPDATE tracking_numbers SET forward_to = ${phone} WHERE client_id = ${client.id} AND number LIKE '+%'`;
    return { ok: true, changed: true, number: existing[0].number };
  }

  const cfg = selfServeConfig();
  if (!selfServeReady()) {
    return { status: 503, message: "Automatic setup isn't switched on yet. We'll set your number up for you and let you know." };
  }
  const [{ n }] = await db.sql`SELECT COUNT(*)::int AS n FROM tracking_numbers WHERE self_serve`;
  if (n >= cfg.max) return { status: 503, message: "We'll set your number up for you and let you know." };

  // Reserve the slot first, so a double click can't buy two numbers
  await db.sql`DELETE FROM tracking_numbers WHERE self_serve AND number NOT LIKE '+%' AND created_at < NOW() - INTERVAL '5 minutes'`;
  const reserved = await db.sql`
    INSERT INTO tracking_numbers (client_id, number, forward_to, label, self_serve)
    VALUES (${client.id}, ${"pending:" + client.id}, ${phone}, 'Website and ads', TRUE)
    ON CONFLICT DO NOTHING RETURNING id`;
  if (!reserved[0]) return { status: 409, message: "Your number is being set up. Give it a minute and refresh." };

  try {
    const type = Netlify.env.get("TWILIO_NUMBER_TYPE") || "Local";
    const found = await twilioApi(`AvailablePhoneNumbers/GB/${type}.json?VoiceEnabled=true&PageSize=1`);
    const candidate = found.available_phone_numbers?.[0]?.phone_number;
    if (!candidate) throw new Error("No numbers available");
    const base = (Netlify.env.get("PUBLIC_BASE_URL") || new URL(req.url).origin).replace(/\/$/, "");
    const bought = await twilioApi("IncomingPhoneNumbers.json", {
      method: "POST",
      form: {
        PhoneNumber: candidate, BundleSid: cfg.bundle, AddressSid: cfg.address,
        VoiceUrl: `${base}/api/twilio/voice`, VoiceMethod: "POST",
        FriendlyName: `${client.name}`.slice(0, 60),
      },
    });
    await db.sql`UPDATE tracking_numbers SET number = ${bought.phone_number} WHERE id = ${reserved[0].id}`;
    return { ok: true, number: bought.phone_number };
  } catch (e) {
    console.error("self-serve number failed", e);
    await db.sql`DELETE FROM tracking_numbers WHERE id = ${reserved[0].id} AND number NOT LIKE '+%'`;
    return { status: 502, message: "We couldn't set that up automatically. We've been told and will sort it out for you." };
  }
}

async function setupPhone(req, db, me) {
  if (!me.client) return fail(403, "No business is linked to this login yet.");
  const parsed = await readBody(req);
  const phone = normaliseUkPhone(String(parsed.value?.phone ?? ""));
  if (!phone) return fail(400, "Please enter a normal UK landline or mobile number, like 07700 900123.");
  const r = await provisionNumber(req, db, me.client, phone);
  if (!r.ok) return fail(r.status, r.message);
  return r.changed ? json({ ok: true, changed: true }) : json({ ok: true, number: r.number }, 201);
}


/* ---------- payments ---------- */

async function paymentSetup(db, me) {
  if (!me.client) return fail(403, "No business is linked to this login yet.");
  if (!stripeOn()) return fail(503, "Online payment isn't switched on yet. We'll be in touch to set it up.");
  try {
    return json({ url: await createPaymentSetup(db, me.client) });
  } catch (e) {
    console.error("payment setup failed", e);
    return fail(502, "We couldn't open the payment page. Please try again in a minute.");
  }
}

async function disputeLead(req, db, me, leadId) {
  if (!leadId) return fail(400, "Bad enquiry.");
  const { value } = await readBody(req);
  const reason = clean(value?.reason, 30);
  if (!Object.hasOwn(DISPUTE_REASONS, reason)) return fail(400, "Pick a reason.");
  const [lead] = await db.sql`SELECT id, client_id, received_at, status, dispute_state FROM leads WHERE id = ${leadId}`;
  // same answer as "missing" for someone else's enquiry, so ids can't be probed
  if (!lead || !(me.client && me.client.id === lead.client_id)) return fail(404, "Enquiry not found.");
  if (!disputeAllowed(lead, new Date(), disputeDays())) return fail(409, `Enquiries can only be disputed within ${disputeDays()} days, and once.`);
  const done = await db.sql`
    UPDATE leads SET dispute_state = 'open', dispute_reason = ${reason}, disputed_at = NOW()
    WHERE id = ${leadId} AND dispute_state IS NULL RETURNING id`;
  if (!done[0]) return fail(409, "That enquiry has already been disputed.");
  // best effort: a failed email must never undo the dispute
  sendEmail({ to: parseAdminEmails(Netlify.env.get("ADMIN_EMAILS")), subject: `Dispute from ${me.client.name}`,
    text: `${me.client.name} disputed an enquiry (${DISPUTE_REASONS[reason]}). Review it in the portal under Admin.` }).catch(() => {});
  return json({ ok: true });
}

async function stripeWebhook(req, db) {
  const secret = Netlify.env.get("STRIPE_WEBHOOK_SECRET");
  const payload = await req.text();
  if (payload.length > 1_000_000) return fail(413, "Too large.");
  if (!verifyStripeSignature({ payload, header: req.headers.get("stripe-signature"), secret })) return fail(400, "Bad signature.");
  let event;
  try { event = JSON.parse(payload); } catch { return fail(400, "Bad request."); }
  try {
    await handleStripeEvent(db, event);
  } catch (e) {
    console.error("stripe event failed", event?.type, e);
    return fail(500, "Try again."); // Stripe will retry
  }
  return json({ received: true });
}

/* ---------- a client tells us about their business, and their ad account ids ---------- */

async function saveIntake(req, db, me) {
  if (!me.client) return fail(403, "No business is linked to this login yet.");
  const { value } = await readBody(req, 30_000);
  const intake = cleanIntake(value);
  if (!Object.keys(intake).length) return fail(400, "Please fill in at least one box.");
  await db.sql`UPDATE clients SET intake = ${JSON.stringify(intake)}::jsonb WHERE id = ${me.client.id}`;
  return json({ ok: true });
}

// Clients can add their own ad account ids, but only into an empty slot. Changing one is an admin job.
async function saveOwnAccounts(req, db, me) {
  if (!me.client) return fail(403, "No business is linked to this login yet.");
  const { value } = await readBody(req);
  const google = clean(value?.google_customer_id, 30)?.replace(/\D/g, "") || null;
  const meta = clean(value?.meta_ad_account_id, 30)?.replace(/\D/g, "") || null;
  if (google && !/^\d{10}$/.test(google)) return fail(400, "A Google Ads customer id has 10 digits, like 123-456-7890.");
  if (meta && !/^\d{5,20}$/.test(meta)) return fail(400, "A Facebook ad account id is a number, like 1234567890.");
  if (!google && !meta) return fail(400, "Enter at least one account id.");
  try {
    if (google) await db.sql`UPDATE clients SET google_customer_id = ${google} WHERE id = ${me.client.id} AND google_customer_id IS NULL`;
    if (meta) await db.sql`UPDATE clients SET meta_ad_account_id = ${meta} WHERE id = ${me.client.id} AND meta_ad_account_id IS NULL`;
  } catch {
    return fail(409, "That account is already linked to another business. Please contact us.");
  }
  return json({ ok: true });
}


/* ---------- genuine enquiries back to Google as offline conversions ---------- */

// The Google Ads script asks for enquiries to upload. Only ones we're confident are genuine go:
// confirmed by the client (qualified or customer), or past the dispute window with no open dispute.
// Google can't easily take a conversion back, so we wait rather than retract later.
async function googleConversionsExport(req, db) {
  const expected = Netlify.env.get("ADS_PUSH_KEY");
  const key = clean(req.headers.get("x-push-key"), 200);
  if (!expected || !key || !safeEqual(key, expected)) return fail(401, "Unauthorised.");
  const days = disputeDays();
  const enquiries = await db.sql`
    SELECT l.id, l.gclid, l.received_at, c.google_customer_id, c.google_conversion_name, c.price_per_enquiry_pence
    FROM leads l JOIN clients c ON c.id = l.client_id
    WHERE l.gclid IS NOT NULL AND l.google_sent_at IS NULL AND l.status <> 'spam'
      AND (l.dispute_state IS NULL OR l.dispute_state = 'rejected')
      AND l.source IS DISTINCT FROM 'Test enquiry'
      AND c.google_customer_id IS NOT NULL
      AND (l.status IN ('qualified', 'customer') OR l.received_at < NOW() - make_interval(days => ${days}::int))
      AND l.received_at > NOW() - INTERVAL '80 days'
    ORDER BY l.received_at LIMIT 2000`;
  const customers = await db.sql`
    SELECT l.id, l.gclid, l.received_at, l.customer_at, c.google_customer_id, c.google_customer_conversion_name,
           c.customer_value_pence, c.price_per_enquiry_pence
    FROM leads l JOIN clients c ON c.id = l.client_id
    WHERE l.status = 'customer' AND l.gclid IS NOT NULL AND l.google_customer_sent_at IS NULL
      AND c.google_customer_id IS NOT NULL AND c.google_customer_conversion_name IS NOT NULL
      AND l.received_at > NOW() - INTERVAL '80 days'
    ORDER BY l.received_at LIMIT 2000`;
  return json({
    conversions: [
      ...enquiries.map((r) => ({
        id: r.id, kind: "enquiry", customer_id: r.google_customer_id, gclid: r.gclid,
        conversion_name: r.google_conversion_name, conversion_time: googleConversionTime(r.received_at),
        value: googleConversionValue(r.price_per_enquiry_pence),
      })),
      ...customers.map((r) => ({
        id: r.id, kind: "customer", customer_id: r.google_customer_id, gclid: r.gclid,
        conversion_name: r.google_customer_conversion_name, conversion_time: googleConversionTime(r.customer_at || r.received_at),
        value: googleConversionValue(r.customer_value_pence ?? r.price_per_enquiry_pence),
      })),
    ],
  });
}

// ...and confirms the ones it uploaded, so they are never sent twice
async function googleConversionsAck(req, db) {
  const expected = Netlify.env.get("ADS_PUSH_KEY");
  const key = clean(req.headers.get("x-push-key"), 200);
  if (!expected || !key || !safeEqual(key, expected)) return fail(401, "Unauthorised.");
  const { value } = await readBody(req, 100_000);
  const list = (v) => (Array.isArray(v) ? v : []).map((x) => toInt(x, { min: 1 })).filter(Boolean).slice(0, 2000);
  const ids = list(value?.ids);
  const customerIds = list(value?.customer_ids);
  let updated = 0;
  if (ids.length) {
    updated += (await db.sql`UPDATE leads SET google_sent_at = NOW() WHERE id = ANY(${ids}) AND google_sent_at IS NULL RETURNING id`).length;
  }
  if (customerIds.length) {
    updated += (await db.sql`UPDATE leads SET google_customer_sent_at = NOW() WHERE id = ANY(${customerIds}) AND google_customer_sent_at IS NULL RETURNING id`).length;
  }
  return json({ updated });
}
