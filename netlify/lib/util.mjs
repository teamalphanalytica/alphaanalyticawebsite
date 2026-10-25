// Pure helpers: only Node built-ins, so they can be tested without Netlify or a database.

import { createHmac, createHash, timingSafeEqual } from "node:crypto";

export const LEAD_STATUSES = ["new", "qualified", "customer", "spam"];
export const STEP_STATUSES = ["todo", "doing", "done"];
export const PLATFORMS = ["google", "meta"];

export const DEFAULT_STEPS = [
  ["Discovery call", "We learn about your business, your customers and your goals."],
  ["Content and offer", "We gather your photos, services and prices, and agree the offer."],
  ["Design and build", "Your website is designed and built. A preview link appears here once it's ready."],
  ["Tracking set up", "Forms, calls and ad tracking are connected so every enquiry is counted."],
  ["Your approval", "You review the site and the campaigns. Nothing goes live without your say-so."],
  ["Go live", "Your website and ad campaigns launch."],
  ["First weekly report", "Your first Monday report arrives."],
];

/** Trim a value to a string of at most `max` characters, or null if empty. */
export function clean(value, max = 2000) {
  if (value === undefined || value === null) return null;
  if (typeof value === "object") return null;
  const s = String(value).trim();
  return s ? s.slice(0, max) : null;
}

/** Whole number within [min, max], or null. */
export function toInt(value, { min = 0, max = 2_000_000_000 } = {}) {
  if (value === "" || value === null || value === undefined) return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) return null;
  return n;
}

export function isEmail(s) {
  return typeof s === "string" && s.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

/** YYYY-MM-DD that is a real calendar date. */
export function isDay(s) {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** Only http(s) URLs are allowed; anything else returns null. */
export function safeUrl(value) {
  const s = clean(value, 500);
  if (!s) return null;
  try {
    const u = new URL(s);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch {
    return null;
  }
}

export function slugify(name) {
  return (
    String(name || "")
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "client"
  );
}

/**
 * Turn whatever a form webhook sends into one lead.
 * Handles Netlify's outgoing webhook shape ({ data: {...} }), a plain object,
 * and wrapped payloads ({ payload: { data: {...} } }).
 * Returns { spam: true } when the honeypot field is filled in.
 */
export function parseLead(body) {
  if (!body || typeof body !== "object") return null;
  const inner =
    (body.data && typeof body.data === "object" && body.data) ||
    (body.payload && body.payload.data && typeof body.payload.data === "object" && body.payload.data) ||
    body;

  if (clean(inner["bot-field"]) || clean(body["bot-field"])) return { spam: true };

  const pick = (...keys) => {
    for (const k of keys) {
      const v = clean(inner[k]) ?? clean(body[k]);
      if (v) return v;
    }
    return null;
  };

  const lead = {
    ...clickIds({
      gclid: pick("gclid"), gbraid: pick("gbraid"), wbraid: pick("wbraid"), fbc: pick("fbc"), fbp: pick("fbp"),
    }),
    ip: (() => { const v = pick("ip"); return v && /^[0-9a-fA-F:.]{3,45}$/.test(v) ? v : null; })(),
    user_agent: clean(pick("user_agent"), 400),
    page_url: safeUrl(pick("page_url", "referrer")),
    name: pick("name", "full_name", "your-name"),
    email: pick("email", "your-email"),
    phone: pick("phone", "telephone", "tel", "mobile"),
    message: pick("message", "summary", "body", "comments"),
    source: pick("source", "utm_source"),
    campaign: pick("campaign", "utm_campaign"),
  };
  if (lead.email && !isEmail(lead.email)) lead.email = null;
  if (!lead.name && !lead.email && !lead.phone && !lead.message) return null;
  for (const k of Object.keys(lead)) if (lead[k] === undefined) lead[k] = null;
  return lead;
}

/** Parse a request body that is JSON or a url-encoded form. Max ~20KB. */
export async function readBody(req, maxBytes = 20_000) {
  const text = await req.text();
  if (text.length > maxBytes) return { tooLarge: true };
  const type = (req.headers.get("content-type") || "").toLowerCase();
  if (type.includes("application/json")) {
    try {
      return { value: JSON.parse(text) };
    } catch {
      return { invalid: true };
    }
  }
  if (type.includes("application/x-www-form-urlencoded")) {
    return { value: Object.fromEntries(new URLSearchParams(text)) };
  }
  try {
    return { value: JSON.parse(text) };
  } catch {
    return { invalid: true };
  }
}

/** Browsers send Origin on fetch POST/PATCH/PUT; it must match this site. */
export function sameOrigin(req) {
  const origin = req.headers.get("origin");
  if (!origin) return false;
  try {
    return new URL(origin).host === new URL(req.url).host;
  } catch {
    return false;
  }
}

export function parseAdminEmails(value) {
  return String(value || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/* ---------- phone calls (Twilio) ---------- */

/** International format, e.g. +441612345678 */
export function isE164(s) {
  return typeof s === "string" && /^\+[1-9]\d{6,14}$/.test(s);
}

/** Compare two secrets without leaking where they differ. */
export function safeEqual(a, b) {
  const ha = createHash("sha256").update(String(a)).digest();
  const hb = createHash("sha256").update(String(b)).digest();
  return timingSafeEqual(ha, hb);
}

/**
 * Twilio signs each webhook: base64(HMAC-SHA1(authToken, url + each POST field
 * as name+value, fields sorted by name)).
 */
export function twilioSignature(url, params, authToken) {
  const data = Object.keys(params).sort().reduce((acc, k) => acc + k + params[k], url);
  return createHmac("sha1", authToken).update(data).digest("base64");
}

export function validTwilioSignature(url, params, authToken, header) {
  if (!authToken || !header) return false;
  return safeEqual(twilioSignature(url, params, authToken), header);
}

const xmlEscape = (s) => String(s).replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" }[c]));

export function dialTwiml({ forwardTo, callerId, actionUrl, timeout = 25 }) {
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Dial callerId="${xmlEscape(callerId)}" timeout="${Number(timeout)}" action="${xmlEscape(actionUrl)}" method="POST"><Number>${xmlEscape(forwardTo)}</Number></Dial></Response>`;
}

export function sayHangupTwiml(message) {
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Say language="en-GB">${xmlEscape(message)}</Say><Hangup/></Response>`;
}

export const HANGUP_TWIML = `<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`;

/** A call becomes an enquiry when it was answered and lasted long enough. */
export function countsAsEnquiry(status, seconds, minSeconds) {
  return status === "completed" && Number.isInteger(seconds) && seconds >= minSeconds;
}

/* ---------- ad results pushed in from Google Ads scripts, Meta tools, etc. ---------- */

const digits = (v) => String(v ?? "").replace(/\D/g, "");

/**
 * Validate rows like:
 * { day: "2026-10-23", platform: "google", google_customer_id: "123-456-7890",
 *   spend: 12.34 (pounds), impressions: 900, clicks: 40, conversions: 5 }
 * Returns { rows, errors } so one bad row doesn't lose the rest.
 */
export function parseAdRows(input) {
  const rows = [];
  const errors = [];
  (Array.isArray(input) ? input : []).forEach((r, i) => {
    const day = clean(r?.day, 10);
    const platform = clean(r?.platform, 10);
    const spend = Number(r?.spend);
    const ident = platform === "google" ? digits(r?.google_customer_id) : platform === "meta" ? digits(r?.meta_ad_account_id) : "";
    const impressions = toInt(r?.impressions ?? 0);
    const clicks = toInt(r?.clicks ?? 0);
    const conversions = toInt(Math.round(Number(r?.conversions ?? 0)));
    if (!isDay(day) || !PLATFORMS.includes(platform) || !ident || !Number.isFinite(spend) || spend < 0 || spend > 1_000_000
      || impressions === null || clicks === null || conversions === null) {
      errors.push(i);
      return;
    }
    rows.push({
      day, platform, ident, spend_pence: Math.round(spend * 100), impressions, clicks, enquiries: conversions,
    });
  });
  return { rows, errors };
}

/* ---------- customer self-serve phone setup ---------- */

/**
 * Turn what a customer types ("07700 900123", "+44 7700 900123") into +44… form.
 * Only ordinary UK mobiles, landlines and 03 numbers are accepted. Premium-rate (09),
 * 08 services, 070 personal numbers and 118 directory numbers are refused, so a
 * forwarded call can never be billed at a premium rate to the agency's account.
 */
export function normaliseUkPhone(input) {
  if (typeof input !== "string") return null;
  let s = input.replace(/[\s().-]/g, "");
  if (/^\+44/.test(s)) s = "0" + s.slice(3);
  else if (/^0044/.test(s)) s = "0" + s.slice(4);
  if (!/^0\d{9,10}$/.test(s)) return null;
  const ok = /^07[1-57-9]\d{8}$/.test(s) // mobiles (not 070 personal, 076 pagers)
    || /^0[123]\d{9}$/.test(s) // 01, 02, 03 numbers
    || /^01\d{8,9}$/.test(s);
  if (!ok) return null;
  return "+44" + s.slice(1);
}

/* ---------- automation: dates, Meta results, weekly drafts, alerts ---------- */

export const addDays = (day, n) => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** The Monday on or before a given day (YYYY-MM-DD). */
export function mondayOf(day) {
  const dow = (new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7; // Mon=0
  return addDays(day, -dow);
}

export const gbp = (pence) => `£${(Number(pence || 0) / 100).toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * Meta Marketing API insights ({ data: [{ date_start, spend, impressions, clicks, actions }] })
 * to rows for ad_stats. Enquiries = Meta's own lead count (never summed across overlapping types).
 */
export function parseMetaInsights(payload) {
  const rows = [];
  for (const r of Array.isArray(payload?.data) ? payload.data : []) {
    if (!isDay(r?.date_start)) continue;
    const spend = Number(r.spend);
    if (!Number.isFinite(spend) || spend < 0) continue;
    const actions = Array.isArray(r.actions) ? r.actions : [];
    const count = (t) => Number(actions.find((a) => a.action_type === t)?.value) || 0;
    const leads = count("lead") || count("onsite_conversion.lead_grouped") || count("offsite_conversion.fb_pixel_lead");
    rows.push({
      day: r.date_start,
      spend_pence: Math.round(spend * 100),
      impressions: toInt(r.impressions) ?? 0,
      clicks: toInt(r.clicks) ?? 0,
      enquiries: Math.round(leads),
    });
  }
  return rows;
}

const change = (now, before) => {
  if (!before) return now ? "new this week" : "no change";
  const pct = Math.round(((now - before) / before) * 100);
  return pct === 0 ? "same as last week" : `${pct > 0 ? "up" : "down"} ${Math.abs(pct)}% on last week`;
};

/**
 * Draft a plain-English weekly report.
 * cur / prev = { enquiries, calls, answered, spend_pence, clicks, sources: [{ source, n }] }
 */
export function buildReport({ name, weekStart, cur, prev }) {
  const end = addDays(weekStart, 6);
  const cpe = cur.enquiries ? gbp(cur.spend_pence / cur.enquiries) : null;
  const lines = [
    `Week ${weekStart} to ${end} for ${name}.`,
    "",
    `Enquiries: ${cur.enquiries} (${change(cur.enquiries, prev.enquiries)}).`,
    `Phone calls: ${cur.calls}, of which ${cur.answered} were answered.`,
    `Ad spend: ${gbp(cur.spend_pence)}, with ${cur.clicks} clicks.`,
    cpe ? `Cost per enquiry: ${cpe}.` : "Cost per enquiry: not available this week (no enquiries).",
  ];
  if (cur.sources.length) {
    lines.push("", "Where enquiries came from:");
    for (const s of cur.sources) lines.push(`- ${s.source}: ${s.n}`);
  }
  lines.push("", "DRAFT NOTES (edit before publishing): what worked this week, what we are changing next week.");
  return { title: `Weekly report: ${weekStart}`, body: lines.join("\n") };
}

/**
 * Things that need a human. r = one row of per-client facts, today = YYYY-MM-DD.
 * Returns [{ level: "bad" | "warn", message }].
 */
export function findAlerts(r, today) {
  const out = [];
  const daysSince = (ts) => (ts ? Math.floor((Date.parse(`${today}T12:00:00Z`) - new Date(ts).getTime()) / 86400000) : null);
  const live = Boolean(r.website_url);
  const lastLead = daysSince(r.last_lead_at);
  if (live && (lastLead === null || lastLead >= 3)) {
    out.push({ level: "warn", message: lastLead === null ? "No enquiries received yet." : `No enquiries for ${lastLead} days.` });
  }
  if (r.meta_ad_account_id) {
    if (r.meta_last_error) out.push({ level: "bad", message: `Facebook sync failing: ${r.meta_last_error}` });
    else if (!r.meta_last_sync) out.push({ level: "warn", message: "Facebook account added but not synced yet." });
  }
  if (r.google_customer_id) {
    const d = daysSince(r.google_last_push);
    if (d === null) out.push({ level: "warn", message: "Google account added but no data received yet. Check the manager account link." });
    else if (d >= 3) out.push({ level: "bad", message: `No Google data for ${d} days.` });
  }
  if (r.failed_calls_7d >= 2) out.push({ level: "bad", message: `${r.failed_calls_7d} calls failed to connect this week.` });
  if (r.drafts > 0) out.push({ level: "warn", message: `${r.drafts} weekly report draft${r.drafts > 1 ? "s" : ""} waiting to be published.` });
  if (!r.has_intake && daysSince(r.created_at) >= 2) out.push({ level: "warn", message: "Client hasn't filled in their details yet." });
  return out;
}

/** How each ad account connection looks, for the client's "Connect" guide and Admin. */
export function connectionStates(c, today) {
  const daysSince = (ts) => (ts ? Math.floor((Date.parse(`${today}T12:00:00Z`) - new Date(ts).getTime()) / 86400000) : null);
  const g = (() => {
    if (!c.google_customer_id) return { state: "none", text: "Not connected" };
    const d = daysSince(c.google_last_push);
    if (d === null) return { state: "waiting", text: "Waiting for Google to link your account" };
    return d >= 3 ? { state: "error", text: "No new data for a few days. We're looking into it." } : { state: "live", text: "Connected" };
  })();
  const m = (() => {
    if (!c.meta_ad_account_id) return { state: "none", text: "Not connected" };
    if (c.meta_last_error) return { state: "error", text: "We couldn't read your Facebook account yet. We're looking into it." };
    return c.meta_last_sync ? { state: "live", text: "Connected" } : { state: "waiting", text: "Waiting for Facebook to link your account" };
  })();
  return { google: g, meta: m };
}

/** What a client may tell us about their business. Unknown fields are ignored. */
export const INTAKE_FIELDS = {
  legal_name: 120, address: 240, services: 1500, area: 300, hours: 300, monthly_budget: 12,
  approver_name: 120, contact_phone: 30, domain: 120, facebook_page: 300, google_ads: 40, notes: 1500,
};

export function cleanIntake(input) {
  const out = {};
  for (const [k, max] of Object.entries(INTAKE_FIELDS)) {
    const v = clean(input?.[k], max);
    if (v) out[k] = v;
  }
  return out;
}

/* ---------- emails and billing ---------- */

const htmlEscape = (s) => String(s ?? "").replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;" }[c]));

/** Email to a client: their weekly report is ready. Link only, so nothing private sits in an inbox. */
export function reportReadyEmail({ clientName, title, portalUrl }) {
  const subject = `Your weekly report is ready: ${clientName}`;
  const text = `Hello,\n\nYour report "${title}" is ready to read in your Alpha Analytica portal:\n${portalUrl}\n\nThanks,\nAlpha Analytica`;
  const html = `<p>Hello,</p><p>Your report <b>${htmlEscape(title)}</b> is ready to read in your Alpha Analytica portal.</p>
<p><a href="${htmlEscape(portalUrl)}" style="background:#FFB703;color:#0A1128;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:600">Open your portal</a></p><p>Thanks,<br>Alpha Analytica</p>`;
  return { subject, text, html };
}

/** Monday email to the admins: everything that needs a human. */
export function attentionEmail({ items, portalUrl }) {
  const subject = items.length ? `Alpha Analytica: ${items.length} thing${items.length > 1 ? "s" : ""} need${items.length > 1 ? "" : "s"} your attention` : "Alpha Analytica: all clear this week";
  const lines = items.map((i) => `- ${i.level === "bad" ? "PROBLEM" : "Check"}: ${i.client}: ${i.message}`);
  const text = `${items.length ? lines.join("\n") : "Nothing needs your attention this week."}\n\nOpen Admin: ${portalUrl}`;
  const html = `${items.length
    ? `<ul>${items.map((i) => `<li><b>${i.level === "bad" ? "Problem" : "Check"}</b>, ${htmlEscape(i.client)}: ${htmlEscape(i.message)}</li>`).join("")}</ul>`
    : "<p>Nothing needs your attention this week.</p>"}<p><a href="${htmlEscape(portalUrl)}">Open Admin</a></p>`;
  return { subject, text, html };
}

/** "2026-10" to [first day, first day of next month]. */
export function monthRange(month) {
  if (typeof month !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return null;
  const [y, m] = month.split("-").map(Number);
  const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
  return [`${month}-01`, `${next}-01`];
}

/** Rows to CSV, quoting every cell and neutralising spreadsheet formulas. */
export function toCsv(header, rows) {
  const cell = (v) => {
    let s = String(v ?? "");
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return `"${s.replace(/"/g, '""')}"`;
  };
  return [header, ...rows].map((r) => r.map(cell).join(",")).join("\r\n");
}


/* ---------- conversions back to Google and Meta ---------- */

/** Keep only well-formed click ids; anything odd is dropped rather than sent on. */
export function clickIds({ gclid, gbraid, wbraid, fbc, fbp } = {}) {
  const id = (v) => (typeof v === "string" && /^[A-Za-z0-9_\-]{10,300}$/.test(v) ? v : null);
  return {
    gclid: id(gclid), gbraid: id(gbraid), wbraid: id(wbraid),
    fbc: typeof fbc === "string" && /^fb\.\d\.\d{10,16}\.[A-Za-z0-9_\-]{10,400}$/.test(fbc) ? fbc : null,
    fbp: typeof fbp === "string" && /^fb\.\d\.\d{10,16}\.\d{5,25}$/.test(fbp) ? fbp : null,
  };
}

const sha256 = (s) => createHash("sha256").update(s).digest("hex");

/** Meta wants emails trimmed and lower-cased, then SHA-256 hashed. */
export function hashEmail(email) {
  const e = typeof email === "string" ? email.trim().toLowerCase() : "";
  return isEmail(e) ? sha256(e) : null;
}

/** UK phone to digits with country code (447700900123), then SHA-256. */
export function hashPhone(phone) {
  const e164 = normaliseUkPhone(String(phone || "")) || (isE164(String(phone || "").replace(/[\s()-]/g, "")) ? String(phone).replace(/[\s()-]/g, "") : null);
  return e164 ? sha256(e164.slice(1)) : null;
}

/** One Meta Conversions API "Lead" event for an enquiry. */
export function metaLeadEvent(lead) {
  const user = {};
  const em = hashEmail(lead.email);
  const ph = hashPhone(lead.phone);
  if (em) user.em = [em];
  if (ph) user.ph = [ph];
  if (lead.fbc) user.fbc = lead.fbc;
  if (lead.fbp) user.fbp = lead.fbp;
  if (lead.ip) user.client_ip_address = lead.ip;
  if (lead.user_agent) user.client_user_agent = lead.user_agent;
  const isCall = lead.type === "call";
  const ev = {
    event_name: "Lead",
    event_time: Math.floor(new Date(lead.received_at).getTime() / 1000),
    event_id: `aa-lead-${lead.id}`,
    action_source: isCall ? "phone_call" : "website",
    user_data: user,
    custom_data: { lead_type: isCall ? "call" : "form" },
  };
  if (!isCall && lead.page_url) ev.event_source_url = lead.page_url;
  return ev;
}

/** Enough to match a person? Meta needs at least one identifier. */
export const metaEventUsable = (ev) => Boolean(ev.user_data.em || ev.user_data.ph || ev.user_data.fbc || ev.user_data.fbp);

/** Google offline conversion time, e.g. "2026-10-24 14:05:00+0000". */
export function googleConversionTime(ts) {
  const d = new Date(ts);
  return `${d.toISOString().slice(0, 19).replace("T", " ")}+0000`;
}

/* ---------- onboarding a new client ---------- */

/**
 * Checks the whole "add a client" form before anything is created, so a typo can never
 * leave a half-built client behind. Returns { errors: [{field, message}], value }.
 */
export function validateNewClient(input) {
  const errors = [];
  const bad = (field, message) => errors.push({ field, message });
  const value = {};

  value.name = clean(input?.name, 120);
  if (!value.name) bad("name", "Enter the business name.");
  value.sector = clean(input?.sector, 80);

  value.website_url = null;
  if (clean(input?.website_url)) {
    value.website_url = safeUrl(input.website_url);
    if (!value.website_url) bad("website_url", "The website must start with https:// (or http://).");
  }

  value.owner_email = clean(input?.owner_email, 254)?.toLowerCase() ?? null;
  if (!isEmail(value.owner_email)) bad("owner_email", "Enter the business owner's email. It's the address they'll log in with.");

  value.owner_phone = null;
  if (clean(input?.owner_phone, 30)) {
    value.owner_phone = normaliseUkPhone(String(input.owner_phone));
    if (!value.owner_phone) bad("owner_phone", "That doesn't look like a UK phone number. Try 07700 900123 or 0161 234 5678.");
  }

  value.price_per_enquiry_pence = null;
  const priceText = clean(input?.price_per_enquiry, 12);
  if (priceText) {
    const pence = Math.round(Number(priceText) * 100);
    if (!Number.isFinite(pence) || pence < 0 || pence > 10_000_000) bad("price_per_enquiry", "Price per enquiry must be an amount in pounds, like 25.");
    else value.price_per_enquiry_pence = pence;
  }

  value.google_customer_id = clean(input?.google_customer_id, 30)?.replace(/\D/g, "") || null;
  if (value.google_customer_id && !/^\d{10}$/.test(value.google_customer_id)) bad("google_customer_id", "A Google Ads customer id has 10 digits, like 123-456-7890.");
  value.meta_ad_account_id = clean(input?.meta_ad_account_id, 30)?.replace(/\D/g, "") || null;
  if (value.meta_ad_account_id && !/^\d{5,20}$/.test(value.meta_ad_account_id)) bad("meta_ad_account_id", "A Facebook ad account id is a number, like 1234567890.");

  return { errors, value };
}

/**
 * The launch checklist: every step to get a client fully live, in order, with what's done,
 * what's waiting on someone, and the single next thing to do. `c` is a plain object of facts
 * gathered from the database, so this stays easy to test.
 */
export function launchChecklist(c) {
  const item = (key, title, state, next) => ({ key, title, state, next: state === "done" ? null : next });
  const items = [];

  items.push(item("login", "Owner can log in to the portal", c.hasLogin ? "done" : "todo",
    "Invite their email in Netlify Identity, then link it under Logins."));

  items.push(item("number", "Tracking phone number live", c.hasNumber ? "done" : "todo",
    c.selfServeReady && c.forwardPhone ? "Press 'Set up number' and we'll buy it." : "Add their number under Tracking phone numbers (or finish the Twilio bundle so it can be automatic)."));

  items.push(item("website", "Website live and linked", c.websiteUrl ? "done" : "todo",
    "Add the live website address under Website links."));

  items.push(item("enquiries", "Website enquiries reaching the portal", c.hasTestOrRealLead ? "done" : "todo",
    "Add the webhook address to the site's Netlify form notifications, then press 'Send a test enquiry'."));

  items.push(item("details", "Owner has filled in their business details", c.hasIntake ? "done" : "waiting",
    "Ask them to fill in the Website tab. This is what the ads and site are built from."));

  items.push(item("google", "Google Ads connected and sending results",
    !c.googleId ? "todo" : c.googleLive ? "done" : "waiting",
    !c.googleId ? "Get their Google Ads customer id and add it under Ad accounts." : "Send the link request from your manager account and ask them to accept it. Results appear within a day."));

  items.push(item("meta", "Facebook ads connected and sending results",
    !c.metaId ? "todo" : c.metaLive ? "done" : c.metaError ? "error" : "waiting",
    !c.metaId ? "Get their Meta ad account id and add it under Ad accounts." : c.metaError ? "Check they've shared the ad account with your system user." : "Ask them to share the ad account with your business. Results appear after the next sync."));

  items.push(item("conversions", "Enquiries being sent back to Google and Facebook",
    (c.googleId && c.googleConversionSent) || (c.metaPixel && c.metaConversionSent) ? "done" : "todo",
    "Create the 'Portal enquiry' conversion action in Google Ads and add their Facebook pixel id. This starts on its own after the first real enquiry."));

  items.push(item("price", "Price per enquiry set", c.priceSet ? "done" : "todo",
    "Set the price per enquiry so billing is right."));

  if (c.stripeOn) {
    items.push(item("payment", "Payment method saved", c.paymentReady ? "done" : "waiting",
      "Ask them to open the Billing tab and press 'Set up payment'. Until then their invoices are sent with a pay-online link."));
  }

  const required = items.filter((i) => i.key !== "conversions");
  const done = items.filter((i) => i.state === "done").length;
  return {
    items,
    done,
    total: items.length,
    ready: required.every((i) => i.state === "done"),
    nextStep: items.find((i) => i.state === "todo" || i.state === "error") || items.find((i) => i.state === "waiting") || null,
  };
}

/** The message to send a new client: exactly what they need to do, nothing else. */
export function clientWelcomeMessage({ businessName, portalUrl, googleManagerId, metaBusinessId }) {
  const lines = [
    `Hi,`,
    ``,
    `Welcome to Alpha Analytica. Here's everything we need from you to get ${businessName} started. It takes about 10 minutes.`,
    ``,
    `1. Log in`,
    `   You'll get an email invite to our portal. Click it and choose a password. Your portal is here: ${portalUrl}`,
    ``,
    `2. Tell us about your business`,
    `   In the portal, open the Website tab and fill in the form. This is what we build your website and ads from.`,
  ];
  if (googleManagerId) {
    lines.push(``, `3. Link your Google Ads`, `   In Google Ads, go to Admin > Access and security > Managers and send us an access request using our manager id: ${googleManagerId}. If you don't have a Google Ads account yet, just tell us and we'll create one.`);
  }
  if (metaBusinessId) {
    lines.push(``, `4. Share your Facebook ads`, `   In Meta Business Settings, go to Partners > Add > Give a partner access to your assets, and enter our business id: ${metaBusinessId}. Share your ad account and your pixel. If you don't have these yet, tell us and we'll set them up.`);
  }
  lines.push(``, `5. Your phone number`, `   Tell us the number you'd like enquiry calls forwarded to. We'll give your website and ads a tracking number so every call is counted.`, ``, `Reply to this message if you get stuck on any step. We'll help.`, ``, `Thanks,`, `Alpha Analytica`);
  return lines.join("\n");
}

/* ---------- Stripe billing ---------- */

/** Stripe wants nested form fields like items[0][price]=1. Turns plain objects and arrays into that. */
export function stripeForm(obj) {
  const out = new URLSearchParams();
  const walk = (value, key) => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) value.forEach((v, i) => walk(v, `${key}[${i}]`));
    else if (typeof value === "object") Object.entries(value).forEach(([k, v]) => walk(v, key ? `${key}[${k}]` : k));
    else out.append(key, String(value));
  };
  walk(obj, "");
  return out;
}

/**
 * Check that a webhook really came from Stripe: header "t=...,v1=..." signs `${t}.${body}` with the
 * webhook secret. Rejects old timestamps so a captured request can't be replayed later.
 */
export function verifyStripeSignature({ payload, header, secret, nowSeconds = Math.floor(Date.now() / 1000), toleranceSeconds = 300 }) {
  if (!payload || !header || !secret) return false;
  const parts = Object.fromEntries(String(header).split(",").map((p) => p.split("=").map((s) => s.trim())).filter((p) => p.length === 2));
  const t = Number(parts.t);
  if (!Number.isInteger(t) || Math.abs(nowSeconds - t) > toleranceSeconds) return false;
  const expected = createHmac("sha256", secret).update(`${t}.${payload}`).digest("hex");
  // Stripe can send several v1 values while a secret is being rotated
  return String(header).split(",").map((p) => p.trim()).filter((p) => p.startsWith("v1=")).some((p) => safeEqual(p.slice(3), expected));
}

/** The month being billed on a given day: always the previous month, and only from `billingDay` onwards. */
export function billingPeriod(todayIso, billingDay = 8) {
  const [y, m, d] = todayIso.slice(0, 10).split("-").map(Number);
  const prev = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
  return { period: prev, due: d >= billingDay };
}

/** Can a client still dispute this enquiry? Only within `days` of it arriving, and only once. */
export function disputeAllowed(lead, now = new Date(), days = 7) {
  if (!lead || lead.dispute_state) return false;
  if (lead.status === "spam") return false;
  const age = now.getTime() - new Date(lead.received_at).getTime();
  return age >= 0 && age <= days * 86400000;
}

export const DISPUTE_REASONS = {
  spam: "Spam or fake",
  wrong_number: "Wrong number or not for us",
  not_enquiry: "Not a genuine enquiry",
  duplicate: "Duplicate of another enquiry",
};

/** "October 2026" from "2026-10" */
export function monthLabel(period) {
  const [y, m] = period.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
}

/**
 * What to do for one client's month. Pure, so every edge case is testable.
 * Returns { action: "invoice" | "skip" | "hold", reason, quantity, unit_pence, total_pence }.
 */
export function planInvoice({ billable, price, openDisputes, windowOpen }) {
  if (openDisputes > 0) return { action: "hold", reason: `${openDisputes} dispute${openDisputes === 1 ? "" : "s"} still to review` };
  if (windowOpen) return { action: "hold", reason: "The dispute window for the last enquiries is still open" };
  if (price == null) return { action: "hold", reason: "No price per enquiry set" };
  if (billable <= 0) return { action: "skip", reason: "No billable enquiries" };
  if (price <= 0) return { action: "skip", reason: "Price per enquiry is £0" };
  return { action: "invoice", quantity: billable, unit_pence: price, total_pence: billable * price };
}
