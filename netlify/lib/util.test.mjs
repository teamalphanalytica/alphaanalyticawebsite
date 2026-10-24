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
