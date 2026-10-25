import { test } from "node:test";
import assert from "node:assert/strict";
import { run } from "./db-shim.mjs";

const env = { ADMIN_EMAILS: "admin@aa.test", ADS_PUSH_KEY: "k" };
globalThis.Netlify = { env: { get: (k) => env[k] } };
const { default: api } = await import("../../netlify/functions/api.mjs");
const { getDatabase } = await import("./db-shim.mjs");
const { findProspects, pickNiche } = await import("../../netlify/lib/prospects.mjs");

const BASE = "https://aa.test";
const call = (path, { method = "GET", body } = {}) =>
  api(new Request(BASE + path, { method, body: body ? JSON.stringify(body) : undefined, headers: { "content-type": "application/json", origin: BASE } }));
const q = (sql) => JSON.parse(run(`SELECT COALESCE(json_agg(t), '[]'::json) FROM (${sql}) t`));
globalThis.__user = { email: "admin@aa.test" };
run(`TRUNCATE prospects RESTART IDENTITY`);

const now = new Date("2026-10-26T06:00:00Z");
const niche = pickNiche(now);
const GOOD = `<html><head><title>Good</title><meta name="viewport" content="width=device-width"><meta name="description" content="A long enough description for the search listing here."></head><body><a href="tel:01610000000">call</a><form></form>Get a free quote. Reviews. © 2026 ${"word ".repeat(120)}<script src="https://www.googletagmanager.com/gtag/js"></script></body></html>`;
const POOR = `<html><body>© 2017 old site 0161 000 1111</body></html>`;
const overpass = { elements: [
  { type: "node", id: 1, tags: { name: "Poor Roofing", phone: "0161 000 1111", website: "poor.co.uk" } },
  { type: "node", id: 2, tags: { name: "Good Roofing", phone: "0161 000 2222", website: "good.co.uk" } },
  { type: "node", id: 3, tags: { name: "No Site Roofing", phone: "0161 000 3333" } },
  { type: "node", id: 4, tags: { name: "Down Roofing", phone: "0161 000 4444", website: "down.co.uk" } },
] };
const fakeFetch = async (url) => {
  if (url.includes("overpass")) return Response.json(overpass);
  if (url.startsWith("https://poor.co.uk")) return new Response(POOR, { headers: { "content-type": "text/html" } });
  if (url.startsWith("https://good.co.uk")) return new Response(GOOD, { headers: { "content-type": "text/html" } });
  throw new Error("connection refused");
};

test("the daily run keeps the businesses we can help most, skips good sites, and never repeats", async () => {
  const db = getDatabase();
  const r = await findProspects(db, { now, niche, fetchImpl: fakeFetch, count: 5 });
  assert.equal(r.candidates, 4);
  assert.equal(r.added, 3);
  const rows = q(`SELECT name, score, status, proposition_by, website FROM prospects ORDER BY score, name`);
  assert.deepEqual(rows.map((x) => x.name), ["No Site Roofing", "Poor Roofing", "Down Roofing"]);
  assert.ok(!rows.some((x) => x.name === "Good Roofing"));
  assert.ok(rows.every((x) => x.status === "new" && x.proposition_by === "template"));
  const again = await findProspects(db, { now, niche, fetchImpl: fakeFetch, count: 5 });
  assert.equal(again.added, 0);
  assert.equal(q(`SELECT count(*) AS n FROM prospects`)[0].n, 3);
});

test("count limits how many are added", async () => {
  run(`TRUNCATE prospects RESTART IDENTITY`);
  const r = await findProspects(getDatabase(), { now, niche, fetchImpl: fakeFetch, count: 2 });
  assert.equal(r.added, 2);
});

test("a map outage is reported, not thrown", async () => {
  const r = await findProspects(getDatabase(), { now, niche, fetchImpl: async () => { throw new Error("down"); } });
  assert.match(r.error, /business map/);
});

test("admin can list, update, rewrite and download a proposal", async () => {
  const list = await (await call("/api/admin/prospects")).json();
  assert.equal(list.prospects.length, 2);
  const id = list.prospects[0].id;
  const patch = await call(`/api/admin/prospects/${id}`, { method: "PATCH", body: { status: "contacted", notes: "Spoke to Dave", follow_up_on: "2026-11-02" } });
  assert.equal(patch.status, 200);
  let row = q(`SELECT status, notes, follow_up_on::text AS f, contacted_at IS NOT NULL AS c FROM prospects WHERE id=${id}`)[0];
  assert.deepEqual(row, { status: "contacted", notes: "Spoke to Dave", f: "2026-11-02", c: true });
  // a status-only change must not wipe the follow-up date or notes
  await call(`/api/admin/prospects/${id}`, { method: "PATCH", body: { status: "replied" } });
  row = q(`SELECT status, notes, follow_up_on::text AS f FROM prospects WHERE id=${id}`)[0];
  assert.deepEqual(row, { status: "replied", notes: "Spoke to Dave", f: "2026-11-02" });
  assert.equal((await call(`/api/admin/prospects/${id}`, { method: "PATCH", body: { status: "hacked" } })).status, 400);
  assert.equal((await call(`/api/admin/prospects/${id}`, { method: "PATCH", body: { ads_google: "maybe" } })).status, 400);
  await call(`/api/admin/prospects/${id}`, { method: "PATCH", body: { ads_google: "yes", ads_meta: "no" } });
  assert.deepEqual(q(`SELECT ads_google, ads_meta, status FROM prospects WHERE id=${id}`)[0], { ads_google: "yes", ads_meta: "no", status: "replied" });
  const again = await (await call("/api/admin/prospects")).json();
  assert.match(again.prospects.find((x) => x.id === id).ad_links.google, /adstransparency\.google\.com/);
  assert.equal((await call(`/api/admin/prospects/${id}/proposition`, { method: "POST", body: {} })).status, 200);
  const pdf = await call(`/api/admin/prospects/${id}/pdf`);
  assert.equal(pdf.status, 200);
  assert.equal(pdf.headers.get("content-type"), "application/pdf");
  assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0, 5).toString(), "%PDF-");
  assert.equal((await call(`/api/admin/prospects/99999/pdf`)).status, 404);
});

test("adding by hand checks the details and refuses duplicates", async () => {
  assert.equal((await call("/api/admin/prospects", { method: "POST", body: { name: "" } })).status, 400);
  assert.equal((await call("/api/admin/prospects", { method: "POST", body: { name: "X", website: "http://169.254.169.254" } })).status, 400);
  assert.equal((await call("/api/admin/prospects", { method: "POST", body: { name: "X", phone: "12345" } })).status, 400);
  const ok = await call("/api/admin/prospects", { method: "POST", body: { name: "Hand Plumbing", phone: "0161 555 0100", niche: "Plumbers and heating engineers" } });
  assert.equal(ok.status, 201);
  assert.equal((await call("/api/admin/prospects", { method: "POST", body: { name: "Hand Plumbing", phone: "0161 555 0100" } })).status, 400);
  assert.equal(q(`SELECT source, status, score FROM prospects WHERE name='Hand Plumbing'`)[0].score, 0);
});

test("clients and signed-out visitors cannot reach prospects", async () => {
  globalThis.__user = { email: "client@x.co" };
  assert.equal((await call("/api/admin/prospects")).status, 403);
  globalThis.__user = null;
  assert.equal((await call("/api/admin/prospects")).status, 401);
  globalThis.__user = { email: "admin@aa.test" };
});

test("the weekly AI review reads real numbers, saves once, and adds a note to the draft report", async () => {
  const { runWeeklyReviews } = await import("../../netlify/lib/ad-review.mjs");
  run(`TRUNCATE clients RESTART IDENTITY CASCADE`);
  run(`INSERT INTO clients (name, slug, ingest_key) VALUES ('Joe Plumbing','joe','k'), ('Quiet Co','quiet','k2')`);
  const day = "2026-10-20"; // a Tuesday; the review is for the week of Monday 19 Oct
  run(`INSERT INTO ad_stats (client_id, day, platform, spend_pence, impressions, clicks, enquiries) VALUES (1,'${day}','google',5000,900,60,4)`);
  run(`INSERT INTO leads (client_id, type, name, status, source, campaign, received_at) VALUES
    (1,'form','a','qualified','Google','boilers','${day}T10:00:00Z'),(1,'form','b','spam','Facebook','lead form','${day}T11:00:00Z'),(1,'form','c','new','Facebook','lead form','${day}T12:00:00Z')`);
  run(`INSERT INTO reports (client_id, week_start, title, body, published, auto) VALUES (1,'2026-10-19','Week','Numbers.',FALSE,TRUE)`);
  const good = { headline: "H", working: ["w"], not_working: ["n"], changes: [{ action: "Pause X", why: "Because" }], test_next: "t", client_note: "We are tightening the form." };
  let sent;
  globalThis.Netlify = { env: { get: (k) => (k === "ANTHROPIC_API_KEY" ? "sk-test" : env[k]) } };
  try {
    const fetchImpl = async (u, o) => { sent = JSON.parse(o.body); return Response.json({ content: [{ type: "text", text: JSON.stringify(good) }] }); };
    const r = await runWeeklyReviews(getDatabase(), { today: "2026-10-26", fetchImpl });
    assert.equal(r.reviewed, 1);
    assert.equal(r.skipped, 1); // Quiet Co has nothing to review
    const facts = JSON.parse(sent.messages[0].content.split("numbers:\n")[1]);
    assert.equal(facts.last_week.platforms[0].spend_pence, 5000);
    assert.equal(facts.last_week.campaigns.find((c) => c.campaign === "lead form").spam, 1);
    assert.equal(q(`SELECT count(*) AS n FROM ad_reviews`)[0].n, 1);
    assert.match(q(`SELECT body FROM reports WHERE client_id=1`)[0].body, /Our weekly review\nWe are tightening the form\./);
    const again = await runWeeklyReviews(getDatabase(), { today: "2026-10-26", fetchImpl });
    assert.equal(again.reviewed, 0); // already done, not repeated
    const forced = await (await call("/api/admin/clients/1/review", { method: "POST", body: {} })).json(); // different week (today), no data
    assert.equal(forced.ok, false);
    const detail = await (await call("/api/admin/clients/1")).json();
    assert.equal(detail.adReview.review.headline, "H");
  } finally { globalThis.Netlify = { env: { get: (k) => env[k] } }; }
});
