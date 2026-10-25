// Automated billing through Stripe. Works in test mode until you swap in a live key.
//
//  - Each client saves a card or Direct Debit once (Stripe Checkout, "setup" mode).
//  - Each month we count their genuine enquiries and make ONE invoice (the database guarantees it).
//  - BILLING_MODE=approve (default): the invoice is a draft until an admin approves it.
//    BILLING_MODE=auto: it is finalised and collected straight away.
//  - Stripe emails the invoice, retries failed payments and tells us what happened via the webhook.

import { monthRange, planInvoice, billingPeriod, monthLabel, stripeForm, toInt, clean } from "./util.mjs";

export const stripeOn = () => !!Netlify.env.get("STRIPE_SECRET_KEY");
export const billingMode = () => (Netlify.env.get("BILLING_MODE") === "auto" ? "auto" : "approve");
export const disputeDays = () => toInt(Netlify.env.get("BILLING_DISPUTE_DAYS"), { min: 0, max: 30 }) ?? 7;
const billingDay = () => toInt(Netlify.env.get("BILLING_DAY"), { min: 1, max: 28 }) ?? 8;
const baseUrl = () => (Netlify.env.get("PUBLIC_BASE_URL") || "https://alpha-analytica.netlify.app").replace(/\/$/, "");

export async function stripeApi(path, { method = "POST", form, idempotencyKey } = {}) {
  const key = Netlify.env.get("STRIPE_SECRET_KEY");
  if (!key) throw new Error("Stripe isn't set up yet (STRIPE_SECRET_KEY missing).");
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    method,
    headers: {
      authorization: `Bearer ${key}`,
      ...(form ? { "content-type": "application/x-www-form-urlencoded" } : {}),
      ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
    },
    body: form ? stripeForm(form).toString() : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Stripe ${res.status}: ${data?.error?.message || "error"}`);
  return data;
}

/** Make (once) the Stripe customer for a client and return its id. */
async function ensureCustomer(db, client) {
  if (client.stripe_customer_id) return client.stripe_customer_id;
  const [u] = await db.sql`SELECT email FROM client_users WHERE client_id = ${client.id} ORDER BY email LIMIT 1`;
  const customer = await stripeApi("customers", {
    form: { name: client.name, email: u?.email, metadata: { client_id: client.id } },
    idempotencyKey: `customer-${client.id}`,
  });
  // first writer wins if two requests race
  await db.sql`UPDATE clients SET stripe_customer_id = ${customer.id} WHERE id = ${client.id} AND stripe_customer_id IS NULL`;
  const [row] = await db.sql`SELECT stripe_customer_id FROM clients WHERE id = ${client.id}`;
  return row.stripe_customer_id;
}

/** A Stripe-hosted page where the client saves a card or Direct Debit. Returns its URL. */
export async function createPaymentSetup(db, client) {
  const customer = await ensureCustomer(db, client);
  const session = await stripeApi("checkout/sessions", {
    form: {
      mode: "setup", customer, currency: "gbp",
      payment_method_types: ["card", "bacs_debit"],
      success_url: `${baseUrl()}/portal/?payment=done`,
      cancel_url: `${baseUrl()}/portal/?payment=cancelled`,
      metadata: { client_id: client.id },
    },
  });
  if (!session.url) throw new Error("Stripe didn't return a payment page.");
  return session.url;
}

/** Enquiries billable for a client in a month, and any disputes still open. */
async function monthFigures(db, clientId, period) {
  const range = monthRange(period);
  const [r] = await db.sql`
    SELECT COUNT(*) FILTER (WHERE status <> 'spam' AND dispute_state IS DISTINCT FROM 'open')::int AS billable,
           COUNT(*) FILTER (WHERE dispute_state = 'open')::int AS open_disputes
    FROM leads WHERE client_id = ${clientId} AND received_at >= ${range[0]} AND received_at < ${range[1]}`;
  return r;
}

/**
 * Invoice every client for `period` (default: last month), once each. Safe to run every day:
 * clients already invoiced are skipped, and clients that must wait (open disputes, no price) are retried next run.
 */
export async function runBilling(db, { today = new Date().toISOString().slice(0, 10), period: forcedPeriod = null, force = false } = {}) {
  const result = { period: null, created: 0, drafts: 0, held: [], skipped: 0, failed: [], notDue: false, stripeOff: !stripeOn() };
  const plan = billingPeriod(today, billingDay());
  const period = forcedPeriod || plan.period;
  result.period = period;
  if (result.stripeOff) return result;
  if (!force && !forcedPeriod && !plan.due) { result.notDue = true; return result; }
  const range = monthRange(period);
  if (!range) { result.failed.push({ client: "-", error: "Bad month" }); return result; }

  const windowEnds = Date.parse(`${range[1]}T00:00:00Z`) + disputeDays() * 86400000;
  const windowOpen = Date.parse(`${today}T12:00:00Z`) < windowEnds;
  const mode = billingMode();

  const clients = await db.sql`
    SELECT c.id, c.name, c.price_per_enquiry_pence AS price, c.stripe_customer_id, c.payment_ready
    FROM clients c
    WHERE NOT EXISTS (SELECT 1 FROM invoices i WHERE i.client_id = c.id AND i.period = ${period})
    ORDER BY c.id`;

  for (const c of clients) {
    try {
      const f = await monthFigures(db, c.id, period);
      const decision = planInvoice({ billable: f.billable, price: c.price, openDisputes: f.open_disputes, windowOpen });
      if (decision.action === "hold") { result.held.push({ client: c.name, reason: decision.reason }); continue; }
      if (decision.action === "skip") {
        await db.sql`INSERT INTO invoices (client_id, period, quantity, unit_pence, total_pence, status, note)
                     VALUES (${c.id}, ${period}, 0, ${c.price ?? 0}, 0, 'skipped', ${decision.reason}) ON CONFLICT DO NOTHING`;
        result.skipped++;
        continue;
      }

      // Reserve the month first. If this insert loses a race, someone else is already billing this client.
      const [row] = await db.sql`
        INSERT INTO invoices (client_id, period, quantity, unit_pence, total_pence, status)
        VALUES (${c.id}, ${period}, ${decision.quantity}, ${decision.unit_pence}, ${decision.total_pence}, 'creating')
        ON CONFLICT DO NOTHING RETURNING id`;
      if (!row) continue;

      try {
        const customer = await ensureCustomer(db, c);
        const idem = `invoice-${c.id}-${period}`;
        const taxRate = Netlify.env.get("STRIPE_TAX_RATE_ID");
        // A client with no saved payment method still gets an invoice they can pay online within 14 days.
        const collect = c.payment_ready
          ? { collection_method: "charge_automatically" }
          : { collection_method: "send_invoice", days_until_due: 14 };
        await stripeApi("invoiceitems", {
          form: {
            customer, currency: "gbp", quantity: decision.quantity, unit_amount: decision.unit_pence,
            description: `Genuine enquiries, ${monthLabel(period)}`,
            ...(taxRate ? { tax_rates: [taxRate] } : {}),
            metadata: { client_id: c.id, period },
          },
          idempotencyKey: `${idem}-item`,
        });
        const inv = await stripeApi("invoices", {
          form: {
            customer, ...collect, auto_advance: false, pending_invoice_items_behavior: "include", currency: "gbp",
            description: `Alpha Analytica: genuine enquiries, ${monthLabel(period)}`,
            metadata: { client_id: c.id, period },
          },
          idempotencyKey: `${idem}-invoice`,
        });
        let status = "draft";
        let hosted = null;
        if (mode === "auto") {
          const fin = await stripeApi(`invoices/${inv.id}/finalize`, { form: { auto_advance: true }, idempotencyKey: `${idem}-finalize` });
          status = "open";
          hosted = fin.hosted_invoice_url || null;
        }
        await db.sql`UPDATE invoices SET status = ${status}, stripe_invoice_id = ${inv.id}, hosted_url = ${hosted} WHERE id = ${row.id}`;
        if (status === "draft") result.drafts++; else result.created++;
      } catch (e) {
        // Nothing was billed: free the month so tomorrow's run tries again, and say why.
        await db.sql`DELETE FROM invoices WHERE id = ${row.id} AND status = 'creating'`;
        throw e;
      }
    } catch (e) {
      console.error("billing failed for", c.name, e);
      result.failed.push({ client: c.name, error: String(e.message || e).slice(0, 200) });
    }
  }
  return result;
}

/** An admin approves a draft: Stripe finalises it and starts collecting. */
export async function approveInvoice(db, invoiceId) {
  const [inv] = await db.sql`SELECT id, status, stripe_invoice_id, client_id, period FROM invoices WHERE id = ${invoiceId}`;
  if (!inv) return { error: "Invoice not found.", status: 404 };
  if (inv.status !== "draft" || !inv.stripe_invoice_id) return { error: "Only draft invoices can be approved.", status: 409 };
  const fin = await stripeApi(`invoices/${inv.stripe_invoice_id}/finalize`, {
    form: { auto_advance: true }, idempotencyKey: `invoice-${inv.client_id}-${inv.period}-finalize`,
  });
  await db.sql`UPDATE invoices SET status = 'open', hosted_url = ${fin.hosted_invoice_url || null} WHERE id = ${inv.id} AND status = 'draft'`;
  return { ok: true };
}

/** Throw away a draft (for example when you spot a mistake). Nothing is charged. */
export async function discardInvoice(db, invoiceId) {
  const [inv] = await db.sql`SELECT id, status, stripe_invoice_id FROM invoices WHERE id = ${invoiceId}`;
  if (!inv) return { error: "Invoice not found.", status: 404 };
  if (inv.status !== "draft") return { error: "Only draft invoices can be discarded.", status: 409 };
  if (inv.stripe_invoice_id) await stripeApi(`invoices/${inv.stripe_invoice_id}`, { method: "DELETE" });
  await db.sql`DELETE FROM invoices WHERE id = ${inv.id} AND status = 'draft'`; // the month can be billed again
  return { ok: true };
}

/** React to something Stripe tells us. Safe to receive twice, and in any order. */
export async function handleStripeEvent(db, event) {
  const obj = event?.data?.object;
  if (!obj) return { ignored: true };
  const at = new Date((event.created || 0) * 1000).toISOString();

  if (event.type === "setup_intent.succeeded" && obj.customer && obj.payment_method) {
    // make it the card/mandate used for future invoices
    await stripeApi(`customers/${obj.customer}`, { form: { invoice_settings: { default_payment_method: obj.payment_method } } });
    await db.sql`UPDATE clients SET payment_ready = TRUE WHERE stripe_customer_id = ${obj.customer}`;
    return { ok: true };
  }

  const map = { "invoice.finalized": "open", "invoice.paid": "paid", "invoice.payment_succeeded": "paid", "invoice.payment_failed": "failed", "invoice.voided": "void", "invoice.marked_uncollectible": "failed" };
  const status = map[event.type];
  if (status && obj.id) {
    // only apply if newer than what we already know, so a late "failed" can't undo a "paid"
    await db.sql`
      UPDATE invoices SET status = ${status}, hosted_url = COALESCE(${obj.hosted_invoice_url || null}, hosted_url),
        paid_at = CASE WHEN ${status} = 'paid' THEN COALESCE(paid_at, ${at}::timestamptz) ELSE paid_at END,
        stripe_event_at = ${at}::timestamptz
      WHERE stripe_invoice_id = ${obj.id} AND (stripe_event_at IS NULL OR stripe_event_at <= ${at}::timestamptz)`;
    return { ok: true };
  }
  return { ignored: true };
}
