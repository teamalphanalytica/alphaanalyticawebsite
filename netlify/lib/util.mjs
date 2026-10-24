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
