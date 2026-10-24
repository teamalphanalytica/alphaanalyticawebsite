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
    name: pick("name", "full_name", "your-name"),
    email: pick("email", "your-email"),
    phone: pick("phone", "telephone", "tel", "mobile"),
    message: pick("message", "summary", "body", "comments"),
    source: pick("source", "utm_source"),
    campaign: pick("campaign", "utm_campaign"),
  };
  if (lead.email && !isEmail(lead.email)) lead.email = null;
  if (!lead.name && !lead.email && !lead.phone && !lead.message) return null;
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
  approver_name: 120, domain: 120, facebook_page: 300, google_ads: 40, notes: 1500,
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
