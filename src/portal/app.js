// Alpha Analytica client portal (browser code). Bundled by scripts/build.mjs.
// Rule for this file: every piece of data that came from outside (leads, names,
// URLs, report text) goes through esc() / safeHref() before it reaches the page.

import {
  login, logout, getUser, handleAuthCallback, acceptInvite, requestPasswordRecovery, updateUser,
} from "@netlify/identity";

const app = document.getElementById("app");

const state = {
  screen: "loading", // loading | login | forgot | setpw | portal
  me: null,
  data: null, // the portal data for the business being shown
  tab: "overview",
  viewAs: null, // admin only: client id being viewed
  adminClients: null,
  attention: null,
  billing: null, // { month, rows }
  adminView: "overview", // overview | enquiries | calls | performance | clients | billing
  prospects: null, // admin prospecting list
  prospectOpen: new Set(), // which prospect scripts are open
  prospectFilter: "active",
  ov: null, // admin overview data
  feed: { leads: null, more: false, filters: {} }, // admin enquiry feed
  callsList: { calls: null, more: false, filters: {} }, // admin call list
  callOpen: null, // admin: the call being read
  perf: null, // admin performance data
  invoices: null, // admin: invoices needing attention
  disputes: null, // admin: open enquiry disputes
  billingMonth: new Date().toISOString().slice(0, 7),
  adminDetail: null, // { client, users, steps }
  newClient: { values: {}, errors: {} }, // the add-client form: what was typed, and what to fix
  flash: null, // { type: "ok" | "err", text }
  setpw: null, // { kind: "invite" | "recovery", token }
};

/* ---------- small helpers ---------- */

const esc = (v) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const safeHref = (u) => {
  try {
    const x = new URL(u);
    return x.protocol === "https:" || x.protocol === "http:" ? esc(x.toString()) : "";
  } catch {
    return "";
  }
};

const gbp = new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" });
const money = (pence) => gbp.format((pence || 0) / 100);
const fmtDate = (d) => {
  const x = new Date(d);
  return Number.isNaN(x.getTime()) ? "" : x.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
};
const dayKey = (d) => String(d).slice(0, 10);
const todayKey = () => new Date().toISOString().slice(0, 10);

class ApiError extends Error {
  constructor(message, status, errors) {
    super(message);
    this.status = status;
    this.errors = errors || [];
  }
}

async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
    credentials: "same-origin",
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* no body */
  }
  if (!res.ok) throw new ApiError((json && json.error) || "Something went wrong. Please try again.", res.status, json && json.errors);
  return json;
}

function flash(type, text) {
  state.flash = { type, text };
}

/** Run an action; on failure show the message. A 401 sends the person back to log in. */
async function attempt(fn) {
  try {
    await fn();
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) {
      state.screen = "login";
      flash("err", "Your session has ended. Please log in again.");
    } else {
      flash("err", e.message || "Something went wrong. Please try again.");
    }
  }
  render();
}

/* ---------- screens ---------- */

function brand() {
  return `<div class="brand"><span class="mark" aria-hidden="true">α</span><span class="brand-name">Alpha Analytica</span></div>`;
}

function authShell(inner) {
  return `<div class="auth">
    <aside class="auth-art" aria-hidden="true">
      ${brand()}
      <div class="auth-copy">
        <p class="auth-big">Every enquiry, call and pound, in one place.</p>
        <p class="auth-small">Your website, your ads and your weekly report, in plain English.</p>
      </div>
      <svg class="auth-rings" viewBox="0 0 200 200"><circle cx="100" cy="100" r="92" /><circle cx="100" cy="100" r="64" /><circle cx="100" cy="100" r="36" /><circle cx="100" cy="100" r="9" class="core" /></svg>
    </aside>
    <section class="auth-card">
      <div class="auth-mobile-brand">${brand()}</div>
      ${inner}
    </section>
  </div>`;
}

function flashHtml() {
  if (!state.flash) return "";
  const f = state.flash;
  return `<div class="msg ${f.type === "ok" ? "ok" : "err"}" role="${f.type === "ok" ? "status" : "alert"}">${esc(f.text)}</div>`;
}

function screenLogin() {
  return authShell(`
    <h1>Client login</h1>
    <p class="sub">See how your website and ads are doing.</p>
    ${flashHtml()}
    <form class="form" data-form="login">
      <div class="field"><label for="email">Email</label><input id="email" name="email" type="email" autocomplete="username" required></div>
      <div class="field"><label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required></div>
      <button class="btn btn-primary" type="submit">Log in</button>
    </form>
    <p class="links"><button class="linkbtn" data-action="to-forgot" type="button">Forgot your password?</button></p>
  `);
}

function screenForgot() {
  return authShell(`
    <h1>Reset your password</h1>
    <p class="sub">Enter your email and we'll send you a link.</p>
    ${flashHtml()}
    <form class="form" data-form="forgot">
      <div class="field"><label for="email">Email</label><input id="email" name="email" type="email" autocomplete="username" required></div>
      <button class="btn btn-primary" type="submit">Send link</button>
    </form>
    <p class="links"><button class="linkbtn" data-action="to-login" type="button">Back to log in</button></p>
  `);
}

function screenSetPassword() {
  const invite = state.setpw && state.setpw.kind === "invite";
  return authShell(`
    <h1>${invite ? "Welcome. Set your password" : "Choose a new password"}</h1>
    <p class="sub">Use at least 8 characters.</p>
    ${flashHtml()}
    <form class="form" data-form="setpw">
      <div class="field"><label for="pw">Password</label><input id="pw" name="password" type="password" autocomplete="new-password" minlength="8" required></div>
      <button class="btn btn-primary" type="submit">Save password</button>
    </form>
  `);
}

const ICONS = {
  overview: '<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>',
  website: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z"/>',
  leads: '<path d="M3 13l2.6-7.1A2 2 0 0 1 7.5 4.6h9a2 2 0 0 1 1.9 1.3L21 13"/><path d="M3 13v5a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5h-5.2a3 3 0 0 1-2.8 2h-2a3 3 0 0 1-2.8-2z"/>',
  calls: '<path d="M21 16.5v3a2 2 0 0 1-2.2 2A19 19 0 0 1 2.5 5.2 2 2 0 0 1 4.5 3h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8.4 10.8a16 16 0 0 0 4.8 4.8l1.2-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z"/>',
  ads: '<path d="M3 17l6-6 4 4 8-8"/><path d="M15 7h6v6"/>',
  reports: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M9 13h6M9 17h6"/>',
  billing: '<rect x="2.5" y="5" width="19" height="14" rx="2.5"/><path d="M2.5 10h19"/><path d="M6.5 15h3"/>',
  admin: '<path d="M12 3l8 3v6c0 4.5-3.2 8.2-8 9.5C7.2 20.2 4 16.5 4 12V6z"/><path d="M9 12l2 2 4-4"/>',
};
function icon(id) {
  return `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">${ICONS[id] || ""}</svg>`;
}

const TABS = [
  ["overview", "Overview"],
  ["website", "Website"],
  ["leads", "Enquiries"],
  ["calls", "Calls"],
  ["ads", "Ads"],
  ["reports", "Reports"],
  ["billing", "Billing"],
];

function screenPortal() {
  const me = state.me;
  const tabs = me.isAdmin ? [...TABS, ["admin", "Admin"]] : TABS;
  const viewing = state.viewAs && state.data ? state.data.client.name : null;

  let body;
  if (state.tab === "admin") body = viewAdmin();
  else if (!state.data) {
    body = `<div class="panel"><h2>Your login isn't linked to a business yet</h2>
      <p class="muted">We'll connect it shortly. If you think this is a mistake, get in touch with Alpha Analytica.</p></div>`;
  } else {
    body = { overview: viewOverview, website: viewWebsite, leads: viewLeads, calls: viewCalls, ads: viewAds, reports: viewReports, billing: viewBilling }[state.tab]();
  }

  const item = ([id, label]) => `<button class="nav-item" data-action="tab" data-tab="${id}" ${state.tab === id ? 'aria-current="page"' : ""} type="button">${icon(id)}<span>${label}</span></button>`;
  return `<div class="shell">
    <aside class="side">
      <div class="side-top">${brand()}</div>
      <nav class="nav" aria-label="Portal sections">
        ${TABS.map(item).join("")}
        ${me.isAdmin ? `<div class="nav-sep"><span>Alpha Analytica team</span></div>${item(["admin", "Admin"])}` : ""}
      </nav>
      <div class="side-foot">
        <span class="side-email" title="${esc(me.email)}">${esc(me.email)}</span>
        <button class="side-out" data-action="logout" type="button">Log out</button>
      </div>
    </aside>
    <main class="main" id="main">
      ${viewing ? `<div class="banner"><span>Viewing as <b>${esc(viewing)}</b></span><button class="btn btn-ghost btn-small" data-action="stop-view" type="button">Back to admin</button></div>` : ""}
      ${flashHtml()}
      ${body}
    </main>
  </div>`;
}

/* ---------- client views ---------- */

/** Which ad platform an enquiry came from: the source label, or an ad click id captured with it. */
function adPlatform({ source, has_gclid, has_fb }) {
  const s = String(source || "");
  if (/google|adwords|cpc/i.test(s) || has_gclid) return "google";
  if (/facebook|^fb$|instagram|meta/i.test(s) || has_fb) return "meta";
  return null;
}

function summarise(d) {
  const now = Date.now();
  const day = 86400000;
  const real = d.leads.filter((l) => l.status !== "spam");
  const last7 = real.filter((l) => now - new Date(l.received_at) < 7 * day).length;
  const last30 = real.filter((l) => now - new Date(l.received_at) < 30 * day).length;
  const cutoff = new Date(now - 30 * day).toISOString().slice(0, 10);
  const stats30 = d.stats.filter((s) => dayKey(s.day) >= cutoff);
  const spend = stats30.reduce((a, s) => a + s.spend_pence, 0);
  // Count enquiries ourselves (genuine ones, credited to an ad) rather than trusting each platform's own count,
  // which can include other conversion actions and disagree with what's billed.
  const byAd = { google: 0, meta: 0 };
  for (const l of real) {
    if (now - new Date(l.received_at) >= 30 * day) continue;
    const p = adPlatform(l);
    if (p) byAd[p]++;
  }
  const adEnquiries = byAd.google + byAd.meta;
  const done = d.steps.filter((s) => s.status === "done").length;
  const next = d.steps.find((s) => s.status !== "done") || null;
  return { last7, last30, spend, adEnquiries, byAd, done, total: d.steps.length, next, stats30 };
}

function viewOverview() {
  const d = state.data;
  const s = summarise(d);
  const cpe = s.adEnquiries > 0 ? money(s.spend / s.adEnquiries) : "Not yet";
  const latest = d.reports[0];
  return `<div class="pagehead"><h1>${esc(d.client.name)}</h1><p>Here's where things stand.</p></div>
    <div class="tiles">
      <div class="tile"><div class="n">${s.done} of ${s.total}</div><div class="l">website steps done</div></div>
      <div class="tile key"><div class="n">${s.last7}</div><div class="l">enquiries in the last 7 days</div></div>
      <div class="tile"><div class="n">${s.last30}</div><div class="l">enquiries in the last 30 days</div></div>
      <div class="tile"><div class="n">${cpe}</div><div class="l">cost per enquiry, last 30 days</div></div>
    </div>
    <div class="panel"><h2>What's next</h2>
      ${s.next
        ? `<p><b>${esc(s.next.title)}</b></p><p class="muted">${esc(s.next.detail || "")}</p>`
        : `<p><b>Everything is done.</b></p><p class="muted">Your website and campaigns are live. Check Reports each Monday.</p>`}
    </div>
    <div class="panel"><h2>Latest report</h2>
      ${latest
        ? `<p><b>${esc(latest.title)}</b> <span class="muted">· ${esc(fmtDate(latest.week_start))}</span></p><p class="muted small">Open the Reports tab to read it.</p>`
        : `<p class="muted">Your first report will appear here on a Monday after your campaigns go live.</p>`}
    </div>`;
}

function viewWebsite() {
  const d = state.data;
  const preview = safeHref(d.client.preview_url);
  const live = safeHref(d.client.website_url);
  return `<div class="pagehead"><h1>Your website</h1><p>Follow the build step by step. Nothing goes live without your approval.</p></div>
    ${preview || live ? `<div class="banner"><span>${preview ? "Your preview is ready to look at." : "Your website is live."}</span>
      <span>${preview ? `<a class="btn btn-primary btn-small" href="${preview}" target="_blank" rel="noopener noreferrer">Open preview</a>` : ""}
      ${live ? `<a class="btn btn-ghost btn-small" href="${live}" target="_blank" rel="noopener noreferrer">Open live site</a>` : ""}</span></div>` : ""}
    <div class="panel"><ol class="steps">
      ${d.steps.map((st, i) => `<li class="step ${esc(st.status)}">
        <span class="dot" aria-hidden="true">${st.status === "done" ? "✓" : i + 1}</span>
        <div><h3>${esc(st.title)}</h3><p>${esc(st.detail || "")}</p></div>
        <span class="chip ${esc(st.status)}">${{ todo: "To do", doing: "In progress", done: "Done" }[st.status] || ""}</span>
      </li>`).join("")}
    </ol></div>` + intakePanel();
}

const STATUS_LABEL = { new: "New", qualified: "Good enquiry", customer: "Became a customer", spam: "Not a real enquiry" };

function disputeCell(l, b) {
  if (l.dispute_state === "open") return `<span class="chip doing">Dispute under review</span>`;
  if (l.dispute_state === "accepted") return `<span class="chip done">Dispute accepted, not billed</span>`;
  if (l.dispute_state === "rejected") return `<span class="chip">Dispute declined</span>`;
  if (l.status === "spam") return `<span class="muted small">Not billed</span>`;
  if (!l.can_dispute) return "";
  return `<label class="sr-only" for="dp${l.id}">Dispute this enquiry</label>
    <select id="dp${l.id}" class="lead-select" data-action="dispute" data-id="${l.id}">
      <option value="">Dispute…</option>
      ${Object.entries(b.reasons || {}).map(([v, t]) => `<option value="${esc(v)}">${esc(t)}</option>`).join("")}
    </select>`;
}

function viewLeads() {
  const d = state.data;
  const b = d.billing || {};
  const outcomes = Object.entries(STATUS_LABEL).filter(([v]) => v !== "spam");
  const rows = d.leads.map((l) => `<tr>
      <td>${esc(fmtDate(l.received_at))}</td>
      <td><b>${esc(l.name || "No name")}</b><br><span class="muted small">${esc([l.phone, l.email].filter(Boolean).join(" · "))}</span></td>
      <td><div class="lead-msg">${esc(l.message || "")}</div></td>
      <td>${esc(l.source || "Website")}${l.type === "call" ? " (call)" : ""}</td>
      <td>${l.status === "spam" ? `<span class="chip spam">Not a real enquiry</span>` : `<label class="sr-only" for="ls${l.id}">Status</label>
        <select id="ls${l.id}" class="lead-select" data-action="lead-status" data-id="${l.id}">
          ${outcomes.map(([v, t]) => `<option value="${v}" ${l.status === v ? "selected" : ""}>${t}</option>`).join("")}
        </select>`}</td>
      <td>${disputeCell(l, b)}</td>
    </tr>`).join("");
  return `<div class="pagehead"><h1>Enquiries</h1>
      <p>Every enquiry from your website, newest first. Tell us which ones were good and which became customers. It helps us send you better ones.${b.disputeDays ? ` If one wasn't genuine, dispute it within ${b.disputeDays} days and we'll review it before you're billed.` : ""}</p></div>
    <div class="panel">
      ${d.leads.length
        ? `<div class="tablewrap"><table><thead><tr><th>Date</th><th>Who</th><th>Message</th><th>Came from</th><th>Outcome</th><th>Not genuine?</th></tr></thead><tbody>${rows}</tbody></table></div>`
        : `<p class="muted">No enquiries yet. They'll appear here the moment someone gets in touch.</p>`}
    </div>`;
}

const INVOICE_CHIP = { open: ["doing", "Due"], paid: ["done", "Paid"], failed: ["spam", "Payment failed"], void: ["", "Cancelled"], draft: ["", "Draft"] };
const payHref = (u) => { const h = safeHref(u); return h && /^https:\/\/[a-z0-9.-]*stripe\.com\//i.test(h) ? h : null; };

function viewBilling() {
  const b = state.data.billing || {};
  const rows = (b.invoices || []).map((i) => {
    const [cls, label] = INVOICE_CHIP[i.status] || ["", i.status];
    const href = payHref(i.hosted_url);
    return `<tr><td>${esc(i.period)}</td><td class="num">${i.quantity} × ${money(i.unit_pence)}</td><td class="num">${money(i.total_pence)}</td>
      <td><span class="chip ${cls}">${esc(label)}</span></td>
      <td>${href ? `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${i.status === "open" || i.status === "failed" ? "View and pay" : "View"}</a>` : ""}</td></tr>`;
  }).join("");
  return `<div class="pagehead"><h1>Billing</h1><p>You only pay for genuine enquiries. We invoice once a month for the month before.</p></div>
    <div class="panel"><h2>Payment method</h2>
      ${!b.stripeOn ? `<p class="muted">Online payment is being set up. We'll let you know when you can add your details.</p>`
        : b.paymentReady
          ? `<p><span class="chip done">Saved</span> We'll collect each month's invoice automatically. You'll get an email each time.</p>
             <p><button class="btn btn-ghost btn-small" data-action="payment-setup" type="button">Change payment method</button></p>`
          : `<p><span class="chip doing">Needed</span> Add a card or UK Direct Debit once and invoices are paid automatically.</p>
             <p><button class="btn btn-primary" data-action="payment-setup" type="button">Set up payment</button></p>`}
      <p class="muted small">Payments are handled by Stripe. We never see or store your card or bank details.</p>
    </div>
    <div class="panel"><h2>Invoices</h2>
      ${rows ? `<div class="tablewrap"><table><thead><tr><th>Month</th><th class="num">Enquiries</th><th class="num">Total</th><th>Status</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`
        : `<p class="muted">No invoices yet. Your first one arrives after your first full month.</p>`}
    </div>`;
}

const CALL_STATUS = { completed: "Answered", "no-answer": "Not answered", busy: "Engaged", failed: "Failed", canceled: "Missed", ringing: "In progress" };

function fmtDuration(sec) {
  if (sec === null || sec === undefined) return "–";
  return sec >= 60 ? `${Math.floor(sec / 60)}m ${sec % 60}s` : `${sec}s`;
}

function phoneForm(hasNumber) {
  return `<div class="panel"><h2>${hasNumber ? "Change where calls go" : "Set up call tracking"}</h2>
      <p class="muted small">${hasNumber
        ? "Enter the phone number you'd like your calls to ring."
        : "Enter the phone number you answer your business calls on, then press Set up. We'll create your tracking number and forward every call to you."}</p>
      <form class="form" data-form="setup-phone">
        <div class="field"><label for="ph">Your phone number</label><input id="ph" name="phone" type="tel" inputmode="tel" autocomplete="tel" required maxlength="30" placeholder="07700 900123"></div>
        <button class="btn btn-primary" type="submit">${hasNumber ? "Save" : "Set up"}</button>
      </form></div>`;
}

function viewCalls() {
  const d = state.data;
  const head = `<div class="pagehead"><h1>Calls</h1><p>Every call from your ads and website, counted.</p></div>`;
  if (!d.numbers.length && !d.calls.length) {
    return head + `<div class="soon"><h2>Call tracking isn't switched on yet</h2>
      <p class="muted">Once it is, you'll get a tracking phone number that forwards to your own phone, and every call will be logged here. This is what you'll see:</p>
      <div class="cols">
        <div class="col"><b>When</b>Date and time of the call</div>
        <div class="col"><b>Where from</b>Which ad or page the caller came from</div>
        <div class="col"><b>How long</b>Length of the call</div>
        <div class="col"><b>Answered?</b>Whether you picked up</div>
      </div></div>` + phoneForm(false);
  }
  const cutoff = Date.now() - 30 * 86400000;
  const recent = d.calls.filter((c) => new Date(c.started_at).getTime() >= cutoff);
  const answered = recent.filter((c) => c.status === "completed").length;
  const counted = recent.filter((c) => c.counted).length;
  const min = d.client.call_min_seconds;
  const rows = d.calls.map((c) => `<tr>
      <td>${esc(fmtDate(c.started_at))}</td>
      <td>${esc(c.from_number || "Withheld")}</td>
      <td>${esc(c.label || "")}</td>
      <td>${esc(CALL_STATUS[c.status] || c.status)}</td>
      <td class="num">${esc(fmtDuration(c.duration_seconds))}</td>
      <td>${c.counted ? `<span class="chip done">Counted</span>` : `<span class="muted">–</span>`}</td>
    </tr>`).join("");
  return head + `
    <div class="tiles">
      <div class="tile"><div class="n">${recent.length}</div><div class="l">calls in the last 30 days</div></div>
      <div class="tile"><div class="n">${answered}</div><div class="l">answered</div></div>
      <div class="tile"><div class="n">${counted}</div><div class="l">counted as enquiries</div></div>
    </div>
    <div class="panel"><h2>Your tracking numbers</h2>
      ${d.numbers.length ? `<ul class="checks">${d.numbers.map((n) => `<li><b>${esc(n.number)}</b> <span class="muted">(${esc(n.label)}) forwards to ${esc(n.forward_to)}</span></li>`).join("")}</ul>` : `<p class="muted">No numbers yet.</p>`}
      <p class="muted small mt">An answered call lasting at least ${esc(min)} seconds counts as an enquiry.</p>
    </div>
    ${phoneForm(true)}
    <div class="panel"><h2>Call log</h2>
      ${d.calls.length
        ? `<div class="tablewrap"><table><thead><tr><th>When</th><th>Caller</th><th>Came from</th><th>Result</th><th class="num">Length</th><th>Enquiry</th></tr></thead><tbody>${rows}</tbody></table></div>`
        : `<p class="muted">No calls yet. They'll appear here as they come in.</p>`}
    </div>`;
}

const CONN_CHIP = { none: "todo", waiting: "doing", live: "done", error: "doing" };

function connectPanel() {
  const d = state.data;
  const c = d.connections;
  const ag = d.agency || {};
  const row = (name, st) => `<li><b>${name}</b> <span class="chip ${CONN_CHIP[st.state]}">${esc(st.text)}</span></li>`;
  const missing = !d.client.google_customer_id || !d.client.meta_ad_account_id;
  return `<div class="panel"><h2>Connect your ad accounts</h2>
    <p class="muted small">Two quick invites and your results flow in automatically. You stay in control and can remove our access any time.</p>
    <ul class="checks">${row("Google Ads", c.google)}${row("Facebook and Instagram", c.meta)}</ul>
    ${missing ? `<ol class="steps small">
      <li class="step"><span class="dot" aria-hidden="true">1</span><div><h3>Google Ads</h3>
        <p>In Google Ads, open Admin, then Access and security, then Managers, and accept the link request from Alpha Analytica${ag.google_manager_id ? ` (manager id ${esc(ag.google_manager_id)})` : ""}. Then enter your 10-digit customer id below.</p></div></li>
      <li class="step"><span class="dot" aria-hidden="true">2</span><div><h3>Facebook and Instagram</h3>
        <p>In Meta Business Settings, open Partners, add a partner${ag.meta_business_id ? ` using our Business id ${esc(ag.meta_business_id)}` : ""}, and share your ad account with us. Then enter your ad account id below.</p></div></li>
    </ol>
    <form class="form" data-form="own-accounts">
      ${d.client.google_customer_id ? "" : `<div class="field"><label for="og">Google Ads customer id</label><input id="og" name="google_customer_id" placeholder="123-456-7890" maxlength="30"></div>`}
      ${d.client.meta_ad_account_id ? "" : `<div class="field"><label for="om">Facebook ad account id</label><input id="om" name="meta_ad_account_id" placeholder="1234567890" maxlength="30"></div>`}
      <button class="btn btn-primary" type="submit">Save</button>
    </form>` : ""}
  </div>`;
}

const INTAKE_LABELS = [
  ["legal_name", "Legal business name", "input"], ["address", "Business address", "input"],
  ["services", "Services you offer, with prices", "textarea"], ["area", "Area you cover", "input"],
  ["hours", "Opening hours", "input"], ["monthly_budget", "Monthly ad budget (£)", "input"],
  ["approver_name", "Who approves the website and ads?", "input"], ["contact_phone", "Phone number for enquiry calls", "input"], ["domain", "Your website address, if you have one", "input"],
  ["facebook_page", "Your Facebook page link", "input"], ["google_ads", "Do you already have a Google Ads account? (yes / no)", "input"],
  ["notes", "Anything else we should know?", "textarea"],
];

function intakePanel() {
  const v = state.data.client.intake || {};
  return `<div class="panel"><h2>Your business details</h2>
    <p class="muted small">Fill this in once and we'll have everything we need to build your site and ads.</p>
    <form class="form" data-form="intake">
      ${INTAKE_LABELS.map(([k, label, kind], i) => `<div class="field"><label for="in${i}">${label}</label>${kind === "textarea"
        ? `<textarea id="in${i}" name="${k}" maxlength="1500">${esc(v[k] || "")}</textarea>`
        : `<input id="in${i}" name="${k}" maxlength="300" value="${esc(v[k] || "")}">`}</div>`).join("")}
      <button class="btn btn-primary" type="submit">Save details</button>
    </form></div>`;
}

function viewAds() {
  const d = state.data;
  const names = { google: "Google", meta: "Facebook and Instagram" };
  const byPlatform = {};
  const sum = summarise(d);
  for (const s of sum.stats30) {
    const p = (byPlatform[s.platform] ||= { spend: 0, clicks: 0, enq: 0 });
    p.spend += s.spend_pence;
    p.clicks += s.clicks;
  }
  for (const [k, n] of Object.entries(sum.byAd)) if (byPlatform[k]) byPlatform[k].enq = n;
  const rows = Object.entries(byPlatform).map(([k, p]) => `<tr>
      <td><b>${esc(names[k] || k)}</b></td><td class="num">${money(p.spend)}</td><td class="num">${p.clicks}</td>
      <td class="num">${p.enq}</td><td class="num">${p.enq ? money(p.spend / p.enq) : "–"}</td></tr>`).join("");
  return `<div class="pagehead"><h1>Ads</h1><p>What your Google and Facebook ads did over the last 30 days.</p></div>
    <div class="panel">
      ${rows
        ? `<div class="tablewrap"><table><thead><tr><th>Platform</th><th class="num">Spend</th><th class="num">Clicks</th><th class="num">Enquiries</th><th class="num">Cost per enquiry</th></tr></thead><tbody>${rows}</tbody></table></div>
           <p class="muted small mt">Spend and clicks come from Google and Facebook. Enquiries are the genuine calls and forms in your Enquiries tab that came from each platform's ads, so they match what you're billed for.</p>`
        : `<p class="muted">Your ad results will appear here once your campaigns are live.</p>`}
    </div>` + connectPanel();
}

const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function addDaysKey(day, n) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Small bar chart as inline SVG (no styles, so it is allowed by the portal's security policy). */
function barChart(title, values, fmt) {
  const w = 320, h = 150, top = 22, bottom = 22, gap = 8;
  const max = Math.max(1, ...values);
  const bw = (w - gap * (values.length + 1)) / values.length;
  const bars = values.map((v, i) => {
    const bh = Math.round(((h - top - bottom) * v) / max);
    const x = gap + i * (bw + gap);
    const y = h - bottom - bh;
    return `<rect x="${x.toFixed(1)}" y="${y}" width="${bw.toFixed(1)}" height="${Math.max(bh, v ? 2 : 0)}" rx="3" fill="#FFB703"></rect>
      ${v ? `<text x="${(x + bw / 2).toFixed(1)}" y="${y - 5}" text-anchor="middle" font-size="10" fill="#0E1530">${esc(fmt(v))}</text>` : ""}
      <text x="${(x + bw / 2).toFixed(1)}" y="${h - 6}" text-anchor="middle" font-size="10" fill="#4F5B7A">${DAY_NAMES[i]}</text>`;
  }).join("");
  const label = `${title}: ${values.map((v, i) => `${DAY_NAMES[i]} ${fmt(v)}`).join(", ")}`;
  return `<figure class="chart"><figcaption>${esc(title)}</figcaption>
    <svg viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(label)}"><line x1="0" y1="${h - bottom}" x2="${w}" y2="${h - bottom}" stroke="#D6DBE6"></line>${bars}</svg></figure>`;
}

/** The numbers for one report's week, from the data the portal already has. */
function weekNumbers(d, weekStart) {
  const days = Array.from({ length: 7 }, (_, i) => addDaysKey(dayKey(weekStart), i));
  const idx = (k) => days.indexOf(dayKey(k));
  const enq = Array(7).fill(0), spend = Array(7).fill(0);
  let calls = 0, clicks = 0;
  for (const l of d.leads) { const i = idx(l.received_at); if (i >= 0 && l.status !== "spam") enq[i]++; }
  for (const s of d.stats) { const i = idx(s.day); if (i >= 0) { spend[i] += s.spend_pence; clicks += s.clicks; } }
  for (const c of d.calls || []) if (idx(c.started_at) >= 0) calls++;
  const totalEnq = enq.reduce((a, b) => a + b, 0), totalSpend = spend.reduce((a, b) => a + b, 0);
  return { enq, spend, calls, clicks, totalEnq, totalSpend };
}

function viewReports() {
  const d = state.data;
  return `<div class="pagehead"><h1>Reports</h1><p>A plain-English report every Monday, with the week's numbers.</p></div>
    <div class="panel no-print"><h2>What you'll get</h2><ul class="checks">
      <li><b>A weekly report</b> on what came in, what it cost and what we're changing next. We'll email you when it's ready.</li>
      <li><b>Every enquiry</b> logged in the Enquiries tab, with where it came from.</li>
      <li><b>Ad results</b> for Google and Facebook, week by week.</li>
      <li><b>Call log</b> once call tracking is switched on.</li>
    </ul></div>
    <div class="panel"><h2 class="no-print">Your reports</h2>
      ${d.reports.length
        ? d.reports.map((r, n) => {
            const w = weekNumbers(d, r.week_start);
            return `<details class="report" id="rep${r.id}" ${n === 0 ? "open" : ""}><summary><span>${esc(r.title)}</span><span class="muted">${esc(fmtDate(r.week_start))}</span></summary>
            <div class="print-only print-head"><b>Alpha Analytica</b> · ${esc(d.client.name)} · ${esc(r.title)}</div>
            <div class="tiles mt">
              <div class="tile"><div class="n">${w.totalEnq}</div><div class="l">enquiries</div></div>
              <div class="tile"><div class="n">${w.calls}</div><div class="l">phone calls</div></div>
              <div class="tile"><div class="n">${money(w.totalSpend)}</div><div class="l">ad spend</div></div>
              <div class="tile"><div class="n">${w.totalEnq ? money(w.totalSpend / w.totalEnq) : "–"}</div><div class="l">cost per enquiry</div></div>
            </div>
            <div class="charts">${barChart("Enquiries per day", w.enq, (v) => String(v))}${barChart("Ad spend per day", w.spend, (v) => money(v).replace(/\.00$/, ""))}</div>
            <div class="report-body">${esc(r.body)}</div>
            <p class="no-print"><button class="btn btn-ghost btn-small" type="button" data-action="print-report" data-id="${r.id}">Download PDF</button></p>
          </details>`;
          }).join("")
        : `<p class="muted">No reports yet. The first one arrives on the Monday after your campaigns go live.</p>`}
    </div>`;
}

/* ---------- admin views ---------- */

function billingPanel() {
  const b = state.billing;
  const rows = b ? b.rows : null;
  const total = rows ? rows.reduce((t, r) => t + (r.total_pence || 0), 0) : 0;
  return `<div class="panel"><h2>Billing</h2>
    <p class="muted small">Genuine enquiries per client for the month (everything not marked as spam). Check the "not yet reviewed" ones before you invoice.</p>
    <form class="form wide" data-form="billing-month">
      <div class="field"><label for="bm">Month</label><input id="bm" name="month" type="month" value="${esc(state.billingMonth)}" required></div>
      <button class="btn btn-ghost" type="submit">Show</button>
      <a class="btn btn-ghost" href="/api/admin/billing?month=${encodeURIComponent(state.billingMonth)}&amp;format=csv" download>Download CSV</a>
    </form>
    ${rows === null ? `<p class="muted">Loading…</p>` : `<div class="tablewrap"><table><thead><tr><th>Client</th><th class="num">Forms</th><th class="num">Calls</th><th class="num">Billable</th><th class="num">Not yet reviewed</th><th class="num">Price each</th><th class="num">Total</th></tr></thead><tbody>
      ${rows.map((r) => `<tr><td><b>${esc(r.name)}</b></td><td class="num">${r.forms}</td><td class="num">${r.calls}</td><td class="num">${r.billable}</td>
        <td class="num">${r.unreviewed}</td><td class="num">${r.price == null ? `<span class="muted">not set</span>` : money(r.price)}</td>
        <td class="num">${r.total_pence == null ? "–" : money(r.total_pence)}</td></tr>`).join("")}
      <tr><td><b>Total</b></td><td></td><td></td><td></td><td></td><td></td><td class="num"><b>${money(total)}</b></td></tr>
    </tbody></table></div>`}
  </div>`;
}

function invoicesPanel() {
  const inv = state.invoices;
  const dis = state.disputes;
  if (!inv) return `<div class="panel"><h2>Invoices and disputes</h2><p class="muted">Loading…</p></div>`;
  const chip = { draft: ["doing", "Draft: needs approval"], open: ["doing", "Sent, awaiting payment"], failed: ["spam", "Payment failed"] };
  return `<div class="panel"><h2>Invoices</h2>
    ${!inv.stripeOn ? `<p class="muted">Stripe isn't connected yet. Add <b>STRIPE_SECRET_KEY</b> and <b>STRIPE_WEBHOOK_SECRET</b> in Netlify to switch on automatic billing (see docs/SETUP.md).</p>`
      : `<p class="muted small">Mode: <b>${inv.mode === "auto" ? "fully automatic" : "you approve each invoice before it's sent"}</b>. Clients have ${inv.disputeDays} days to dispute an enquiry, then invoices are created on the 8th for the month before.</p>`}
    ${inv.invoices.length ? `<div class="tablewrap"><table><thead><tr><th>Client</th><th>Month</th><th class="num">Enquiries</th><th class="num">Total</th><th>Status</th><th></th></tr></thead><tbody>
      ${inv.invoices.map((i) => { const [c, t] = chip[i.status] || ["", i.status]; return `<tr><td><b>${esc(i.client)}</b></td><td>${esc(i.period)}</td><td class="num">${i.quantity} × ${money(i.unit_pence)}</td><td class="num">${money(i.total_pence)}</td>
        <td><span class="chip ${c}">${esc(t)}</span></td>
        <td>${i.status === "draft" ? `<button class="btn btn-primary btn-small" data-action="invoice-approve" data-id="${i.id}" type="button">Approve and send</button>
          <button class="btn btn-ghost btn-small" data-action="invoice-discard" data-id="${i.id}" type="button">Discard</button>` : ""}</td></tr>`; }).join("")}</tbody></table></div>`
      : `<p class="muted">Nothing waiting. Paid invoices are in each client's Billing tab.</p>`}
    <p class="mt"><button class="btn btn-ghost btn-small" data-action="run-job" data-job="billing" type="button">Create last month's invoices now</button></p>
  </div>
  <div class="panel"><h2>Enquiry disputes</h2>
    <p class="muted small">Clients flag enquiries that weren't genuine. Accepting one removes it from their bill. A client's invoice waits until all their disputes are decided.</p>
    ${dis && dis.disputes.length ? `<div class="tablewrap"><table><thead><tr><th>Client</th><th>Enquiry</th><th>Reason</th><th></th></tr></thead><tbody>
      ${dis.disputes.map((d) => `<tr><td><b>${esc(d.client)}</b></td>
        <td>${esc(fmtDate(d.received_at))} · ${esc(d.type)}<br><span class="muted small">${esc([d.name, d.phone, d.email].filter(Boolean).join(" · "))}</span><div class="lead-msg">${esc(d.message || "")}</div></td>
        <td>${esc((dis.reasons || {})[d.dispute_reason] || d.dispute_reason)}</td>
        <td><button class="btn btn-primary btn-small" data-action="dispute-decide" data-decision="accept" data-id="${d.id}" type="button">Accept (don't bill)</button>
          <button class="btn btn-ghost btn-small" data-action="dispute-decide" data-decision="reject" data-id="${d.id}" type="button">Reject (bill)</button></td></tr>`).join("")}</tbody></table></div>`
      : `<p class="muted">No disputes to review.</p>`}
  </div>`;
}

const ADMIN_VIEWS = [["overview", "Overview"], ["enquiries", "Enquiries"], ["calls", "Calls"], ["performance", "What's working"], ["prospects", "Prospects"], ["clients", "Clients"], ["billing", "Billing"]];

function ago(ts) {
  if (!ts) return "never";
  const m = Math.floor((Date.now() - new Date(ts).getTime()) / 60000);
  if (m < 2) return "just now";
  if (m < 60) return `${m} min ago`;
  if (m < 60 * 24) return `${Math.floor(m / 60)} h ago`;
  const d = Math.floor(m / 1440);
  return d === 1 ? "yesterday" : `${d} days ago`;
}
const pctText = (a, b) => (b > 0 ? `${Math.round((a / b) * 100)}%` : "–");
const HEALTH_CHIP = { good: ["done", "Healthy"], watch: ["doing", "Watch"], bad: ["spam", "Needs you"], new: ["", "New"] };

function trend(now, prev) {
  if (!prev && !now) return `<span class="muted">–</span>`;
  if (!prev) return `<span class="trend up">new</span>`;
  const d = Math.round(((now - prev) / prev) * 100);
  if (d === 0) return `<span class="muted">same</span>`;
  return `<span class="trend ${d > 0 ? "up" : "down"}">${d > 0 ? "▲" : "▼"} ${Math.abs(d)}%</span>`;
}

function stackedChart(series) {
  const w = 720, h = 170, top = 14, bottom = 26, left = 4;
  const max = Math.max(3, ...series.map((d) => d.forms + d.calls));
  const bw = (w - left * 2) / series.length;
  const bars = series.map((d, i) => {
    const x = left + i * bw + 1.5;
    const fh = Math.round(((h - top - bottom) * d.forms) / max);
    const ch = Math.round(((h - top - bottom) * d.calls) / max);
    const base = h - bottom;
    const label = i % 5 === 0 || i === series.length - 1 ? `<text x="${(x + bw / 2).toFixed(1)}" y="${h - 8}" text-anchor="middle" font-size="10" fill="#4F5B7A">${esc(d.day.slice(8))}/${esc(d.day.slice(5, 7))}</text>` : "";
    return `<g><title>${esc(d.day)}: ${d.forms} form, ${d.calls} call</title>
      <rect x="${x.toFixed(1)}" y="${base - fh}" width="${(bw - 3).toFixed(1)}" height="${fh}" fill="#FFB703" rx="2"></rect>
      <rect x="${x.toFixed(1)}" y="${base - fh - ch}" width="${(bw - 3).toFixed(1)}" height="${ch}" fill="#0A1128" rx="2"></rect>${label}</g>`;
  }).join("");
  const label = `Enquiries per day, last 30 days: ${series.map((d) => `${d.day} ${d.forms + d.calls}`).join(", ")}`;
  return `<figure class="chart wide"><figcaption>Enquiries per day, last 30 days
      <span class="legend"><i style="background:#FFB703"></i>Forms <i style="background:#0A1128"></i>Calls</span></figcaption>
    <svg viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(label)}"><line x1="0" y1="${h - bottom}" x2="${w}" y2="${h - bottom}" stroke="#D6DBE6"></line>${bars}</svg></figure>`;
}

function systemStrip(sys) {
  if (!sys) return "";
  const item = (on, name, hint) => `<li><span class="chip ${on ? "done" : ""}">${on ? "On" : "Off"}</span> <b>${esc(name)}</b>${on ? "" : ` <span class="muted small">${hint}</span>`}</li>`;
  return `<div class="panel"><h2>Automation status</h2><ul class="checks launch">
    ${item(sys.recording, "Call recording and transcripts", "Set CALL_RECORDING=on in Netlify to start recording calls (callers hear a notice first).")}
    ${item(sys.summaries, "AI call summaries", "Add ANTHROPIC_API_KEY in Netlify so each call gets a summary and a genuine / not genuine verdict.")}
    ${item(sys.stripeOn, "Automatic billing", "Add the Stripe keys (see docs/SETUP.md).")}
  </ul>
  <p class="mt"><button class="btn btn-ghost btn-small" data-action="run-job" data-job="meta-sync" type="button">Sync Facebook results now</button>
    <button class="btn btn-ghost btn-small" data-action="run-job" data-job="weekly-reports" type="button">Draft last week's reports now</button>
    <button class="btn btn-ghost btn-small" data-action="run-job" data-job="attention-email" type="button">Email me this list now</button></p></div>`;
}

function attentionPanel() {
  const att = state.attention;
  return `<div class="panel"><h2>Needs attention</h2>
    ${att === null ? `<p class="muted">Checking…</p>` : att.length
      ? `<ul class="checks launch">${att.map((a) => `<li><span class="chip ${a.level === "bad" ? "spam" : "doing"}">${a.level === "bad" ? "Problem" : "Check"}</span> <b>${esc(a.client)}</b> ${esc(a.message)}
          <button class="btn btn-ghost btn-small" data-action="admin-open" data-id="${a.client_id}" type="button">Open</button></li>`).join("")}</ul>`
      : `<p class="muted">Nothing needs your attention. 🎉</p>`}</div>`;
}

function viewAdminOverview() {
  const o = state.ov;
  if (!o) return `<p class="loading">Loading…</p>`;
  const t = o.totals;
  const tile = (n, l, extra = "", cls = "") => `<div class="tile${cls}"><div class="n">${n}</div><div class="l">${l}</div>${extra}</div>`;
  return `<div class="tiles">
      ${tile(t.enquiries_today, "Enquiries today", "", " key")}
      ${tile(t.enq7, "Enquiries, last 7 days", `<div class="small">${trend(t.enq7, t.enqPrev7)} vs the week before</div>`)}
      ${tile(t.enq30, "Enquiries, last 30 days", `<div class="small muted">${t.customers30} became customers</div>`)}
      ${tile(pctText(t.answered30, t.calls30), "Calls answered", `<div class="small muted">${t.calls30} calls in 30 days</div>`)}
      ${tile(money(t.spend30), "Ad spend, 30 days", `<div class="small muted">${t.cpe ? `${money(t.cpe)} per enquiry` : "no spend data yet"}</div>`)}
      ${tile(money(t.month_revenue_pence), "Billable this month", `<div class="small muted">${t.open_disputes ? `${t.open_disputes} dispute${t.open_disputes === 1 ? "" : "s"} to review` : "estimate"}</div>`)}
    </div>
    ${o.insights.length ? `<div class="panel"><h2>What's happening</h2><ul class="checks launch">${o.insights.map((i) => `<li><span class="chip ${i.level === "good" ? "done" : i.level === "bad" ? "spam" : ""}">${i.level === "good" ? "Good" : i.level === "bad" ? "Watch out" : "Insight"}</span> ${esc(i.text)}</li>`).join("")}</ul></div>` : ""}
    <div class="panel">${stackedChart(o.series)}</div>
    ${attentionPanel()}
    <div class="panel"><h2>Clients at a glance</h2>
      ${o.clients.length ? `<div class="tablewrap"><table class="health"><thead><tr><th>Client</th><th>Health</th><th class="num">7 days</th><th class="num">30 days</th><th class="num">Calls answered</th><th class="num">Ad spend</th><th class="num">Cost per enquiry</th><th>Last enquiry</th><th class="num">Setup</th><th></th></tr></thead><tbody>
        ${o.clients.map((c) => { const [cls, label] = HEALTH_CHIP[c.health.level];
          return `<tr><td><b>${esc(c.name)}</b><div class="muted small">${esc(c.sector || "")}</div></td>
          <td><span class="chip ${cls}">${label}</span>${c.health.reasons.length ? `<div class="small muted">${c.health.reasons.map(esc).join("<br>")}</div>` : ""}</td>
          <td class="num">${c.enq7}<div class="small">${trend(c.enq7, c.enqPrev7)}</div></td><td class="num">${c.enq30}</td>
          <td class="num">${c.calls30 ? `${pctText(c.answered30, c.calls30)}<div class="small muted">${c.calls30} calls</div>` : "–"}</td>
          <td class="num">${c.spend30 ? money(c.spend30) : "–"}</td><td class="num">${c.cpe ? money(c.cpe) : "–"}</td>
          <td>${esc(ago(c.last_enquiry_at))}</td><td class="num">${c.setupDone}/${c.setupTotal}</td>
          <td><button class="btn btn-ghost btn-small" data-action="admin-open" data-id="${c.id}" type="button">Manage</button></td></tr>`; }).join("")}
      </tbody></table></div>` : `<p class="muted">No clients yet. Add your first one under Clients.</p>`}
    </div>
    ${systemStrip(o.system)}`;
}

function clientOptions(selected) {
  return `<option value="">All clients</option>${(state.adminClients || []).map((c) => `<option value="${c.id}" ${String(selected) === String(c.id) ? "selected" : ""}>${esc(c.name)}</option>`).join("")}`;
}

function viewAdminFeed() {
  const f = state.feed;
  const v = f.filters;
  const sel = (name, opts, cur, id) => `<select id="${id}" name="${name}">${opts.map(([val, t]) => `<option value="${val}" ${cur === val ? "selected" : ""}>${t}</option>`).join("")}</select>`;
  return `<div class="panel"><h2>Every enquiry, every client</h2>
    <form class="form wide filters" data-form="feed-filter">
      <div class="field"><label for="ff_c">Client</label><select id="ff_c" name="client">${clientOptions(v.client)}</select></div>
      <div class="field"><label for="ff_t">Type</label>${sel("type", [["", "Forms and calls"], ["form", "Forms"], ["call", "Calls"]], v.type || "", "ff_t")}</div>
      <div class="field"><label for="ff_s">Outcome</label>${sel("status", [["", "Any"], ["new", "New"], ["qualified", "Good"], ["customer", "Customers"], ["spam", "Spam"]], v.status || "", "ff_s")}</div>
      <div class="field"><label for="ff_src">Source</label><input id="ff_src" name="source" value="${esc(v.source || "")}" placeholder="google, facebook…"></div>
      <div class="field"><label for="ff_q">Search</label><input id="ff_q" name="q" value="${esc(v.q || "")}" placeholder="name, phone, words in the message"></div>
      <button class="btn btn-primary" type="submit">Filter</button>
    </form></div>
    ${f.leads === null ? `<p class="loading">Loading…</p>` : f.leads.length ? `<div class="feed">${f.leads.map((l) => `
      <article class="lead-card ${l.status === "spam" ? "is-spam" : ""}">
        <header><span class="chip">${esc(l.client)}</span> <span class="muted small">${esc(fmtDate(l.received_at))} · ${esc(ago(l.received_at))}</span>
          <span class="chip ${l.type === "call" ? "doing" : ""}">${l.type === "call" ? "Call" : "Form"}</span>
          ${l.has_gclid ? `<span class="chip">Google click</span>` : ""}${l.has_fb ? `<span class="chip">Facebook</span>` : ""}
          ${l.dispute_state === "open" ? `<span class="chip spam">Disputed</span>` : ""}</header>
        <h3>${esc(l.name || l.phone || "Unknown caller")}</h3>
        <p class="muted small">${esc([l.phone, l.email].filter(Boolean).join(" · "))}${l.source ? ` · ${esc(l.source)}` : ""}${l.campaign ? ` · ${esc(l.campaign)}` : ""}</p>
        ${l.call_summary ? `<p class="callsum"><b>Call summary:</b> ${esc(l.call_summary)}</p>` : ""}
        ${l.message && l.type !== "call" ? `<div class="lead-msg">${esc(l.message)}</div>` : ""}
        <footer><label class="sr-only" for="fs${l.id}">Outcome</label>
          <select id="fs${l.id}" class="lead-select" data-action="admin-lead-status" data-id="${l.id}">
            ${Object.entries(STATUS_LABEL).map(([val, t]) => `<option value="${val}" ${l.status === val ? "selected" : ""}>${t}</option>`).join("")}</select>
          ${l.call_id ? `<button class="btn btn-ghost btn-small" data-action="call-open" data-id="${l.call_id}" type="button">${l.has_transcript ? "Read the call" : "Call details"}${l.duration_seconds ? ` (${fmtDuration(l.duration_seconds)})` : ""}</button>` : ""}
          <button class="btn btn-ghost btn-small" data-action="admin-open" data-id="${l.client_id}" type="button">Open client</button></footer>
      </article>`).join("")}</div>
      ${f.more ? `<p class="center"><button class="btn btn-ghost" data-action="feed-more" type="button">Load more</button></p>` : ""}`
      : `<div class="panel"><p class="muted">No enquiries match. Try clearing the filters.</p></div>`}`;
}

const OUTCOME_TEXT = { booked: "Booked or agreed", quote_requested: "Wants a quote", information: "Asked for information", not_genuine: "Not genuine", missed_or_voicemail: "Missed or voicemail", other: "Other" };
const OUTCOME_CLASS = { booked: "done", quote_requested: "done", information: "", not_genuine: "spam", missed_or_voicemail: "spam", other: "" };

function callDetailPanel() {
  const c = state.callOpen;
  if (!c) return "";
  const sum = c.summary;
  let body;
  if (c.transcript && c.transcript.length) {
    body = `<div class="transcript" role="log" aria-label="Call transcript">${c.transcript.map((t) => `<div class="bubble ${t.speaker}"><span class="spk">${t.speaker === "caller" ? "Caller" : "Business"}</span>${esc(t.text)}</div>`).join("")}</div>`;
  } else if (c.media_deleted_at) {
    body = `<p class="muted">The recording and transcript were deleted after ${esc(String(state.ov?.system?.retentionDays || 90))} days. The summary above is kept.</p>`;
  } else if (c.transcript_status === "failed") {
    body = `<p class="muted">The transcript failed${c.transcript_error ? ` (${esc(c.transcript_error)})` : ""}. <button class="btn btn-ghost btn-small" data-action="call-retry" data-id="${c.id}" type="button">Try again</button></p>`;
  } else if (c.has_recording) {
    body = `<p class="muted">Transcribing… this usually takes a few minutes. <button class="btn btn-ghost btn-small" data-action="call-open" data-id="${c.id}" type="button">Refresh</button></p>`;
  } else {
    body = `<p class="muted">${state.ov?.system?.recording === false ? "Call recording is switched off, so there's no recording or transcript." : "No recording for this call (it may have been unanswered or too short)."}</p>`;
  }
  return `<div class="panel callpanel"><div class="rowhead"><h2>Call from ${esc(c.from_number || "unknown")}</h2>
      <button class="btn btn-ghost btn-small" data-action="call-close" type="button">Close</button></div>
    <p class="muted small"><b>${esc(c.client)}</b> · ${esc(fmtDate(c.started_at))} · ${esc(c.label || "")} · ${c.duration_seconds != null ? fmtDuration(c.duration_seconds) : "–"} · ${esc(c.status)}</p>
    ${c.has_recording ? `<audio controls preload="none" src="/api/admin/calls/${Number(c.id)}/recording"></audio>` : ""}
    ${sum ? `<div class="sumbox"><p><span class="chip ${OUTCOME_CLASS[sum.outcome] || ""}">${esc(OUTCOME_TEXT[sum.outcome] || "Other")}</span>
        <span class="chip ${sum.genuine ? "done" : "spam"}">${sum.genuine ? "Genuine" : "Not genuine"}</span>
        <span class="chip">${esc(sum.sentiment)}</span></p>
      <p>${esc(sum.summary)}</p>${sum.follow_up ? `<p class="muted"><b>Next:</b> ${esc(sum.follow_up)}</p>` : ""}</div>` : ""}
    ${body}</div>`;
}

function viewAdminCalls() {
  const l = state.callsList;
  const v = l.filters;
  const sel = (name, opts, cur, id) => `<select id="${id}" name="${name}">${opts.map(([val, t]) => `<option value="${val}" ${cur === val ? "selected" : ""}>${t}</option>`).join("")}</select>`;
  return `${callDetailPanel()}
    <div class="panel"><h2>Calls</h2>
      ${state.ov && state.ov.system && !state.ov.system.recording ? `<p class="notice">Call recording is off. You'll see who rang and for how long. Set <b>CALL_RECORDING=on</b> in Netlify to also get recordings, transcripts and summaries.</p>` : ""}
      <form class="form wide filters" data-form="calls-filter">
        <div class="field"><label for="cf_c">Client</label><select id="cf_c" name="client">${clientOptions(v.client)}</select></div>
        <div class="field"><label for="cf_s">Result</label>${sel("status", [["", "Any"], ["completed", "Answered"], ["no-answer", "Not answered"], ["busy", "Engaged"], ["failed", "Failed"]], v.status || "", "cf_s")}</div>
        <div class="field"><label for="cf_o">Verdict</label>${sel("outcome", [["", "Any"], ...Object.entries(OUTCOME_TEXT)], v.outcome || "", "cf_o")}</div>
        <div class="field"><label for="cf_q">Search</label><input id="cf_q" name="q" value="${esc(v.q || "")}" placeholder="number, or words said on the call"></div>
        <button class="btn btn-primary" type="submit">Filter</button>
      </form>
      ${l.calls === null ? `<p class="loading">Loading…</p>` : l.calls.length ? `<div class="tablewrap"><table><thead><tr><th>When</th><th>Client</th><th>Caller</th><th class="num">Length</th><th>Result</th><th>What happened</th><th></th></tr></thead><tbody>
        ${l.calls.map((c) => `<tr><td>${esc(fmtDate(c.started_at))}<div class="small muted">${esc(ago(c.started_at))}</div></td><td><b>${esc(c.client)}</b></td><td>${esc(c.from_number || "–")}</td>
          <td class="num">${c.duration_seconds != null ? fmtDuration(c.duration_seconds) : "–"}</td>
          <td><span class="chip ${c.status === "completed" ? "done" : "spam"}">${esc(CALL_STATUS[c.status] || c.status)}</span></td>
          <td>${c.summary ? `<span class="chip ${OUTCOME_CLASS[c.summary.outcome] || ""}">${esc(OUTCOME_TEXT[c.summary.outcome] || "Other")}</span> <span class="small">${esc(c.summary.summary)}</span>`
            : c.has_transcript ? `<span class="muted small">Transcript ready</span>` : c.has_recording ? `<span class="muted small">Transcribing…</span>` : `<span class="muted small">–</span>`}</td>
          <td><button class="btn btn-ghost btn-small" data-action="call-open" data-id="${c.id}" type="button">Open</button></td></tr>`).join("")}</tbody></table></div>
        ${l.more ? `<p class="center"><button class="btn btn-ghost" data-action="calls-more" type="button">Load more</button></p>` : ""}`
        : `<p class="muted">No calls match.</p>`}
    </div>`;
}

function viewAdminPerformance() {
  const p = state.perf;
  if (!p) return `<p class="loading">Loading…</p>`;
  const cheapest = Math.min(...p.channels.filter((c) => c.cost_per_enquiry_pence).map((c) => c.cost_per_enquiry_pence));
  const dearest = Math.max(...p.channels.filter((c) => c.cost_per_enquiry_pence).map((c) => c.cost_per_enquiry_pence));
  const cpeChip = (v) => (v ? `<span class="chip ${v === cheapest && cheapest !== dearest ? "done" : v === dearest && cheapest !== dearest ? "spam" : ""}">${money(v)}</span>` : "–");
  const maxEnq = Math.max(1, ...p.channels.map((c) => c.enquiries));
  return `<div class="panel"><h2>Where enquiries come from (30 days)</h2>
      ${p.channels.length ? `<div class="tablewrap"><table><thead><tr><th>Source</th><th>Enquiries</th><th class="num">Ad spend</th><th class="num">Cost per enquiry</th><th class="num">Good</th><th class="num">Customers</th><th class="num">Spam</th></tr></thead><tbody>
      ${p.channels.map((c) => `<tr><td><b>${esc(c.name)}</b></td>
        <td><div class="meter"><span style="width:${Math.round((c.enquiries / maxEnq) * 100)}%"></span></div>${c.enquiries}</td>
        <td class="num">${c.spend_pence ? money(c.spend_pence) : "–"}</td><td class="num">${cpeChip(c.cost_per_enquiry_pence)}</td>
        <td class="num">${c.qualified}</td><td class="num">${c.customers}</td><td class="num">${c.spam_pct ? `<span class="${c.spam_pct >= 25 ? "bad-text" : ""}">${c.spam_pct}%</span>` : "0%"}</td></tr>`).join("")}</tbody></table></div>
      <p class="muted small">Cost per enquiry is a channel's ad spend divided by real enquiries recorded here, so it matches what clients are billed for. Green is the cheapest channel, red the dearest.</p>`
      : `<p class="muted">No enquiries yet.</p>`}</div>
    <div class="panel"><h2>Clients, best to worst (30 days)</h2>
      <div class="tablewrap"><table><thead><tr><th>Client</th><th class="num">Enquiries</th><th class="num">Ad spend</th><th class="num">Cost per enquiry</th><th class="num">Became customers</th><th class="num">Spam</th></tr></thead><tbody>
      ${p.clients.map((c) => `<tr><td><b>${esc(c.name)}</b></td><td class="num">${c.enquiries}</td><td class="num">${c.spend_pence ? money(c.spend_pence) : "–"}</td>
        <td class="num">${c.cost_per_enquiry_pence ? money(c.cost_per_enquiry_pence) : "–"}</td><td class="num">${c.customers} (${c.customer_pct}%)</td><td class="num">${c.spam_pct}%</td></tr>`).join("")}</tbody></table></div></div>
    <div class="panel"><h2>Campaigns</h2>
      ${p.campaigns.length ? `<div class="tablewrap"><table><thead><tr><th>Campaign</th><th class="num">Enquiries</th><th class="num">Good</th><th class="num">Customers</th><th class="num">Spam</th></tr></thead><tbody>
      ${p.campaigns.map((c) => `<tr><td>${esc(c.name)}</td><td class="num">${c.enquiries}</td><td class="num">${c.qualified}</td><td class="num">${c.customers}</td><td class="num">${c.spam}</td></tr>`).join("")}</tbody></table></div>`
      : `<p class="muted">Campaign names appear here when your ads pass them through (the utm_campaign in the link).</p>`}</div>
    ${p.call_outcomes.length ? `<div class="panel"><h2>What callers wanted</h2><ul class="checks launch">${p.call_outcomes.map((o) => `<li><span class="chip ${OUTCOME_CLASS[o.outcome] || ""}">${esc(OUTCOME_TEXT[o.outcome] || "Other")}</span> ${o.n} call${o.n === 1 ? "" : "s"}</li>`).join("")}</ul></div>` : ""}`;
}

const PROSPECT_STATUS_TEXT = { new: "New", to_call: "To call", contacted: "Contacted", replied: "Replied", won: "Won", lost: "Lost", skip: "Not for us" };
const PROSPECT_ACTIVE = ["new", "to_call", "contacted", "replied"];

const ukPhone = (n) => (n && n.startsWith("+44") ? "0" + n.slice(3) : n || "");

function scoreChip(score) {
  if (score === null || score === undefined) return "";
  const cls = score <= 40 ? "spam" : score <= 70 ? "doing" : "done";
  return `<span class="chip ${cls}" title="Lower means more we can help with">Website ${score}/100</span>`;
}

function adsBlock(pr) {
  const c = (pr.audit && pr.audit.checks) || {};
  const l = pr.ad_links || {};
  const yn = (id, field, v) => `<label class="sr-only" for="${id}${pr.id}">${field === "ads_google" ? "Google" : "Facebook"} ads</label>
    <select id="${id}${pr.id}" data-action="prospect-ads" data-field="${field}" data-id="${pr.id}">
      <option value="unknown" ${v === "unknown" ? "selected" : ""}>Not checked</option>
      <option value="yes" ${v === "yes" ? "selected" : ""}>Running ads</option>
      <option value="no" ${v === "no" ? "selected" : ""}>No ads found</option></select>`;
  const seen = [c.googleAdsTag && "Google Ads tag on site", c.metaPixel && "Facebook pixel on site", c.facebookPage && "Facebook page linked", c.analytics && "Analytics on site"].filter(Boolean);
  const fb = c.facebookPage ? safeHref(c.facebookPage) : "";
  return `<div class="prospect-ads"><b>Their advertising</b>
    <p class="muted small">${seen.length ? esc(seen.join(" · ")) : (pr.audit && pr.audit.checks && pr.audit.checks.website === false ? "No website to check." : "No ad tags, pixel or analytics spotted on their site.")}${fb ? ` · <a href="${fb}" target="_blank" rel="noopener noreferrer">Facebook page</a>` : ""}</p>
    <div class="prospect-ads-row">
      ${safeHref(l.google) ? `<a class="btn btn-ghost btn-small" href="${safeHref(l.google)}" target="_blank" rel="noopener noreferrer">Check Google ads</a>` : ""}${yn("pg", "ads_google", pr.ads_google)}
      ${safeHref(l.meta) ? `<a class="btn btn-ghost btn-small" href="${safeHref(l.meta)}" target="_blank" rel="noopener noreferrer">Check Facebook ads</a>` : ""}${yn("pm", "ads_meta", pr.ads_meta)}
    </div>
    <p class="muted small">Opens Google's and Facebook's public ad libraries for this business. Look, then tell us what you saw so the proposal uses it. Press "Rewrite proposal" afterwards.</p></div>`;
}

function prospectCard(pr) {
  const open = state.prospectOpen.has(String(pr.id));
  const issues = (pr.audit && pr.audit.issues ? pr.audit.issues : []).slice(0, 3);
  const c = pr.proposition && pr.proposition.call;
  const site = safeHref(pr.website);
  const entityHint = pr.entity_type === "company" ? "Limited companies can be emailed at a business address, if you say who you are and how to opt out."
    : "Not sure it's a limited company? Check Companies House. Sole traders and partnerships count as individuals: phone only if they aren't on the TPS, and email only with their permission.";
  return `<article class="prospect ${open ? "open" : ""}">
    <div class="prospect-head">
      <div><h3>${esc(pr.name)}</h3>
        <p class="muted small">${esc(pr.niche || "")}${pr.address ? " · " + esc(pr.address) : ""}${pr.source === "manual" ? " · added by you" : ""}</p></div>
      <div class="prospect-tags">${scoreChip(pr.score)}<span class="chip ${pr.status === "won" ? "done" : pr.status === "new" ? "new" : ""}">${esc(PROSPECT_STATUS_TEXT[pr.status] || pr.status)}</span></div>
    </div>
    <p class="prospect-contact">${pr.phone ? `<a href="tel:${esc(pr.phone)}"><b>${esc(ukPhone(pr.phone))}</b></a>` : `<span class="muted">No phone number found</span>`}
      ${site ? ` · <a href="${site}" target="_blank" rel="noopener noreferrer">${esc(pr.website.replace(/^https?:\/\//, ""))}</a>` : ` · <span class="muted">no website found</span>`}</p>
    ${issues.length ? `<ul class="prospect-issues">${issues.map((i) => `<li><b>${esc(i.title)}</b> <span class="muted">${esc(i.detail)}</span></li>`).join("")}</ul>` : ""}
    ${adsBlock(pr)}
    <div class="prospect-actions">
      <a class="btn btn-primary btn-small" href="/api/admin/prospects/${Number(pr.id)}/pdf" target="_blank" rel="noopener">Open proposal PDF</a>
      <button class="btn btn-ghost btn-small" data-action="prospect-toggle" data-id="${pr.id}" type="button" aria-expanded="${open}">${open ? "Hide" : "Show"} call script</button>
      <button class="btn btn-ghost btn-small" data-action="prospect-rewrite" data-id="${pr.id}" type="button">Rewrite proposal</button>
      <label class="sr-only" for="ps${pr.id}">Status</label>
      <select id="ps${pr.id}" data-action="prospect-status" data-id="${pr.id}">${Object.entries(PROSPECT_STATUS_TEXT).map(([v, t]) => `<option value="${v}" ${pr.status === v ? "selected" : ""}>${t}</option>`).join("")}</select>
      <label class="sr-only" for="pe${pr.id}">Business type</label>
      <select id="pe${pr.id}" data-action="prospect-entity" data-id="${pr.id}">
        <option value="unknown" ${pr.entity_type === "unknown" ? "selected" : ""}>Type not checked</option>
        <option value="company" ${pr.entity_type === "company" ? "selected" : ""}>Limited company</option>
        <option value="sole_trader" ${pr.entity_type === "sole_trader" ? "selected" : ""}>Sole trader / partnership</option></select>
    </div>
    ${open && c ? `<div class="prospect-script">
      <p class="muted small">${esc(entityHint)}</p>
      <h4>Opening line</h4><p>${esc(c.opener)}</p>
      ${c.why_now ? `<h4>Why now</h4><p>${esc(c.why_now)}</p>` : ""}
      ${c.questions && c.questions.length ? `<h4>Ask</h4><ul>${c.questions.map((q) => `<li>${esc(q)}</li>`).join("")}</ul>` : ""}
      ${c.objections && c.objections.length ? `<h4>If they say</h4><ul>${c.objections.map((o) => `<li><b>${esc(o.q)}</b><br>${esc(o.a)}</li>`).join("")}</ul>` : ""}
      ${pr.proposition.cover_note ? `<h4>Message to send with the PDF</h4><textarea id="cn${pr.id}" class="code-area" readonly rows="4">${esc(pr.proposition.cover_note)}</textarea>
        <p><button class="btn btn-ghost btn-small" data-action="prospect-copy" data-id="${pr.id}" type="button">Copy message</button></p>` : ""}
      <p class="muted small">Written ${pr.proposition_by === "claude" ? "by Claude from what we saw on their website" : "from a template (add the Anthropic key for richer, tailored proposals)"}.</p>
    </div>` : ""}
    <form class="prospect-notes" data-form="prospect-notes" data-id="${pr.id}">
      <label class="sr-only" for="pn${pr.id}">Notes</label>
      <input id="pn${pr.id}" name="notes" type="text" maxlength="2000" value="${esc(pr.notes || "")}" placeholder="Notes: who you spoke to, what they said">
      <label class="sr-only" for="pf${pr.id}">Follow up on</label>
      <input id="pf${pr.id}" name="follow_up_on" type="date" value="${pr.follow_up_on ? esc(String(pr.follow_up_on).slice(0, 10)) : ""}" title="Follow up on">
      <button class="btn btn-ghost btn-small" type="submit">Save</button>
    </form>
  </article>`;
}

function viewAdminProspects() {
  const d = state.prospects;
  if (!d) return `<p class="loading">Loading…</p>`;
  const f = state.prospectFilter;
  const list = d.prospects.filter((p) => (f === "all" ? true : f === "active" ? PROSPECT_ACTIVE.includes(p.status) : f === "won" ? p.status === "won" : ["lost", "skip"].includes(p.status)));
  const today = new Date().toISOString().slice(0, 10);
  const newToday = d.prospects.filter((p) => String(p.batch_date).slice(0, 10) === today).length;
  const due = d.prospects.filter((p) => p.follow_up_on && String(p.follow_up_on).slice(0, 10) <= today && PROSPECT_ACTIVE.includes(p.status)).length;
  return `<div class="panel"><h2>Manchester prospects</h2>
      <p class="muted">Every weekday morning we pick a trade (today's trade is <b>${esc(d.today)}</b>), find ${d.perDay} Greater Manchester businesses, look at their website the way a customer would, and write a proposal and call script for each. Nothing is ever sent to them. You decide who to ring.</p>
      <div class="tiles">
        <div class="tile"><div class="l">New today</div><div class="n">${newToday}</div></div>
        <div class="tile"><div class="l">Follow-ups due</div><div class="n">${due}</div></div>
        <div class="tile"><div class="l">Won</div><div class="n">${d.prospects.filter((p) => p.status === "won").length}</div></div>
      </div>
      <p><button class="btn btn-primary" data-action="run-job" data-job="prospects" type="button">Find today's businesses now</button>
        <span class="muted small">Takes about 20 seconds. Safe to press again: it never repeats a business.</span></p>
      <details class="prospect-rules"><summary>Before you ring or email anyone</summary>
        <ul>
          <li>Check the number isn't on the TPS (individuals) or CTPS (companies) do-not-call list at tpsonline.org.uk before a cold call.</li>
          <li>Limited companies can be emailed at a business address if you say who you are and give a clear way to opt out. Sole traders and partnerships can't be emailed cold, only called.</li>
          <li>If anyone says no, set them to "Not for us" and never contact them again.</li>
          <li>This isn't legal advice. The ICO's guide to direct marketing is the reference.</li>
        </ul></details>
      <details><summary>Add a business you found yourself</summary>
        <form class="form" data-form="prospect-add">
          <div class="field"><label for="pa-name">Business name</label><input id="pa-name" name="name" required maxlength="120"></div>
          <div class="field"><label for="pa-site">Website</label><input id="pa-site" name="website" placeholder="e.g. smithroofing.co.uk"></div>
          <div class="field"><label for="pa-phone">Phone</label><input id="pa-phone" name="phone" inputmode="tel" placeholder="0161 000 0000"></div>
          <div class="field"><label for="pa-niche">Trade</label><select id="pa-niche" name="niche">${d.niches.map((n) => `<option>${esc(n)}</option>`).join("")}<option>Other</option></select></div>
          <button class="btn btn-primary" type="submit">Add and write proposal</button>
        </form></details>
    </div>
    <div class="panel"><div class="prospect-filter"><h2>Prospects</h2>
      <label class="sr-only" for="pfilter">Show</label>
      <select id="pfilter" data-action="prospect-filter"><option value="active" ${f === "active" ? "selected" : ""}>In progress</option><option value="won" ${f === "won" ? "selected" : ""}>Won</option><option value="closed" ${f === "closed" ? "selected" : ""}>Lost or not for us</option><option value="all" ${f === "all" ? "selected" : ""}>Everything</option></select></div>
      ${list.length ? list.map(prospectCard).join("") : `<p class="muted">${d.prospects.length ? "Nothing here." : "Nothing yet. Press the button above, or wait for tomorrow morning's run."}</p>`}
      <p class="muted small">Business details from OpenStreetMap contributors (openstreetmap.org/copyright). Lower website scores mean more we can help with.</p></div>`;
}

function viewAdmin() {
  if (state.adminDetail) return viewAdminClient();
  const list = state.adminClients;
  const nav = `<nav class="subtabs" aria-label="Admin sections">${ADMIN_VIEWS.map(([id, label]) => `<button class="subtab" data-action="admin-view" data-view="${id}" ${state.adminView === id ? 'aria-current="page"' : ""} type="button">${label}</button>`).join("")}</nav>`;
  let body = "";
  if (state.adminView === "overview") body = viewAdminOverview();
  else if (state.adminView === "enquiries") body = viewAdminFeed();
  else if (state.adminView === "calls") body = viewAdminCalls();
  else if (state.adminView === "performance") body = viewAdminPerformance();
  else if (state.adminView === "prospects") body = viewAdminProspects();
  else if (state.adminView === "billing") body = `${billingPanel()}${invoicesPanel()}`;
  else body = `<div class="panel"><h2>Clients</h2>
      ${list === null ? `<p class="muted">Loading…</p>` : list.length
        ? `<div class="tablewrap"><table><thead><tr><th>Business</th><th>Sector</th><th class="num">Build</th><th class="num">Enquiries (30 days)</th><th></th></tr></thead><tbody>
            ${list.map((c) => `<tr><td><b>${esc(c.name)}</b></td><td>${esc(c.sector || "")}</td>
              <td class="num">${c.steps_done} of ${c.steps_total}</td><td class="num">${c.leads_30d}</td>
              <td><button class="btn btn-ghost btn-small" data-action="admin-open" data-id="${c.id}" type="button">Manage</button></td></tr>`).join("")}
          </tbody></table></div>`
        : `<p class="muted">No clients yet. Add your first one below.</p>`}
    </div>
    <div class="panel"><h2>Add a client</h2>
      <p class="muted small">Fill this in once. We check everything before anything is created, make their login, and show you exactly what's left to do.</p>
      ${newClientForm()}</div>`;
  return `<div class="pagehead"><h1>Admin</h1><p>Every client, every enquiry and every call in one place.</p></div>${nav}${body}`;
}


const NEW_CLIENT_FIELDS = [
  ["The business", [
    ["name", "Business name", "text", "required", ""], ["sector", "Sector", "text", "", "Gym, plumber, salon…"],
    ["website_url", "Their current website, if they have one", "url", "", "https://"],
  ]],
  ["Their login and phone", [
    ["owner_email", "Owner's email (they log in with this)", "email", "required", "name@theirbusiness.co.uk"],
    ["owner_phone", "Number their enquiry calls should ring", "tel", "", "07700 900123"],
    ["price_per_enquiry", "Price per genuine enquiry (£)", "number", "", "25.00"],
  ]],
  ["Ad accounts (optional, you can add these later)", [
    ["google_customer_id", "Google Ads customer id", "text", "", "123-456-7890"],
    ["meta_ad_account_id", "Facebook ad account id", "text", "", "1234567890"],
  ]],
];

function newClientForm() {
  const { values, errors } = state.newClient;
  return `<form class="form" data-form="create-client" novalidate>
    ${NEW_CLIENT_FIELDS.map(([group, fields]) => `<h3 class="grouphead">${esc(group)}</h3>${fields.map(([k, label, type, req, ph]) => `
      <div class="field"><label for="nc_${k}">${esc(label)}</label>
        <input id="nc_${k}" name="${k}" type="${type}" ${req} maxlength="254" placeholder="${esc(ph)}" value="${esc(values[k] || "")}"
          ${type === "number" ? 'min="0" step="0.01"' : ""} ${errors[k] ? `aria-invalid="true" aria-describedby="nce_${k}"` : ""}>
        ${errors[k] ? `<p class="field-err" id="nce_${k}">${esc(errors[k])}</p>` : ""}</div>`).join("")}`).join("")}
    <button class="btn btn-primary" type="submit">Add client</button>
  </form>`;
}

function checklistPanel() {
  const { checklist, welcome, selfServeReady, client } = state.adminDetail;
  if (!checklist) return "";
  const label = { done: "Done", waiting: "Waiting", todo: "To do", error: "Problem" };
  const cls = { done: "done", waiting: "doing", todo: "todo", error: "spam" };
  const next = checklist.nextStep;
  const extra = (it) => {
    if (it.state === "done") return "";
    if (it.key === "number" && selfServeReady && client.intake?.contact_phone) return `<button class="btn btn-primary btn-small" data-action="setup-number" type="button">Set up number</button>`;
    if (it.key === "enquiries") return `<button class="btn btn-ghost btn-small" data-action="test-enquiry" type="button">Send a test enquiry</button>`;
    return "";
  };
  return `<div class="panel"><h2>Launch checklist</h2>
    <p>${checklist.ready
      ? `<span class="chip done">Ready</span> Everything needed to run this client is in place.`
      : `<b>${checklist.done} of ${checklist.total}</b> done.${next ? ` <b>Next:</b> ${esc(next.title)}. ${esc(next.next)}` : ""}`}</p>
    <ul class="checks launch">${checklist.items.map((it) => `<li class="${esc(it.state)}"><span class="chip ${cls[it.state]}">${label[it.state]}</span> <b>${esc(it.title)}</b>
      ${it.next ? `<span class="muted small">${esc(it.next)}</span>` : ""} ${extra(it)}</li>`).join("")}</ul>
    <h3 class="grouphead">Message to send the client</h3>
    <p class="muted small">Copy this and send it. It lists exactly what they need to do, with your account ids already filled in.</p>
    <textarea id="welcome" class="code-area" readonly rows="14">${esc(welcome)}</textarea>
    <p><button class="btn btn-ghost btn-small" data-action="copy-welcome" type="button">Copy message</button></p>
  </div>`;
}

function adReviewPanel(client, ar) {
  const r = ar && ar.review;
  const list = (items) => (items && items.length ? `<ul>${items.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>` : "<p class=\"muted small\">Nothing to report.</p>");
  return `<div class="panel"><h2>Weekly AI review of their advertising</h2>
    <p class="muted small">Every Monday, Claude reads last week's numbers for this client and recommends what to change. Nothing is changed for you: you check each one, then make the change in Google or Facebook.</p>
    ${r ? `<p><b>${esc(r.headline)}</b> <span class="muted small">Week of ${esc(String(ar.week_start).slice(0, 10))}</span></p>
      <div class="review-cols"><div><h3 class="grouphead">Working</h3>${list(r.working)}</div><div><h3 class="grouphead">Not working</h3>${list(r.not_working)}</div></div>
      <h3 class="grouphead">Changes to make</h3><ol>${r.changes.map((c) => `<li><b>${esc(c.action)}</b><br><span class="muted">${esc(c.why)}</span></li>`).join("")}</ol>
      ${r.test_next ? `<h3 class="grouphead">Test next</h3><p>${esc(r.test_next)}</p>` : ""}`
      : `<p class="muted">No review yet. It runs every Monday once the Anthropic key is added and there are results to look at.</p>`}
    <p><button class="btn btn-ghost btn-small" data-action="client-review" data-id="${client.id}" type="button">Review last week now</button></p></div>`;
}

function viewAdminClient() {
  const { client, users, steps, numbers, drafts, connections, conversions, adReview } = state.adminDetail;
  const hook = `${location.origin}/api/ingest?key=${client.ingest_key}`;
  return `<div class="pagehead"><div class="rowhead"><h1>${esc(client.name)}</h1>
      <span><button class="btn btn-ghost btn-small" data-action="admin-back" type="button">All clients</button>
      <button class="btn btn-primary btn-small" data-action="view-as" data-id="${client.id}" type="button">View as client</button></span></div></div>

    ${checklistPanel()}

    ${adReviewPanel(client, adReview)}

    <div class="panel"><h2>Build progress</h2><ol class="steps">
      ${steps.map((st, i) => `<li class="step ${esc(st.status)}"><span class="dot" aria-hidden="true">${st.status === "done" ? "✓" : i + 1}</span>
        <div><h3>${esc(st.title)}</h3></div>
        <span><label class="sr-only" for="st${st.id}">Status</label><select id="st${st.id}" class="lead-select" data-action="step-status" data-id="${st.id}">
          ${[["todo", "To do"], ["doing", "In progress"], ["done", "Done"]].map(([v, t]) => `<option value="${v}" ${st.status === v ? "selected" : ""}>${t}</option>`).join("")}
        </select></span></li>`).join("")}
    </ol></div>

    <div class="panel"><h2>Website links</h2>
      <form class="form" data-form="client-links" data-id="${client.id}">
        <div class="field"><label for="pu">Preview link (while building)</label><input id="pu" name="preview_url" type="url" value="${esc(client.preview_url || "")}" placeholder="https://"></div>
        <div class="field"><label for="wu">Live website</label><input id="wu" name="website_url" type="url" value="${esc(client.website_url || "")}" placeholder="https://"></div>
        <button class="btn btn-primary" type="submit">Save links</button>
      </form></div>

    <div class="panel"><h2>Logins</h2>
      <p class="muted small">Invite the person from Netlify Identity first, then link their email here so they see this business.</p>
      <ul class="checks">${users.length ? users.map((u) => `<li>${esc(u)}</li>`).join("") : `<li class="muted">No one linked yet.</li>`}</ul>
      <form class="form" data-form="link-user" data-id="${client.id}">
        <div class="field"><label for="le">Client's email</label><input id="le" name="email" type="email" required></div>
        <button class="btn btn-primary" type="submit">Link login</button>
      </form></div>

    <div class="panel"><h2>Client details</h2>
      ${Object.keys(client.intake || {}).length
        ? `<dl class="kv">${INTAKE_LABELS.filter(([k]) => client.intake[k]).map(([k, label]) => `<dt>${esc(label)}</dt><dd>${esc(client.intake[k])}</dd>`).join("")}</dl>`
        : `<p class="muted">They haven't filled in their details yet.</p>`}</div>

    <div class="panel"><h2>Enquiries sent back to Google and Facebook</h2>
      <p class="muted small">Genuine enquiries (not marked spam) are reported back so the ad platforms learn which clicks become real customers. Last 30 days:</p>
      <ul class="checks">
        <li><b>Google:</b> ${conversions.google_sent} sent, from ${conversions.with_gclid} enquiries that came from a Google ad click${client.google_customer_id ? "" : " <span class=\"muted\">(add their Google customer id to switch on)</span>"}</li>
        <li><b>Facebook:</b> ${conversions.meta_sent} sent${conversions.meta_failed ? `, <b>${conversions.meta_failed} failed</b> (${esc(conversions.last_meta_error || "")})` : ""}${client.meta_pixel_id ? "" : " <span class=\"muted\">(add their pixel id to switch on)</span>"}</li>
      </ul>
      <p><button class="btn btn-ghost btn-small" data-action="run-job" data-job="meta-conversions" type="button">Send waiting enquiries to Facebook now</button></p>
    </div>

    <div class="panel"><h2>Weekly report drafts</h2>
      <p class="muted small">Drafted automatically every Monday. Add your notes, then publish so the client can see it.</p>
      ${drafts.length ? drafts.map((d) => `<form class="form" data-form="draft" data-id="${d.id}">
          <div class="field"><label for="dt${d.id}">Title</label><input id="dt${d.id}" name="title" value="${esc(d.title)}" maxlength="160" required></div>
          <div class="field"><label for="db${d.id}">Report</label><textarea id="db${d.id}" name="body" maxlength="20000" required>${esc(d.body)}</textarea></div>
          <p><button class="btn btn-primary" type="submit" value="publish">Publish</button>
          <button class="btn btn-ghost" type="submit" value="save">Save draft</button>
          <button class="btn btn-ghost" type="button" data-action="delete-draft" data-id="${d.id}">Delete</button></p>
        </form>`).join("") : `<p class="muted">No drafts waiting.</p>`}
    </div>

    <div class="panel"><h2>Ad accounts and calls</h2>
      <ul class="checks"><li><b>Google Ads:</b> ${esc(connections.google.text)}</li><li><b>Facebook:</b> ${esc(connections.meta.text)}${client.meta_last_error ? ` (${esc(client.meta_last_error)})` : ""}</li></ul>
      <p class="muted small">Ad results pushed in automatically are matched to this business by these ids. Digits only; dashes are ignored.</p>
      <form class="form" data-form="accounts" data-id="${client.id}">
        <div class="field"><label for="gc">Google Ads customer id</label><input id="gc" name="google_customer_id" value="${esc(client.google_customer_id || "")}" placeholder="123-456-7890"></div>
        <div class="field"><label for="mc">Meta ad account id</label><input id="mc" name="meta_ad_account_id" value="${esc(client.meta_ad_account_id || "")}" placeholder="1234567890"></div>
        <div class="field"><label for="px">Facebook pixel (dataset) id, for sending enquiries back</label><input id="px" name="meta_pixel_id" value="${esc(client.meta_pixel_id || "")}" placeholder="1234567890"></div>
        <div class="field"><label for="gn">Google conversion action name</label><input id="gn" name="google_conversion_name" value="${esc(client.google_conversion_name || "Portal enquiry")}" maxlength="100"></div>
        <div class="field"><label for="gcn">Google conversion name for new customers (blank = off)</label><input id="gcn" name="google_customer_conversion_name" value="${esc(client.google_customer_conversion_name || "")}" maxlength="100" placeholder="Portal customer"></div>
        <div class="field"><label for="cv">Value of a new customer (£)</label><input id="cv" name="customer_value" type="number" min="0" step="0.01" value="${client.customer_value_pence == null ? "" : esc((client.customer_value_pence / 100).toFixed(2))}" placeholder="400.00"></div>
        <div class="field"><label for="pp">Price per enquiry (£)</label><input id="pp" name="price_per_enquiry" type="number" min="0" step="0.01" value="${client.price_per_enquiry_pence == null ? "" : esc((client.price_per_enquiry_pence / 100).toFixed(2))}" placeholder="25.00"></div>
        <div class="field"><label for="cm">Shortest call that counts as an enquiry (seconds)</label><input id="cm" name="call_min_seconds" type="number" min="0" max="3600" value="${esc(client.call_min_seconds)}"></div>
        <button class="btn btn-primary" type="submit">Save</button>
      </form></div>

    <div class="panel"><h2>Tracking phone numbers</h2>
      <p class="muted small">Buy the number in Twilio first, then add it here with the client's real phone. Use international format, like +441612345678.</p>
      <ul class="checks">${numbers.length ? numbers.map((n) => `<li><b>${esc(n.number)}</b> (${esc(n.label)}) to ${esc(n.forward_to)}
        <button class="btn btn-ghost btn-small" data-action="remove-number" data-id="${n.id}" type="button">Remove</button></li>`).join("") : `<li class="muted">No numbers yet.</li>`}</ul>
      <form class="form" data-form="add-number" data-id="${client.id}">
        <div class="field"><label for="tn">Tracking number</label><input id="tn" name="number" required placeholder="+441612345678"></div>
        <div class="field"><label for="tf">Forwards to (client's phone)</label><input id="tf" name="forward_to" required placeholder="+447700900123"></div>
        <div class="field"><label for="tl">Where it is used</label><input id="tl" name="label" required maxlength="60" placeholder="Google ads"></div>
        <button class="btn btn-primary" type="submit">Add number</button>
      </form></div>

    <div class="panel"><h2>Ad results for one day</h2>
      <form class="form wide" data-form="stats" data-id="${client.id}">
        <div class="field"><label for="sd">Day</label><input id="sd" name="day" type="date" value="${todayKey()}" required></div>
        <div class="field"><label for="sp">Platform</label><select id="sp" name="platform"><option value="google">Google</option><option value="meta">Facebook and Instagram</option></select></div>
        <div class="field"><label for="ss">Spend (£)</label><input id="ss" name="spend" type="number" step="0.01" min="0" required></div>
        <div class="field"><label for="si">Impressions</label><input id="si" name="impressions" type="number" min="0" value="0"></div>
        <div class="field"><label for="sc">Clicks</label><input id="sc" name="clicks" type="number" min="0" value="0"></div>
        <div class="field"><label for="se">Enquiries</label><input id="se" name="enquiries" type="number" min="0" value="0"></div>
        <button class="btn btn-primary" type="submit">Save</button>
      </form></div>

    <div class="panel"><h2>Post a weekly report</h2>
      <form class="form" data-form="report" data-id="${client.id}">
        <div class="field"><label for="rw">Week starting (Monday)</label><input id="rw" name="week_start" type="date" value="${todayKey()}" required></div>
        <div class="field"><label for="rt">Title</label><input id="rt" name="title" required maxlength="160" placeholder="Week 3 report"></div>
        <div class="field"><label for="rb">Report</label><textarea id="rb" name="body" required maxlength="20000"></textarea></div>
        <button class="btn btn-primary" type="submit">Post report</button>
      </form></div>

    <div class="panel"><h2>Sending enquiries here</h2>
      <p class="muted small">In the client site's Netlify project, open Forms → Form notifications → Add notification → Outgoing webhook, and paste this address. Keep it private: anyone with it can add enquiries.</p>
      <p class="code">${esc(hook)}</p></div>

    <div class="panel"><h2>Account-wide addresses</h2>
      <p class="muted small">Same for every client. Set these once in Twilio and in your Google Ads script. See docs/SETUP.md.</p>
      <p class="muted small">Twilio: when a call comes in (HTTP POST)</p><p class="code">${esc(location.origin)}/api/twilio/voice</p>
      <p class="muted small">Ad results push address (send header x-push-key)</p><p class="code">${esc(location.origin)}/api/ingest-ads</p></div>`;
}

/* ---------- render ---------- */

function render() {
  const html = {
    loading: () => `<p class="loading">Loading…</p>`,
    login: screenLogin,
    forgot: screenForgot,
    setpw: screenSetPassword,
    portal: screenPortal,
  }[state.screen]();
  app.innerHTML = html;
  state.flash = null;
}

/* ---------- loading data ---------- */

async function loadPortal() {
  state.data = null;
  if (!state.me.client && !state.viewAs) return;
  try {
    state.data = await api(state.viewAs ? `/portal?client=${encodeURIComponent(state.viewAs)}` : "/portal");
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return;
    throw e;
  }
}

async function enterPortal() {
  state.me = await api("/me");
  state.viewAs = null;
  state.adminDetail = null;
  await loadPortal();
  state.tab = state.data ? "overview" : state.me.isAdmin ? "admin" : "overview";
  state.screen = "portal";
  if (state.tab === "admin") await loadAdminList();
}

const qs = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v !== "" && v != null)).toString();

/** Load whatever the current admin tab needs. Called on entering admin, on switching tabs, and after any change. */
async function loadAdminList() {
  state.adminClients = null;
  state.attention = null;
  state.billing = null;
  state.invoices = null;
  state.disputes = null;
  const view = state.adminView;
  const [list, att, bill, inv, dis] = await Promise.all([api("/admin/clients"), api("/admin/attention"), api(`/admin/billing?month=${encodeURIComponent(state.billingMonth)}`), api("/admin/invoices"), api("/admin/disputes")]);
  state.adminClients = list.clients;
  state.attention = att.items;
  state.billing = bill;
  state.invoices = inv;
  state.disputes = dis;
  if (view === "overview" || view === "calls") state.ov = await api("/admin/overview");
  if (view === "enquiries") await loadFeed(false);
  if (view === "calls") await loadCalls(false);
  if (view === "performance") state.perf = await api("/admin/performance");
  if (view === "prospects") state.prospects = await api("/admin/prospects");
}

async function loadFeed(append) {
  const f = state.feed;
  const before = append && f.leads && f.leads.length ? f.leads[f.leads.length - 1].id : "";
  const r = await api(`/admin/feed?${qs({ ...f.filters, before })}`);
  f.leads = append ? [...f.leads, ...r.leads] : r.leads;
  f.more = r.more;
}

async function loadCalls(append) {
  const l = state.callsList;
  const before = append && l.calls && l.calls.length ? l.calls[l.calls.length - 1].id : "";
  const r = await api(`/admin/calls?${qs({ ...l.filters, before })}`);
  l.calls = append ? [...l.calls, ...r.calls] : r.calls;
  l.more = r.more;
}

async function loadAdminClient(id) {
  const [detail, portal] = await Promise.all([api(`/admin/clients/${id}`), api(`/portal?client=${id}`)]);
  state.adminDetail = { adReview: detail.adReview, client: detail.client, users: detail.users, numbers: detail.numbers, drafts: detail.drafts, connections: detail.connections, conversions: detail.conversions, checklist: detail.checklist, welcome: detail.welcome, selfServeReady: detail.selfServeReady, steps: portal.steps };
}

/* ---------- events ---------- */

app.addEventListener("click", (e) => {
  const el = e.target.closest("[data-action]");
  if (!el || el.tagName === "SELECT") return;
  const a = el.dataset.action;

  if (a === "to-forgot") { state.screen = "forgot"; return render(); }
  if (a === "to-login") { state.screen = "login"; return render(); }

  if (a === "logout") {
    return attempt(async () => {
      await logout();
      Object.assign(state, { me: null, data: null, viewAs: null, adminClients: null, adminDetail: null, screen: "login" });
    });
  }

  if (a === "tab") {
    state.tab = el.dataset.tab;
    return attempt(async () => {
      if (state.tab === "admin" && !state.adminClients) await loadAdminList();
    });
  }

  if (a === "admin-open") return attempt(() => loadAdminClient(el.dataset.id));
  if (a === "admin-back") { state.adminDetail = null; return attempt(loadAdminList); }

  if (a === "run-job") {
    return attempt(async () => {
      const r = await api(`/admin/run/${el.dataset.job}`, { method: "POST", body: {} });
      await loadAdminList();
      if (el.dataset.job === "meta-conversions") {
        if (state.adminDetail) await loadAdminClient(state.adminDetail.client.id);
        return flash(r.skipped ? "err" : "ok", r.skipped ? "No Facebook token has been added yet."
          : `Facebook: ${r.sent} sent, ${r.failed} failed, ${r.unusable} had nothing to match on. Enquiries newer than the review window wait until it passes.`);
      }
      if (el.dataset.job === "billing") {
        if (r.stripeOff) return flash("err", "Stripe isn't connected yet.");
        const held = r.held.length ? ` Waiting: ${r.held.map((h) => `${h.client} (${h.reason})`).join("; ")}.` : "";
        const failed = r.failed.length ? ` Problems: ${r.failed.map((f) => `${f.client} (${f.error})`).join("; ")}.` : "";
        return flash(r.failed.length ? "err" : "ok", `${r.period}: ${r.drafts} draft${r.drafts === 1 ? "" : "s"}, ${r.created} sent, ${r.skipped} with nothing to bill.${held}${failed}`);
      }
      if (el.dataset.job === "prospects") {
        if (r.error) return flash("err", r.error);
        return flash("ok", `${r.niche}: looked at ${r.examined} of ${r.candidates} businesses and added ${r.added} new prospect${r.added === 1 ? "" : "s"}.${r.added ? "" : " Nothing new worth a call right now. Try again tomorrow."}`);
      }
      if (el.dataset.job === "attention-email") {
        return flash(r.sent ? "ok" : "err", r.sent ? "Sent. Check your inbox." : `Not sent: ${r.reason || r.error || "email isn't set up yet"}.`);
      }
      flash("ok", el.dataset.job === "meta-sync"
        ? (r.skipped ? "No Facebook access token has been added yet." : `Facebook: ${r.saved} days saved, ${r.failed} accounts failed.`)
        : `Drafted ${r.created} report${r.created === 1 ? "" : "s"} for the week of ${r.weekStart}.`);
    });
  }

  if (a === "print-report") {
    const target = document.getElementById(`rep${el.dataset.id}`);
    if (!target) return;
    target.open = true;
    target.classList.add("print-target");
    document.body.classList.add("printing");
    const done = () => {
      target.classList.remove("print-target");
      document.body.classList.remove("printing");
      window.removeEventListener("afterprint", done);
    };
    window.addEventListener("afterprint", done);
    window.print();
    return;
  }

  if (a === "delete-draft") {
    if (!confirm("Delete this draft?")) return;
    return attempt(async () => {
      await api(`/admin/reports/${el.dataset.id}`, { method: "DELETE" });
      await loadAdminClient(state.adminDetail.client.id);
      flash("ok", "Draft deleted.");
    });
  }

  if (a === "remove-number") {
    if (!confirm("Remove this tracking number? Calls to it will stop being forwarded once it is removed here.")) return;
    return attempt(async () => {
      await api(`/admin/numbers/${el.dataset.id}`, { method: "DELETE" });
      await loadAdminClient(state.adminDetail.client.id);
      flash("ok", "Number removed.");
    });
  }

  if (a === "admin-view") {
    state.adminView = el.dataset.view;
    state.adminDetail = null;
    return attempt(loadAdminList);
  }
  if (a === "feed-more") return attempt(() => loadFeed(true));
  if (a === "calls-more") return attempt(() => loadCalls(true));
  if (a === "call-open") {
    return attempt(async () => {
      const r = await api(`/admin/calls/${el.dataset.id}`);
      state.callOpen = r.call;
      state.adminView = "calls";
      state.adminDetail = null;
      state.tab = "admin";
      if (!state.callsList.calls) await loadAdminList();
      if (!state.ov) state.ov = await api("/admin/overview");
      window.scrollTo({ top: 0 });
    });
  }
  if (a === "call-close") { state.callOpen = null; return render(); }
  if (a === "call-retry") {
    return attempt(async () => {
      await api(`/admin/calls/${el.dataset.id}/transcribe`, { method: "POST", body: {} });
      state.callOpen = (await api(`/admin/calls/${el.dataset.id}`)).call;
      flash("ok", "Asked Twilio to try again. It can take a few minutes.");
    });
  }

  if (a === "payment-setup") {
    return attempt(async () => {
      const r = await api("/portal/payment-setup", { method: "POST", body: {} });
      // only ever go to Stripe's own checkout page
      if (!/^https:\/\/checkout\.stripe\.com\//.test(r.url || "")) throw new Error("We couldn't open the payment page. Please try again.");
      location.assign(r.url);
    });
  }

  if (a === "invoice-approve") {
    return attempt(async () => {
      await api(`/admin/invoices/${el.dataset.id}/approve`, { method: "POST", body: {} });
      await loadAdminList();
      flash("ok", "Approved. Stripe is sending it and will collect payment.");
    });
  }
  if (a === "invoice-discard") {
    if (!confirm("Discard this draft invoice? Nothing is charged, and the month can be billed again.")) return;
    return attempt(async () => {
      await api(`/admin/invoices/${el.dataset.id}`, { method: "DELETE" });
      await loadAdminList();
      flash("ok", "Draft discarded.");
    });
  }
  if (a === "dispute-decide") {
    return attempt(async () => {
      await api(`/admin/disputes/${el.dataset.id}`, { method: "POST", body: { decision: el.dataset.decision } });
      await loadAdminList();
      flash("ok", el.dataset.decision === "accept" ? "Accepted. That enquiry won't be billed." : "Rejected. It stays billable.");
    });
  }

  if (a === "setup-number") {
    return attempt(async () => {
      const r = await api(`/admin/clients/${state.adminDetail.client.id}/setup-number`, { method: "POST", body: {} });
      await loadAdminClient(state.adminDetail.client.id);
      flash("ok", `Tracking number ${r.number} is live and forwards to their phone.`);
    });
  }

  if (a === "test-enquiry") {
    return attempt(async () => {
      await api(`/admin/clients/${state.adminDetail.client.id}/test-enquiry`, { method: "POST", body: {} });
      await loadAdminClient(state.adminDetail.client.id);
      flash("ok", "Test enquiry added to their Enquiries list, marked as spam so it's never counted or billed. Now check it appears when you submit their real website's form.");
    });
  }

  if (a === "client-review") {
    return attempt(async () => {
      const r = await api(`/admin/clients/${el.dataset.id}/review`, { method: "POST", body: {} });
      await loadAdminClient(Number(el.dataset.id));
      flash(r.ok ? "ok" : "err", r.ok ? "Reviewed. The note for the client was added to their draft report." : r.reason);
    });
  }
  if (a === "prospect-toggle") {
    const id = String(el.dataset.id);
    if (state.prospectOpen.has(id)) state.prospectOpen.delete(id); else state.prospectOpen.add(id);
    return render();
  }
  if (a === "prospect-rewrite") {
    return attempt(async () => {
      const r = await api(`/admin/prospects/${el.dataset.id}/proposition`, { method: "POST", body: {} });
      state.prospects = await api("/admin/prospects");
      flash("ok", r.by === "claude" ? "Rewritten by Claude." : "Rewritten from the template. Add the Anthropic key to have Claude write it.");
    });
  }
  if (a === "prospect-copy") {
    const box = document.getElementById(`cn${el.dataset.id}`);
    if (!box) return;
    const ok = () => { flash("ok", "Copied."); render(); };
    const fallback = () => { box.focus(); box.select(); flash("err", "Press Ctrl+C (or Cmd+C) to copy the selected message."); render(); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(box.value).then(ok, fallback); else fallback();
    return;
  }

  if (a === "copy-welcome") {
    const box = document.getElementById("welcome");
    if (!box) return;
    const ok = () => { flash("ok", "Message copied. Paste it into an email to the client."); render(); };
    const fallback = () => { box.focus(); box.select(); flash("err", "Press Ctrl+C (or Cmd+C) to copy the selected message."); render(); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(box.value).then(ok, fallback); else fallback();
    return;
  }

  if (a === "view-as") {
    return attempt(async () => {
      state.viewAs = el.dataset.id;
      await loadPortal();
      state.tab = "overview";
    });
  }
  if (a === "stop-view") {
    return attempt(async () => {
      state.viewAs = null;
      state.tab = "admin";
      await loadPortal();
    });
  }
});

app.addEventListener("change", (e) => {
  const el = e.target.closest("select[data-action]");
  if (!el) return;
  const id = el.dataset.id;

  if (el.dataset.action === "lead-status") {
    attempt(async () => {
      await api(`/leads/${id}`, { method: "PATCH", body: { status: el.value } });
      const lead = state.data.leads.find((l) => String(l.id) === id);
      if (lead) lead.status = el.value;
      flash("ok", "Saved.");
    });
  }
  if (el.dataset.action === "prospect-status" || el.dataset.action === "prospect-entity") {
    const body = el.dataset.action === "prospect-status" ? { status: el.value } : { entity_type: el.value };
    attempt(async () => {
      await api(`/admin/prospects/${id}`, { method: "PATCH", body });
      state.prospects = await api("/admin/prospects");
      flash("ok", "Saved.");
    });
  }
  if (el.dataset.action === "prospect-ads") {
    attempt(async () => {
      await api(`/admin/prospects/${id}`, { method: "PATCH", body: { [el.dataset.field]: el.value } });
      state.prospects = await api("/admin/prospects");
      flash("ok", "Saved. Press Rewrite proposal to use it.");
    });
  }
  if (el.dataset.action === "prospect-filter") {
    state.prospectFilter = el.value;
    render();
  }
  if (el.dataset.action === "admin-lead-status") {
    attempt(async () => {
      await api(`/leads/${id}`, { method: "PATCH", body: { status: el.value } });
      const lead = state.feed.leads && state.feed.leads.find((l) => String(l.id) === id);
      if (lead) lead.status = el.value;
      flash("ok", "Saved.");
    });
  }
  if (el.dataset.action === "dispute") {
    if (!el.value) return;
    attempt(async () => {
      await api(`/portal/leads/${id}/dispute`, { method: "POST", body: { reason: el.value } });
      await loadPortal();
      flash("ok", "Thanks. We'll review it and you won't be billed for it unless we find it was genuine.");
    });
  }
  if (el.dataset.action === "step-status") {
    attempt(async () => {
      await api(`/admin/steps/${id}`, { method: "PATCH", body: { status: el.value } });
      const step = state.adminDetail.steps.find((s) => String(s.id) === id);
      if (step) step.status = el.value;
      flash("ok", "Saved.");
    });
  }
});

app.addEventListener("submit", (e) => {
  const form = e.target.closest("form[data-form]");
  if (!form) return;
  e.preventDefault();
  const f = Object.fromEntries(new FormData(form));
  const id = form.dataset.id;

  switch (form.dataset.form) {
    case "prospect-add":
      return attempt(async () => {
        const r = await api("/admin/prospects", { method: "POST", body: { name: f.name, website: f.website, phone: f.phone, niche: f.niche } });
        state.prospects = await api("/admin/prospects");
        state.prospectOpen.add(String(r.id));
        state.prospectFilter = "active";
        flash("ok", "Added. The proposal is ready to open.");
      });

    case "prospect-notes":
      return attempt(async () => {
        await api(`/admin/prospects/${id}`, { method: "PATCH", body: { notes: f.notes || "", follow_up_on: f.follow_up_on || "" } });
        state.prospects = await api("/admin/prospects");
        flash("ok", "Saved.");
      });

    case "login":
      return attempt(async () => {
        try {
          await login(f.email.trim(), f.password);
        } catch {
          throw new Error("We couldn't log you in. Check your email and password.");
        }
        await enterPortal();
      });

    case "forgot":
      return attempt(async () => {
        try {
          await requestPasswordRecovery(f.email.trim());
        } catch {
          /* same message either way, so nobody can test which emails have accounts */
        }
        state.screen = "login";
        flash("ok", "If that email has an account, a reset link is on its way.");
      });

    case "setpw":
      return attempt(async () => {
        if (String(f.password).length < 8) throw new Error("Use at least 8 characters.");
        if (state.setpw.kind === "invite") await acceptInvite(state.setpw.token, f.password);
        else await updateUser({ password: f.password });
        state.setpw = null;
        await enterPortal();
      });

    case "create-client":
      state.newClient = { values: { ...f }, errors: {} };
      return attempt(async () => {
        try {
          const r = await api("/admin/clients", { method: "POST", body: f });
          state.newClient = { values: {}, errors: {} };
          await loadAdminList();
          await loadAdminClient(r.id);
          flash("ok", `Client created and their login linked.${r.number ? ` Tracking number ${r.number} is live.` : r.numberNote ? ` ${r.numberNote}` : ""} Follow the launch checklist below.`);
        } catch (e) {
          if (e instanceof ApiError && e.errors.length) {
            for (const x of e.errors) state.newClient.errors[x.field] = x.message;
            setTimeout(() => { const bad = document.querySelector('input[aria-invalid="true"]'); if (bad) { bad.scrollIntoView({ block: "center" }); bad.focus(); } }, 0);
            throw new Error(`Please fix ${e.errors.length === 1 ? "the highlighted box" : `the ${e.errors.length} highlighted boxes`} and try again.`);
          }
          throw e;
        }
      });

    case "feed-filter":
      state.feed.filters = { client: f.client, type: f.type, status: f.status, source: f.source, q: f.q };
      return attempt(() => loadFeed(false));

    case "calls-filter":
      state.callsList.filters = { client: f.client, status: f.status, outcome: f.outcome, q: f.q };
      return attempt(() => loadCalls(false));

    case "client-links":
      return attempt(async () => {
        await api(`/admin/clients/${id}`, { method: "PATCH", body: { website_url: f.website_url, preview_url: f.preview_url } });
        await loadAdminClient(id);
        flash("ok", "Links saved.");
      });

    case "link-user":
      return attempt(async () => {
        await api(`/admin/clients/${id}/users`, { method: "POST", body: { email: f.email } });
        await loadAdminClient(id);
        flash("ok", "Login linked.");
      });

    case "billing-month":
      return attempt(async () => {
        state.billingMonth = f.month;
        state.billing = await api(`/admin/billing?month=${encodeURIComponent(f.month)}`);
      });

    case "intake":
      return attempt(async () => {
        await api("/portal/intake", { method: "POST", body: f });
        await loadPortal();
        flash("ok", "Thanks, we've saved your details.");
      });

    case "own-accounts":
      return attempt(async () => {
        await api("/portal/accounts", { method: "POST", body: f });
        await loadPortal();
        flash("ok", "Saved. We'll confirm the connection shortly.");
      });

    case "draft":
      return attempt(async () => {
        const publish = e.submitter && e.submitter.value === "publish";
        const r = await api(`/admin/reports/${id}`, { method: "PATCH", body: { title: f.title, body: f.body, publish } });
        await loadAdminClient(state.adminDetail.client.id);
        flash("ok", !publish ? "Draft saved." : r.email && r.email.sent ? "Published and emailed to the client." : "Published. The client can see it now (no email sent: email isn't set up yet).");
      });

    case "setup-phone":
      return attempt(async () => {
        const r = await api("/portal/phone", { method: "POST", body: { phone: f.phone } });
        await loadPortal();
        flash("ok", r.changed ? "Saved. Calls now ring that number." : `Done. Your tracking number is ${r.number}. Use it on your ads and website.`);
      });

    case "accounts":
      return attempt(async () => {
        await api(`/admin/clients/${id}/accounts`, { method: "PATCH", body: {
          google_customer_id: f.google_customer_id, meta_ad_account_id: f.meta_ad_account_id, call_min_seconds: f.call_min_seconds,
          price_per_enquiry: f.price_per_enquiry, meta_pixel_id: f.meta_pixel_id, google_conversion_name: f.google_conversion_name,
          google_customer_conversion_name: f.google_customer_conversion_name, customer_value: f.customer_value } });
        await loadAdminClient(id);
        flash("ok", "Saved.");
      });

    case "add-number":
      return attempt(async () => {
        await api(`/admin/clients/${id}/numbers`, { method: "POST", body: { number: f.number, forward_to: f.forward_to, label: f.label } });
        await loadAdminClient(id);
        flash("ok", "Number added. Now point it at the Twilio address shown at the bottom of this page.");
      });

    case "stats":
      return attempt(async () => {
        const pence = Math.round(Number(f.spend) * 100);
        await api(`/admin/clients/${id}/stats`, {
          method: "PUT",
          body: { day: f.day, platform: f.platform, spend_pence: pence, impressions: f.impressions, clicks: f.clicks, enquiries: f.enquiries },
        });
        flash("ok", "Ad results saved.");
      });

    case "report":
      return attempt(async () => {
        const r = await api(`/admin/clients/${id}/reports`, { method: "POST", body: { week_start: f.week_start, title: f.title, body: f.body } });
        form.reset();
        flash("ok", r.email && r.email.sent ? "Report posted and emailed to the client." : "Report posted. The client can see it now.");
      });
  }
});

/* ---------- start ---------- */

async function boot() {
  render();
  let cb = null;
  try {
    cb = await handleAuthCallback();
  } catch (e) {
    flash("err", "That link has expired or was already used. Ask for a new one.");
  }
  if (cb && cb.type) history.replaceState(null, "", location.pathname);

  if (cb && cb.type === "invite") {
    state.setpw = { kind: "invite", token: cb.token };
    state.screen = "setpw";
    return render();
  }
  if (cb && cb.type === "recovery") {
    state.setpw = { kind: "recovery" };
    state.screen = "setpw";
    return render();
  }

  let user = null;
  try {
    user = await getUser();
  } catch {
    user = null;
  }
  if (!user) {
    state.screen = "login";
    return render();
  }
  const pay = new URLSearchParams(location.search).get("payment");
  await attempt(async () => {
    await enterPortal();
    if (pay === "done" && state.data) { state.tab = "billing"; flash("ok", "Thanks! Your payment details are saved. It can take a minute to show here."); }
    else if (pay === "cancelled" && state.data) { state.tab = "billing"; flash("err", "Payment setup wasn't finished. You can try again any time."); }
    if (pay) history.replaceState(null, "", location.pathname);
  });
}

boot();
