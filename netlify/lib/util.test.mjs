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
