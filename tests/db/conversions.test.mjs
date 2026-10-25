import { test } from "node:test";
import assert from "node:assert/strict";
import { run } from "./db-shim.mjs";
import { twilioSignature } from "../../netlify/lib/util.mjs";

const env = { ADS_PUSH_KEY: "push-key-123", TWILIO_AUTH_TOKEN: "tok", PUBLIC_BASE_URL: "https://aa.test", ADMIN_EMAILS: "admin@aa.test" };
globalThis.Netlify = { env: { get: (k) => env[k] } };
const { default: api } = await import("../../netlify/functions/api.mjs");

const BASE = "https://aa.test";
const call = (path, { method = "GET", body, headers = {} } = {}) =>
  api(new Request(BASE + path, { method, body, headers }));
const twilio = (path, params) => {
  const sig = twilioSignature(BASE + path, params, env.TWILIO_AUTH_TOKEN);
  return call(path, { method: "POST", body: new URLSearchParams(params).toString(), headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": sig } });
};
const q = (sql) => JSON.parse(run(`SELECT COALESCE(json_agg(t), '[]'::json) FROM (${sql}) t`));

run(`TRUNCATE clients RESTART IDENTITY CASCADE; TRUNCATE call_clicks RESTART IDENTITY`);
run(`INSERT INTO clients (name, slug, ingest_key, google_customer_id, price_per_enquiry_pence, google_customer_conversion_name, customer_value_pence)
     VALUES ('Joe Plumbing', 'joe', 'ingest-key-joe-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', '1234567890', 2500, 'Portal customer', 40000)`);
run(`INSERT INTO tracking_numbers (client_id, number, forward_to, label) VALUES (1, '+441612345678', '+447700900123', 'Google ads')`);
const lead = (name, { status = "new", daysAgo = 1, gclid = "Cj0KCQjw_" + name.padEnd(12, "x"), dispute = null, source = null, customerAt = null } = {}) =>
  run(`INSERT INTO leads (client_id, type, name, status, received_at, gclid, dispute_state, source, customer_at)
       VALUES (1, 'form', '${name}', '${status}', NOW() - INTERVAL '${daysAgo} days', ${gclid ? `'${gclid}'` : "NULL"},
               ${dispute ? `'${dispute}'` : "NULL"}, ${source ? `'${source}'` : "NULL"}, ${customerAt ? `NOW() - INTERVAL '${customerAt} days'` : "NULL"})`);
lead("fresh");                                   // 1 day old, unreviewed: wait
lead("qualified", { status: "qualified" });      // confirmed: send now
lead("old", { daysAgo: 8 });                     // past the dispute window: send
lead("disputed", { daysAgo: 8, dispute: "open" });// open dispute: never
lead("rejected", { daysAgo: 8, dispute: "rejected" }); // dispute rejected, so genuine: send
lead("spam", { status: "spam", daysAgo: 8 });    // spam: never
lead("customer", { status: "customer", customerAt: 1 }); // send as enquiry and as customer
lead("test", { daysAgo: 8, source: "Test enquiry" }); // our own test: never
lead("nogclid", { daysAgo: 8, gclid: null });   // nothing to match: never

test("export only sends enquiries we're confident are genuine, valued at the price", async () => {
  const bad = await call("/api/conversions/google", { headers: { "x-push-key": "wrong" } });
  assert.equal(bad.status, 401);
  const res = await call("/api/conversions/google", { headers: { "x-push-key": env.ADS_PUSH_KEY } });
  assert.equal(res.status, 200);
  const { conversions } = await res.json();
  const names = (kind) => conversions.filter((c) => c.kind === kind).map((c) => c.gclid.slice(9, 18).replace(/x+$/, "")).sort();
  assert.deepEqual(names("enquiry"), ["customer", "old", "qualified", "rejected"]);
  assert.deepEqual(names("customer"), ["customer"]);
  const enq = conversions.find((c) => c.kind === "enquiry");
  assert.equal(enq.value, 25);
  assert.equal(enq.conversion_name, "Portal enquiry");
  const cust = conversions.find((c) => c.kind === "customer");
  assert.equal(cust.value, 400);
  assert.equal(cust.conversion_name, "Portal customer");
  assert.match(cust.conversion_time, /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\+0000$/);
});

test("ack marks enquiries and customers separately, so neither is sent twice", async () => {
  const { conversions } = await (await call("/api/conversions/google", { headers: { "x-push-key": env.ADS_PUSH_KEY } })).json();
  const ids = conversions.filter((c) => c.kind === "enquiry").map((c) => c.id);
  const customer_ids = conversions.filter((c) => c.kind === "customer").map((c) => c.id);
  const ack = await call("/api/conversions/google/ack", { method: "POST", body: JSON.stringify({ ids, customer_ids }), headers: { "x-push-key": env.ADS_PUSH_KEY, "content-type": "application/json" } });
  assert.equal((await ack.json()).updated, ids.length + customer_ids.length);
  const again = await (await call("/api/conversions/google", { headers: { "x-push-key": env.ADS_PUSH_KEY } })).json();
  assert.equal(again.conversions.length, 0);
});

test("customer conversions are off when the client has no customer conversion name", async () => {
  run(`UPDATE clients SET google_customer_conversion_name = NULL`);
  lead("cust2", { status: "customer", customerAt: 1 });
  const { conversions } = await (await call("/api/conversions/google", { headers: { "x-push-key": env.ADS_PUSH_KEY } })).json();
  assert.deepEqual(conversions.map((c) => c.kind), ["enquiry"]);
});

test("a tap-to-call from an ad credits the call that follows, and the click id reaches the enquiry", async () => {
  const tap = await call("/api/call-click", { method: "POST", body: JSON.stringify({ number: "0161 234 5678", gclid: "Cj0KCQjw_CALLER-ONE", page_url: "https://joe.example/boilers" }), headers: { "content-type": "text/plain" } });
  assert.equal(tap.status, 204);
  const v = await twilio("/api/twilio/voice", { To: "+441612345678", From: "+447111222333", CallSid: "CA_one" });
  assert.equal(v.status, 200);
  assert.match(await v.text(), /<Dial/);
  const s = await twilio("/api/twilio/status", { CallSid: "CA_one", DialCallStatus: "completed", DialCallDuration: "75" });
  assert.equal(s.status, 200);
  const [l] = q(`SELECT gclid, page_url, type FROM leads WHERE call_sid = 'CA_one'`);
  assert.equal(l.type, "call");
  assert.equal(l.gclid, "Cj0KCQjw_CALLER-ONE");
  assert.equal(l.page_url, "https://joe.example/boilers");
  assert.equal(q(`SELECT used_at IS NOT NULL AS used FROM call_clicks`)[0].used, true, "a tap is only used once");
});

test("two different ad visitors tapping before one call: no guess", async () => {
  for (const g of ["Cj0KCQjw_VISITOR-AAA", "Cj0KCQjw_VISITOR-BBB"]) {
    await call("/api/call-click", { method: "POST", body: JSON.stringify({ number: "+441612345678", gclid: g }) });
  }
  await twilio("/api/twilio/voice", { To: "+441612345678", From: "+447111222444", CallSid: "CA_two" });
  await twilio("/api/twilio/status", { CallSid: "CA_two", DialCallStatus: "completed", DialCallDuration: "75" });
  const [l] = q(`SELECT gclid FROM leads WHERE call_sid = 'CA_two'`);
  assert.equal(l.gclid, null);
});

test("taps on numbers that aren't ours, or without an ad click, are ignored", async () => {
  const before = q(`SELECT COUNT(*)::int AS n FROM call_clicks`)[0].n;
  await call("/api/call-click", { method: "POST", body: JSON.stringify({ number: "+441619999999", gclid: "Cj0KCQjw_NOT-OURS-1" }) });
  await call("/api/call-click", { method: "POST", body: JSON.stringify({ number: "+441612345678" }) });
  await call("/api/call-click", { method: "POST", body: "not json" });
  assert.equal(q(`SELECT COUNT(*)::int AS n FROM call_clicks`)[0].n, before);
});

test("marking an enquiry as a customer records when, once", async () => {
  globalThis.__user = { email: "admin@aa.test" };
  const [{ id }] = q(`SELECT id FROM leads WHERE name = 'fresh'`);
  const patch = (status) => call(`/api/leads/${id}`, { method: "PATCH", body: JSON.stringify({ status }), headers: { "content-type": "application/json", origin: BASE } });
  assert.equal((await patch("customer")).status, 200);
  const first = q(`SELECT customer_at FROM leads WHERE id = ${id}`)[0].customer_at;
  assert.ok(first);
  await patch("qualified");
  await patch("customer");
  assert.equal(q(`SELECT customer_at FROM leads WHERE id = ${id}`)[0].customer_at, first);
  globalThis.__user = null;
});

test("client portal says whether an enquiry carries an ad click, without exposing the id", async () => {
  run(`INSERT INTO client_users (client_id, email) VALUES (1, 'joe@client.test') ON CONFLICT DO NOTHING`);
  globalThis.__user = { email: "joe@client.test" };
  const data = await (await call("/api/portal")).json();
  const l = data.leads.find((x) => x.name === "qualified");
  assert.equal(l.has_gclid, true);
  assert.equal("gclid" in l, false);
  globalThis.__user = null;
});

test("admin can save the customer conversion settings", async () => {
  globalThis.__user = { email: "admin@aa.test" };
  const res = await call("/api/admin/clients/1/accounts", { method: "PATCH", headers: { "content-type": "application/json", origin: BASE },
    body: JSON.stringify({ google_customer_id: "123-456-7890", call_min_seconds: 30, google_conversion_name: "Portal enquiry", google_customer_conversion_name: "Portal customer", customer_value: "450", price_per_enquiry: "25" }) });
  assert.equal(res.status, 200);
  const [c] = q(`SELECT google_customer_conversion_name, customer_value_pence FROM clients WHERE id = 1`);
  assert.deepEqual(c, { google_customer_conversion_name: "Portal customer", customer_value_pence: 45000 });
  const bad = await call("/api/admin/clients/1/accounts", { method: "PATCH", headers: { "content-type": "application/json", origin: BASE },
    body: JSON.stringify({ call_min_seconds: 30, customer_value: "lots" }) });
  assert.equal(bad.status, 400);
  globalThis.__user = null;
});
