import { test } from "node:test";
import assert from "node:assert/strict";
import {
  clean, toInt, isEmail, isDay, safeUrl, slugify, parseLead, readBody, sameOrigin, parseAdminEmails,
} from "./util.mjs";

test("clean trims, caps length and rejects objects", () => {
  assert.equal(clean("  hi  "), "hi");
  assert.equal(clean("   "), null);
  assert.equal(clean(null), null);
  assert.equal(clean({ a: 1 }), null);
  assert.equal(clean("x".repeat(50), 10).length, 10);
});

test("toInt only accepts whole numbers in range", () => {
  assert.equal(toInt("12"), 12);
  assert.equal(toInt(0), 0);
  assert.equal(toInt(-1), null);
  assert.equal(toInt(1.5), null);
  assert.equal(toInt("abc"), null);
  assert.equal(toInt(""), null);
  assert.equal(toInt(5, { max: 4 }), null);
});

test("isEmail / isDay", () => {
  assert.ok(isEmail("a@b.co"));
  assert.ok(!isEmail("a@b"));
  assert.ok(!isEmail("a b@c.com"));
  assert.ok(isDay("2026-10-24"));
  assert.ok(!isDay("2026-02-30"));
  assert.ok(!isDay("24/10/2026"));
});

test("safeUrl blocks javascript: and junk", () => {
  assert.equal(safeUrl("https://example.com/a"), "https://example.com/a");
  assert.equal(safeUrl("javascript:alert(1)"), null);
  assert.equal(safeUrl("data:text/html,hi"), null);
  assert.equal(safeUrl("not a url"), null);
  assert.equal(safeUrl(""), null);
});

test("slugify", () => {
  assert.equal(slugify("Joe's Plumbing & Heating!"), "joe-s-plumbing-heating");
  assert.equal(slugify("!!!"), "client");
});

test("parseLead handles Netlify webhook shape", () => {
  const lead = parseLead({
    id: "abc", form_name: "contact",
    data: { name: "Sam", email: "sam@example.com", phone: "07123", message: "Need a quote", utm_source: "google" },
  });
  assert.deepEqual(lead, {
    name: "Sam", email: "sam@example.com", phone: "07123", message: "Need a quote", source: "google", campaign: null,
    gclid: null, gbraid: null, wbraid: null, fbc: null, fbp: null, ip: null, user_agent: null, page_url: null,
  });
});

test("parseLead handles flat and wrapped bodies", () => {
  assert.equal(parseLead({ name: "A", phone: "1" }).name, "A");
  assert.equal(parseLead({ payload: { data: { email: "x@y.zz" } } }).email, "x@y.zz");
});

test("parseLead drops bad email, flags honeypot, rejects empty", () => {
  assert.equal(parseLead({ name: "A", email: "nope" }).email, null);
  assert.deepEqual(parseLead({ name: "Bot", "bot-field": "gotcha" }), { spam: true });
  assert.deepEqual(parseLead({ data: { name: "Bot", "bot-field": "x" } }), { spam: true });
  assert.equal(parseLead({}), null);
  assert.equal(parseLead(null), null);
});

test("readBody parses json and forms, refuses large or invalid", async () => {
  const mk = (body, type) => new Request("https://x.test/", { method: "POST", body, headers: { "content-type": type } });
  assert.deepEqual((await readBody(mk('{"a":1}', "application/json"))).value, { a: 1 });
  assert.deepEqual((await readBody(mk("a=1&b=2", "application/x-www-form-urlencoded"))).value, { a: "1", b: "2" });
  assert.ok((await readBody(mk("{bad", "application/json"))).invalid);
  assert.ok((await readBody(mk("x".repeat(30), "application/json"), 10)).tooLarge);
});

test("sameOrigin only accepts matching host", () => {
  const req = (origin) => new Request("https://site.test/api/x", { headers: origin ? { origin } : {} });
  assert.ok(sameOrigin(req("https://site.test")));
  assert.ok(!sameOrigin(req("https://evil.test")));
  assert.ok(!sameOrigin(req(null)));
});

test("parseAdminEmails lowercases and trims", () => {
  assert.deepEqual(parseAdminEmails(" A@b.co, c@d.co ,,"), ["a@b.co", "c@d.co"]);
  assert.deepEqual(parseAdminEmails(undefined), []);
});

import { isE164, safeEqual, twilioSignature, validTwilioSignature, dialTwiml, countsAsEnquiry, parseAdRows } from "./util.mjs";

test("isE164", () => {
  assert.equal(isE164("+441612345678"), true);
  assert.equal(isE164("01612345678"), false);
  assert.equal(isE164("+0123"), false);
});

test("safeEqual", () => {
  assert.equal(safeEqual("abc", "abc"), true);
  assert.equal(safeEqual("abc", "abd"), false);
});

test("twilio signature matches Twilio's documented example", () => {
  const url = "https://mycompany.com/myapp.php?foo=1&bar=2";
  const params = { Digits: "1234", To: "+18005551212", From: "+14158675310", Caller: "+14158675310", CallSid: "CA1234567890ABCDE" };
  assert.equal(twilioSignature(url, params, "12345"), "GvWf1cFY/Q7PnoempGyD5oXAezc=");
  assert.equal(validTwilioSignature(url, params, "12345", "GvWf1cFY/Q7PnoempGyD5oXAezc="), true);
  assert.equal(validTwilioSignature(url, params, "12345", "nope"), false);
  assert.equal(validTwilioSignature(url, params, "", "x"), false);
});

test("dialTwiml escapes values", () => {
  const x = dialTwiml({ forwardTo: "+44700", callerId: "+44161", actionUrl: "https://a.b/s?x=1&y=2" });
  assert.match(x, /action="https:\/\/a\.b\/s\?x=1&amp;y=2"/);
  assert.match(x, /<Number>\+44700<\/Number>/);
});

test("countsAsEnquiry", () => {
  assert.equal(countsAsEnquiry("completed", 45, 30), true);
  assert.equal(countsAsEnquiry("completed", 10, 30), false);
  assert.equal(countsAsEnquiry("no-answer", 0, 0), false);
});

test("parseAdRows keeps good rows and reports bad ones", () => {
  const { rows, errors } = parseAdRows([
    { day: "2026-10-23", platform: "google", google_customer_id: "123-456-7890", spend: 12.34, impressions: 900, clicks: 40, conversions: 4.6 },
    { day: "2026-13-40", platform: "google", google_customer_id: "1", spend: 1 },
    { day: "2026-10-23", platform: "meta", meta_ad_account_id: "99", spend: -5 },
  ]);
  assert.equal(rows.length, 1);
  assert.deepEqual(errors, [1, 2]);
  assert.equal(rows[0].ident, "1234567890");
  assert.equal(rows[0].spend_pence, 1234);
  assert.equal(rows[0].enquiries, 5);
});

import { normaliseUkPhone } from "./util.mjs";

test("normaliseUkPhone accepts normal UK numbers", () => {
  assert.equal(normaliseUkPhone("07700 900123"), "+447700900123");
  assert.equal(normaliseUkPhone("+44 7700 900123"), "+447700900123");
  assert.equal(normaliseUkPhone("0161 234 5678"), "+441612345678");
  assert.equal(normaliseUkPhone("0044 20 7946 0000"), "+442079460000");
});

test("normaliseUkPhone refuses premium and odd numbers", () => {
  for (const bad of ["0900 123 4567", "0871 234 5678", "070 1234 5678", "118 118", "0800 123 456", "+1 415 867 5309", "abc", "", null, "0770090012"]) {
    assert.equal(normaliseUkPhone(bad), null, String(bad));
  }
});

import { addDays, mondayOf, gbp, parseMetaInsights, buildReport, findAlerts } from "./util.mjs";

test("mondayOf and addDays", () => {
  assert.equal(mondayOf("2026-10-24"), "2026-10-19"); // Saturday
  assert.equal(mondayOf("2026-10-19"), "2026-10-19");
  assert.equal(mondayOf("2026-10-25"), "2026-10-19"); // Sunday
  assert.equal(addDays("2026-10-31", 1), "2026-11-01");
});

test("parseMetaInsights takes one lead count and skips bad rows", () => {
  const rows = parseMetaInsights({ data: [
    { date_start: "2026-10-23", spend: "12.50", impressions: "900", clicks: "30",
      actions: [{ action_type: "lead", value: "3" }, { action_type: "onsite_conversion.lead_grouped", value: "3" }, { action_type: "link_click", value: "30" }] },
    { date_start: "bad", spend: "1" },
    { date_start: "2026-10-22", spend: "-4" },
  ] });
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], { day: "2026-10-23", spend_pence: 1250, impressions: 900, clicks: 30, enquiries: 3 });
});

test("buildReport reads sensibly", () => {
  const r = buildReport({ name: "Joe Plumbing", weekStart: "2026-10-12",
    cur: { enquiries: 6, calls: 4, answered: 3, spend_pence: 12000, clicks: 80, sources: [{ source: "Google ads", n: 4 }, { source: "Website", n: 2 }] },
    prev: { enquiries: 4 } });
  assert.match(r.body, /Enquiries: 6 \(up 50% on last week\)/);
  assert.match(r.body, /Cost per enquiry: £20\.00/);
  assert.match(r.body, /Google ads: 4/);
  assert.equal(gbp(1234), "£12.34");
});

test("findAlerts flags what needs a human", () => {
  const base = { website_url: "https://x.co", last_lead_at: "2026-10-23T10:00:00Z", has_intake: true, created_at: "2026-10-01T00:00:00Z", failed_calls_7d: 0, drafts: 0 };
  assert.deepEqual(findAlerts(base, "2026-10-24"), []);
  assert.match(findAlerts({ ...base, last_lead_at: "2026-10-19T10:00:00Z" }, "2026-10-24")[0].message, /No enquiries for 5 days/);
  assert.equal(findAlerts({ ...base, meta_ad_account_id: "1", meta_last_error: "token expired" }, "2026-10-24")[0].level, "bad");
  assert.ok(findAlerts({ ...base, google_customer_id: "1" }, "2026-10-24").some((a) => /no data received/.test(a.message)));
  assert.ok(findAlerts({ ...base, failed_calls_7d: 3 }, "2026-10-24").some((a) => /failed/.test(a.message)));
  assert.ok(findAlerts({ ...base, has_intake: false }, "2026-10-24").some((a) => /details/.test(a.message)));
});

import { connectionStates, cleanIntake } from "./util.mjs";

test("connectionStates", () => {
  const t = "2026-10-24";
  assert.equal(connectionStates({}, t).google.state, "none");
  assert.equal(connectionStates({ google_customer_id: "1" }, t).google.state, "waiting");
  assert.equal(connectionStates({ google_customer_id: "1", google_last_push: "2026-10-23T05:00:00Z" }, t).google.state, "live");
  assert.equal(connectionStates({ google_customer_id: "1", google_last_push: "2026-10-18T05:00:00Z" }, t).google.state, "error");
  assert.equal(connectionStates({ meta_ad_account_id: "1", meta_last_error: "x" }, t).meta.state, "error");
  assert.equal(connectionStates({ meta_ad_account_id: "1", meta_last_sync: "2026-10-24T05:30:00Z" }, t).meta.state, "live");
});

test("cleanIntake keeps only known, trimmed fields", () => {
  const r = cleanIntake({ services: "  Boilers  ", hacker: "x", area: "", notes: { a: 1 } });
  assert.deepEqual(r, { services: "Boilers" });
});

import { reportReadyEmail, attentionEmail, monthRange, toCsv } from "./util.mjs";

test("emails escape names and link to the portal", () => {
  const e = reportReadyEmail({ clientName: "Joe <Plumbing>", title: "Week <b>1</b>", portalUrl: "https://x.co/portal/" });
  assert.match(e.html, /Week &lt;b&gt;1&lt;\/b&gt;/);
  assert.match(e.text, /https:\/\/x\.co\/portal\//);
  const a = attentionEmail({ items: [{ client: "A", level: "bad", message: "x" }, { client: "B", level: "warn", message: "y" }], portalUrl: "u" });
  assert.match(a.subject, /2 things need your attention/);
  assert.match(attentionEmail({ items: [], portalUrl: "u" }).subject, /all clear/);
});

test("monthRange and toCsv", () => {
  assert.deepEqual(monthRange("2026-12"), ["2026-12-01", "2027-01-01"]);
  assert.deepEqual(monthRange("2026-02"), ["2026-02-01", "2026-03-01"]);
  assert.equal(monthRange("2026-13"), null);
  assert.equal(toCsv(["a", "b"], [["=SUM(1)", 'say "hi"']]), '"a","b"\r\n"\'=SUM(1)","say ""hi"""');
});

import { clickIds, hashEmail, hashPhone, metaLeadEvent, metaEventUsable, googleConversionTime } from "./util.mjs";

test("clickIds keeps good ids and drops junk", () => {
  const r = clickIds({ gclid: "Cj0KCQjw_abc-123XYZ", fbc: "fb.1.1729771234567.IwAR2abcdefghij", fbp: "fb.1.1729771234567.1234567890", gbraid: "<script>" });
  assert.equal(r.gclid, "Cj0KCQjw_abc-123XYZ");
  assert.equal(r.fbc, "fb.1.1729771234567.IwAR2abcdefghij");
  assert.equal(r.fbp, "fb.1.1729771234567.1234567890");
  assert.equal(r.gbraid, null);
  assert.equal(clickIds({ fbc: "fb.1.x.y" }).fbc, null);
});

test("hashing matches Meta's rules", () => {
  // sha256("test@example.com")
  assert.equal(hashEmail("  Test@Example.com "), "973dfe463ec85785f5f95af5ba3906eedb2d931c24e69824a89ea65dba4e813b");
  assert.equal(hashEmail("nope"), null);
  assert.equal(hashPhone("07700 900123"), hashPhone("+447700900123"));
  assert.equal(hashPhone("abc"), null);
});

test("metaLeadEvent builds a deduplicated Lead", () => {
  const ev = metaLeadEvent({ id: 7, type: "form", received_at: "2026-10-24T10:00:00Z", email: "a@b.co", phone: "07700900123",
    fbc: "fb.1.1729771234567.IwAR2abcdefghij", ip: "1.2.3.4", user_agent: "UA", page_url: "https://x.co/" });
  assert.equal(ev.event_name, "Lead");
  assert.equal(ev.event_id, "aa-lead-7");
  assert.equal(ev.event_time, Date.parse("2026-10-24T10:00:00Z") / 1000);
  assert.equal(ev.action_source, "website");
  assert.equal(ev.user_data.em.length, 1);
  assert.equal(ev.event_source_url, "https://x.co/");
  const call = metaLeadEvent({ id: 8, type: "call", received_at: "2026-10-24T10:00:00Z", phone: "+447700900123" });
  assert.equal(call.action_source, "phone_call");
  assert.ok(metaEventUsable(call));
  assert.equal(metaEventUsable(metaLeadEvent({ id: 9, type: "form", received_at: "2026-10-24T10:00:00Z" })), false);
});

test("parseLead picks up click ids from a Netlify webhook", () => {
  const l = parseLead({ data: { name: "Sam", email: "s@x.co", gclid: "Cj0KCQjw_abc-123XYZ", ip: "81.2.69.160", user_agent: "Mozilla", page_url: "https://site.co/boilers" } });
  assert.equal(l.gclid, "Cj0KCQjw_abc-123XYZ");
  assert.equal(l.ip, "81.2.69.160");
  assert.equal(l.page_url, "https://site.co/boilers");
  assert.equal(l.fbc, null);
});

test("googleConversionTime", () => {
  assert.equal(googleConversionTime("2026-10-24T14:05:09.123Z"), "2026-10-24 14:05:09+0000");
});

/* ---------- onboarding ---------- */
import { validateNewClient, launchChecklist, clientWelcomeMessage } from "./util.mjs";

test("validateNewClient accepts a good form and tidies it", () => {
  const { errors, value } = validateNewClient({
    name: "  Smith Plumbing ", owner_email: "Bob@Smith.co.uk", owner_phone: "07700 900123",
    price_per_enquiry: "25", google_customer_id: "123-456-7890", meta_ad_account_id: "act 12345678", website_url: "https://smith.co.uk",
  });
  assert.deepEqual(errors, []);
  assert.equal(value.name, "Smith Plumbing");
  assert.equal(value.owner_email, "bob@smith.co.uk");
  assert.equal(value.owner_phone, "+447700900123");
  assert.equal(value.price_per_enquiry_pence, 2500);
  assert.equal(value.google_customer_id, "1234567890");
  assert.equal(value.meta_ad_account_id, "12345678");
});

test("validateNewClient reports every mistake at once, by field", () => {
  const { errors } = validateNewClient({ name: "", owner_email: "nope", owner_phone: "12345", price_per_enquiry: "abc", google_customer_id: "123", meta_ad_account_id: "12", website_url: "javascript:alert(1)" });
  assert.deepEqual(errors.map((e) => e.field).sort(), ["google_customer_id", "meta_ad_account_id", "name", "owner_email", "owner_phone", "price_per_enquiry", "website_url"]);
});

test("validateNewClient treats optional boxes as optional", () => {
  const { errors, value } = validateNewClient({ name: "A", owner_email: "a@b.co" });
  assert.deepEqual(errors, []);
  assert.equal(value.owner_phone, null);
  assert.equal(value.price_per_enquiry_pence, null);
});

const blank = { hasLogin: false, hasNumber: false, websiteUrl: null, hasTestOrRealLead: false, hasIntake: false, priceSet: false };

test("launchChecklist starts with everything to do and points at the first step", () => {
  const r = launchChecklist(blank);
  assert.equal(r.done, 0);
  assert.equal(r.ready, false);
  assert.equal(r.nextStep.key, "login");
});

test("launchChecklist is ready only when every required step is done, ignoring conversions", () => {
  const full = { hasLogin: true, hasNumber: true, websiteUrl: "https://x.co", hasTestOrRealLead: true, hasIntake: true, googleId: "1", googleLive: true, metaId: "2", metaLive: true, priceSet: true };
  const r = launchChecklist(full);
  assert.equal(r.ready, true);
  assert.equal(r.items.find((i) => i.key === "conversions").state, "todo");
  assert.equal(launchChecklist({ ...full, metaLive: false }).ready, false);
});

test("launchChecklist separates waiting on someone else from needing action", () => {
  const r = launchChecklist({ ...blank, googleId: "1", metaId: "2", metaError: true });
  assert.equal(r.items.find((i) => i.key === "google").state, "waiting");
  assert.equal(r.items.find((i) => i.key === "meta").state, "error");
});

test("clientWelcomeMessage includes the agency ids and the portal link", () => {
  const m = clientWelcomeMessage({ businessName: "Smith Plumbing", portalUrl: "https://p.example", googleManagerId: "813-967-5839", metaBusinessId: "1556086649616024" });
  assert.match(m, /Smith Plumbing/);
  assert.match(m, /813-967-5839/);
  assert.match(m, /1556086649616024/);
  assert.match(m, /https:\/\/p\.example/);
});
