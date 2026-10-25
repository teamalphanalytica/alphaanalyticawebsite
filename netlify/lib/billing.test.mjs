// Runs the real billing code against an in-memory fake database and a fake Stripe,
// to prove it never double-bills, frees a month when Stripe fails, and waits on disputes.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

const env = {};
globalThis.Netlify = { env: { get: (k) => env[k] } };
const { runBilling, approveInvoice, handleStripeEvent } = await import("./billing.mjs");

let invoices, clients, figures, stripeCalls, stripeFail, customerSets;

function fakeDb() {
  return {
    sql: async (strings, ...v) => {
      const q = strings.join("?").replace(/\s+/g, " ").trim();
      if (q.startsWith("SELECT c.id, c.name, c.price_per_enquiry_pence")) {
        return clients.filter((c) => !invoices.some((i) => i.client_id === c.id && i.period === v[0]));
      }
      if (q.startsWith("SELECT COUNT(*) FILTER")) return [figures[v[0]] || { billable: 0, open_disputes: 0 }];
      if (q.startsWith("INSERT INTO invoices") && q.includes("'skipped'")) {
        if (!invoices.some((i) => i.client_id === v[0] && i.period === v[1])) invoices.push({ id: invoices.length + 1, client_id: v[0], period: v[1], status: "skipped" });
        return [];
      }
      if (q.startsWith("INSERT INTO invoices") && q.includes("'creating'")) {
        if (invoices.some((i) => i.client_id === v[0] && i.period === v[1])) return [];
        const row = { id: invoices.length + 1, client_id: v[0], period: v[1], quantity: v[2], unit_pence: v[3], total_pence: v[4], status: "creating" };
        invoices.push(row);
        return [{ id: row.id }];
      }
      if (q.startsWith("SELECT email FROM client_users")) return [{ email: "owner@x.co" }];
      if (q.startsWith("UPDATE clients SET stripe_customer_id")) { clients.find((c) => c.id === v[1]).stripe_customer_id ||= v[0]; return []; }
      if (q.startsWith("SELECT stripe_customer_id FROM clients")) return [{ stripe_customer_id: clients.find((c) => c.id === v[0]).stripe_customer_id }];
      if (q.startsWith("UPDATE invoices SET status = ?, stripe_invoice_id")) {
        Object.assign(invoices.find((i) => i.id === v[3]), { status: v[0], stripe_invoice_id: v[1], hosted_url: v[2] });
        return [];
      }
      if (q.startsWith("DELETE FROM invoices WHERE id = ? AND status = 'creating'")) {
        invoices = invoices.filter((i) => !(i.id === v[0] && i.status === "creating"));
        return [];
      }
      if (q.startsWith("SELECT id, status, stripe_invoice_id, client_id, period FROM invoices")) return invoices.filter((i) => i.id === v[0]);
      if (q.startsWith("UPDATE invoices SET status = 'open'")) { const i = invoices.find((x) => x.id === v[1]); if (i?.status === "draft") { i.status = "open"; i.hosted_url = v[0]; } return []; }
      if (q.startsWith("UPDATE clients SET payment_ready")) { customerSets.push(v[0]); return []; }
      if (q.startsWith("UPDATE invoices SET status = ?, hosted_url = COALESCE")) {
        const i = invoices.find((x) => x.stripe_invoice_id === v[5]);
        if (i && (!i.event_at || i.event_at <= v[6])) { i.status = v[0]; i.event_at = v[6]; }
        return [];
      }
      throw new Error("Unexpected query in test: " + q.slice(0, 80));
    },
  };
}

beforeEach(() => {
  invoices = []; stripeCalls = []; stripeFail = false; customerSets = [];
  clients = [{ id: 1, name: "Joe", price: 2500, stripe_customer_id: null, payment_ready: true }];
  figures = { 1: { billable: 4, open_disputes: 0 } };
  for (const k of Object.keys(env)) delete env[k];
  env.STRIPE_SECRET_KEY = "sk_test_x";
  globalThis.fetch = async (url, opts) => {
    stripeCalls.push(`${opts.method} ${url.replace("https://api.stripe.com/v1/", "")}`);
    if (stripeFail && url.endsWith("/invoices")) return new Response(JSON.stringify({ error: { message: "boom" } }), { status: 500 });
    const id = url.split("/v1/")[1].split("/")[0];
    return new Response(JSON.stringify({ id: `${id}_1`, hosted_invoice_url: "https://invoice.stripe.com/i/x" }), { status: 200 });
  };
});

const run = (opts = {}) => runBilling(fakeDb(), { today: "2026-11-10", ...opts });

test("creates one draft invoice per client per month, and never a second", async () => {
  const a = await run();
  assert.equal(a.drafts, 1);
  assert.equal(invoices[0].status, "draft");
  assert.equal(invoices[0].total_pence, 10000);
  const before = stripeCalls.length;
  const b = await run();
  assert.equal(b.drafts + b.created, 0);
  assert.equal(invoices.length, 1);
  assert.equal(stripeCalls.length, before, "second run made no Stripe calls");
});

test("does nothing before the billing day, or when Stripe isn't set up", async () => {
  assert.equal((await runBilling(fakeDb(), { today: "2026-11-05" })).notDue, true);
  assert.equal(invoices.length, 0);
  delete env.STRIPE_SECRET_KEY;
  assert.equal((await run()).stripeOff, true);
});

test("auto mode finalises straight away", async () => {
  env.BILLING_MODE = "auto";
  const r = await run();
  assert.equal(r.created, 1);
  assert.equal(invoices[0].status, "open");
  assert.ok(stripeCalls.some((c) => c.includes("/finalize")));
});

test("a Stripe failure bills nobody and frees the month to retry", async () => {
  stripeFail = true;
  const r = await run();
  assert.equal(r.failed.length, 1);
  assert.equal(invoices.length, 0);
  stripeFail = false;
  assert.equal((await run()).drafts, 1);
});

test("open disputes, a missing price and an open dispute window hold the invoice", async () => {
  figures[1] = { billable: 4, open_disputes: 1 };
  assert.match((await run()).held[0].reason, /dispute/);
  figures[1] = { billable: 4, open_disputes: 0 };
  clients[0].price = null;
  assert.match((await run()).held[0].reason, /price/i);
  clients[0].price = 2500;
  assert.equal((await run({ period: "2026-11" })).held.length, 1, "month just ended: window still open");
  assert.equal(invoices.length, 0);
});

test("zero enquiries is recorded as skipped, not invoiced", async () => {
  figures[1] = { billable: 0, open_disputes: 0 };
  const r = await run();
  assert.equal(r.skipped, 1);
  assert.equal(invoices[0].status, "skipped");
  assert.equal(stripeCalls.length, 0);
});

test("a client without a saved payment method gets a pay-online invoice", async () => {
  clients[0].payment_ready = false;
  let body = "";
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, opts) => { if (url.endsWith("/invoices")) body = opts.body; return orig(url, opts); };
  await run();
  assert.match(body, /collection_method=send_invoice/);
});

test("approving a draft finalises it once", async () => {
  await run();
  const db = fakeDb();
  assert.deepEqual(await approveInvoice(db, 1), { ok: true });
  assert.equal(invoices[0].status, "open");
  assert.equal((await approveInvoice(db, 1)).status, 409);
});

test("a late 'failed' event cannot undo a newer 'paid'", async () => {
  invoices = [{ id: 1, client_id: 1, period: "2026-10", status: "open", stripe_invoice_id: "in_1" }];
  const db = fakeDb();
  await handleStripeEvent(db, { type: "invoice.paid", created: 2000, data: { object: { id: "in_1" } } });
  await handleStripeEvent(db, { type: "invoice.payment_failed", created: 1000, data: { object: { id: "in_1" } } });
  assert.equal(invoices[0].status, "paid");
});

test("saving a payment method marks the client ready and makes it the default", async () => {
  await handleStripeEvent(fakeDb(), { type: "setup_intent.succeeded", created: 1, data: { object: { customer: "cus_1", payment_method: "pm_1" } } });
  assert.deepEqual(customerSets, ["cus_1"]);
  assert.ok(stripeCalls.some((c) => c === "POST customers/cus_1"));
});
