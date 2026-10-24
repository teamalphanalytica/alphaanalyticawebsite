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
  adminDetail: null, // { client, users, steps }
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
  constructor(message, status) {
    super(message);
    this.status = status;
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
  if (!res.ok) throw new ApiError((json && json.error) || "Something went wrong. Please try again.", res.status);
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
  return `<div class="brand"><span class="mark" aria-hidden="true">α</span>Alpha Analytica</div>`;
}

function flashHtml() {
  if (!state.flash) return "";
  const f = state.flash;
  return `<div class="msg ${f.type === "ok" ? "ok" : "err"}" role="${f.type === "ok" ? "status" : "alert"}">${esc(f.text)}</div>`;
}

function screenLogin() {
  return `<div class="center"><div class="card">
    ${brand()}
    <h1>Client login</h1>
    <p class="sub">See how your website and ads are doing.</p>
    ${flashHtml()}
    <form class="form" data-form="login">
      <div class="field"><label for="email">Email</label><input id="email" name="email" type="email" autocomplete="username" required></div>
      <div class="field"><label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required></div>
      <button class="btn btn-primary" type="submit">Log in</button>
    </form>
    <p class="links"><button class="linkbtn" data-action="to-forgot" type="button">Forgot your password?</button></p>
  </div></div>`;
}

function screenForgot() {
  return `<div class="center"><div class="card">
    ${brand()}
    <h1>Reset your password</h1>
    <p class="sub">Enter your email and we'll send you a link.</p>
    ${flashHtml()}
    <form class="form" data-form="forgot">
      <div class="field"><label for="email">Email</label><input id="email" name="email" type="email" autocomplete="username" required></div>
      <button class="btn btn-primary" type="submit">Send link</button>
    </form>
    <p class="links"><button class="linkbtn" data-action="to-login" type="button">Back to log in</button></p>
  </div></div>`;
}

function screenSetPassword() {
  const invite = state.setpw && state.setpw.kind === "invite";
  return `<div class="center"><div class="card">
    ${brand()}
    <h1>${invite ? "Welcome. Set your password" : "Choose a new password"}</h1>
    <p class="sub">Use at least 8 characters.</p>
    ${flashHtml()}
    <form class="form" data-form="setpw">
      <div class="field"><label for="pw">Password</label><input id="pw" name="password" type="password" autocomplete="new-password" minlength="8" required></div>
      <button class="btn btn-primary" type="submit">Save password</button>
    </form>
  </div></div>`;
}

const TABS = [
  ["overview", "Overview"],
  ["website", "Website"],
  ["leads", "Enquiries"],
  ["calls", "Calls"],
  ["ads", "Ads"],
  ["reports", "Reports"],
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
    body = { overview: viewOverview, website: viewWebsite, leads: viewLeads, calls: viewCalls, ads: viewAds, reports: viewReports }[state.tab]();
  }

  return `<header class="bar"><div class="bar-in">
      ${brand()}
      <div class="who"><span>${esc(me.email)}</span><button class="linkbtn" data-action="logout" type="button">Log out</button></div>
    </div></header>
    <nav class="tabs" aria-label="Portal sections"><div class="tabs-in">
      ${tabs.map(([id, label]) => `<button class="tab" data-action="tab" data-tab="${id}" ${state.tab === id ? 'aria-current="page"' : ""} type="button">${label}</button>`).join("")}
    </div></nav>
    <main>
      ${viewing ? `<div class="banner"><span>Viewing as <b>${esc(viewing)}</b></span><button class="btn btn-ghost btn-small" data-action="stop-view" type="button">Back to admin</button></div>` : ""}
      ${flashHtml()}
      ${body}
    </main>`;
}

/* ---------- client views ---------- */

function summarise(d) {
  const now = Date.now();
  const day = 86400000;
  const real = d.leads.filter((l) => l.status !== "spam");
  const last7 = real.filter((l) => now - new Date(l.received_at) < 7 * day).length;
  const last30 = real.filter((l) => now - new Date(l.received_at) < 30 * day).length;
  const cutoff = new Date(now - 30 * day).toISOString().slice(0, 10);
  const stats30 = d.stats.filter((s) => dayKey(s.day) >= cutoff);
  const spend = stats30.reduce((a, s) => a + s.spend_pence, 0);
  const adEnquiries = stats30.reduce((a, s) => a + s.enquiries, 0);
  const done = d.steps.filter((s) => s.status === "done").length;
  const next = d.steps.find((s) => s.status !== "done") || null;
  return { last7, last30, spend, adEnquiries, done, total: d.steps.length, next, stats30 };
}

function viewOverview() {
  const d = state.data;
  const s = summarise(d);
  const cpe = s.adEnquiries > 0 ? money(s.spend / s.adEnquiries) : "Not yet";
  const latest = d.reports[0];
  return `<div class="pagehead"><h1>${esc(d.client.name)}</h1><p>Here's where things stand.</p></div>
    <div class="tiles">
      <div class="tile"><div class="n">${s.done} of ${s.total}</div><div class="l">website steps done</div></div>
      <div class="tile"><div class="n">${s.last7}</div><div class="l">enquiries in the last 7 days</div></div>
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
    </ol></div>`;
}

const STATUS_LABEL = { new: "New", qualified: "Good enquiry", customer: "Became a customer", spam: "Not a real enquiry" };

function viewLeads() {
  const d = state.data;
  const rows = d.leads.map((l) => `<tr>
      <td>${esc(fmtDate(l.received_at))}</td>
      <td><b>${esc(l.name || "No name")}</b><br><span class="muted small">${esc([l.phone, l.email].filter(Boolean).join(" · "))}</span></td>
      <td><div class="lead-msg">${esc(l.message || "")}</div></td>
      <td>${esc(l.source || "Website")}${l.type === "call" ? " (call)" : ""}</td>
      <td><label class="sr-only" for="ls${l.id}">Status</label>
        <select id="ls${l.id}" class="lead-select" data-action="lead-status" data-id="${l.id}">
          ${Object.entries(STATUS_LABEL).map(([v, t]) => `<option value="${v}" ${l.status === v ? "selected" : ""}>${t}</option>`).join("")}
        </select></td>
    </tr>`).join("");
  return `<div class="pagehead"><h1>Enquiries</h1>
      <p>Every enquiry from your website, newest first. Tell us which ones were good and which became customers. It helps us send you better ones.</p></div>
    <div class="panel">
      ${d.leads.length
        ? `<div class="tablewrap"><table><thead><tr><th>Date</th><th>Who</th><th>Message</th><th>Came from</th><th>Outcome</th></tr></thead><tbody>${rows}</tbody></table></div>`
        : `<p class="muted">No enquiries yet. They'll appear here the moment someone gets in touch.</p>`}
    </div>`;
}

const CALL_STATUS = { completed: "Answered", "no-answer": "Not answered", busy: "Engaged", failed: "Failed", canceled: "Missed", ringing: "In progress" };

function fmtDuration(sec) {
  if (sec === null || sec === undefined) return "–";
  return sec >= 60 ? `${Math.floor(sec / 60)}m ${sec % 60}s` : `${sec}s`;
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
      </div></div>`;
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
    <div class="panel"><h2>Call log</h2>
      ${d.calls.length
        ? `<div class="tablewrap"><table><thead><tr><th>When</th><th>Caller</th><th>Came from</th><th>Result</th><th class="num">Length</th><th>Enquiry</th></tr></thead><tbody>${rows}</tbody></table></div>`
        : `<p class="muted">No calls yet. They'll appear here as they come in.</p>`}
    </div>`;
}

function viewAds() {
  const d = state.data;
  const names = { google: "Google", meta: "Facebook and Instagram" };
  const byPlatform = {};
  for (const s of summarise(d).stats30) {
    const p = (byPlatform[s.platform] ||= { spend: 0, clicks: 0, enq: 0 });
    p.spend += s.spend_pence;
    p.clicks += s.clicks;
    p.enq += s.enquiries;
  }
  const rows = Object.entries(byPlatform).map(([k, p]) => `<tr>
      <td><b>${esc(names[k] || k)}</b></td><td class="num">${money(p.spend)}</td><td class="num">${p.clicks}</td>
      <td class="num">${p.enq}</td><td class="num">${p.enq ? money(p.spend / p.enq) : "–"}</td></tr>`).join("");
  return `<div class="pagehead"><h1>Ads</h1><p>What your Google and Facebook ads did over the last 30 days.</p></div>
    <div class="panel">
      ${rows
        ? `<div class="tablewrap"><table><thead><tr><th>Platform</th><th class="num">Spend</th><th class="num">Clicks</th><th class="num">Enquiries</th><th class="num">Cost per enquiry</th></tr></thead><tbody>${rows}</tbody></table></div>
           <p class="muted small mt">Numbers are updated automatically where your ad account is connected, otherwise by Alpha Analytica each week.</p>`
        : `<p class="muted">Your ad results will appear here once your campaigns are live.</p>`}
    </div>`;
}

function viewReports() {
  const d = state.data;
  return `<div class="pagehead"><h1>Reports</h1><p>A plain-English report every Monday.</p></div>
    <div class="panel"><h2>What you'll get</h2><ul class="checks">
      <li><b>A weekly report</b> on what came in, what it cost and what we're changing next.</li>
      <li><b>Every enquiry</b> logged in the Enquiries tab, with where it came from.</li>
      <li><b>Ad results</b> for Google and Facebook, week by week.</li>
      <li><b>Call log</b> once call tracking is switched on.</li>
    </ul></div>
    <div class="panel"><h2>Your reports</h2>
      ${d.reports.length
        ? d.reports.map((r) => `<details class="report"><summary><span>${esc(r.title)}</span><span class="muted">${esc(fmtDate(r.week_start))}</span></summary>
            <div class="report-body">${esc(r.body)}</div></details>`).join("")
        : `<p class="muted">No reports yet. The first one arrives on the Monday after your campaigns go live.</p>`}
    </div>`;
}

/* ---------- admin views ---------- */

function viewAdmin() {
  if (state.adminDetail) return viewAdminClient();
  const list = state.adminClients;
  return `<div class="pagehead"><h1>Admin</h1><p>Your clients, their progress and their results.</p></div>
    <div class="panel"><h2>Clients</h2>
      ${list === null ? `<p class="muted">Loading…</p>` : list.length
        ? `<div class="tablewrap"><table><thead><tr><th>Business</th><th>Sector</th><th class="num">Build</th><th class="num">Enquiries (30 days)</th><th></th></tr></thead><tbody>
            ${list.map((c) => `<tr><td><b>${esc(c.name)}</b></td><td>${esc(c.sector || "")}</td>
              <td class="num">${c.steps_done} of ${c.steps_total}</td><td class="num">${c.leads_30d}</td>
              <td><button class="btn btn-ghost btn-small" data-action="admin-open" data-id="${c.id}" type="button">Manage</button></td></tr>`).join("")}
          </tbody></table></div>`
        : `<p class="muted">No clients yet. Add your first one below.</p>`}
    </div>
    <div class="panel"><h2>Add a client</h2>
      <form class="form" data-form="create-client">
        <div class="field"><label for="cn">Business name</label><input id="cn" name="name" required maxlength="120"></div>
        <div class="field"><label for="cs">Sector</label><input id="cs" name="sector" maxlength="80" placeholder="Gym, plumber, salon…"></div>
        <button class="btn btn-primary" type="submit">Add client</button>
      </form></div>`;
}

function viewAdminClient() {
  const { client, users, steps, numbers } = state.adminDetail;
  const hook = `${location.origin}/api/ingest?key=${client.ingest_key}`;
  return `<div class="pagehead"><div class="rowhead"><h1>${esc(client.name)}</h1>
      <span><button class="btn btn-ghost btn-small" data-action="admin-back" type="button">All clients</button>
      <button class="btn btn-primary btn-small" data-action="view-as" data-id="${client.id}" type="button">View as client</button></span></div></div>

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

    <div class="panel"><h2>Ad accounts and calls</h2>
      <p class="muted small">Ad results pushed in automatically are matched to this business by these ids. Digits only; dashes are ignored.</p>
      <form class="form" data-form="accounts" data-id="${client.id}">
        <div class="field"><label for="gc">Google Ads customer id</label><input id="gc" name="google_customer_id" value="${esc(client.google_customer_id || "")}" placeholder="123-456-7890"></div>
        <div class="field"><label for="mc">Meta ad account id</label><input id="mc" name="meta_ad_account_id" value="${esc(client.meta_ad_account_id || "")}" placeholder="1234567890"></div>
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

async function loadAdminList() {
  state.adminClients = null;
  state.adminClients = (await api("/admin/clients")).clients;
}

async function loadAdminClient(id) {
  const [detail, portal] = await Promise.all([api(`/admin/clients/${id}`), api(`/portal?client=${id}`)]);
  state.adminDetail = { client: detail.client, users: detail.users, numbers: detail.numbers, steps: portal.steps };
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

  if (a === "remove-number") {
    if (!confirm("Remove this tracking number? Calls to it will stop being forwarded once it is removed here.")) return;
    return attempt(async () => {
      await api(`/admin/numbers/${el.dataset.id}`, { method: "DELETE" });
      await loadAdminClient(state.adminDetail.client.id);
      flash("ok", "Number removed.");
    });
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
      return attempt(async () => {
        const { id: newId } = await api("/admin/clients", { method: "POST", body: { name: f.name, sector: f.sector } });
        await loadAdminList();
        await loadAdminClient(newId);
        flash("ok", "Client added. Link their login below.");
      });

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

    case "accounts":
      return attempt(async () => {
        await api(`/admin/clients/${id}/accounts`, { method: "PATCH", body: {
          google_customer_id: f.google_customer_id, meta_ad_account_id: f.meta_ad_account_id, call_min_seconds: f.call_min_seconds } });
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
        await api(`/admin/clients/${id}/reports`, { method: "POST", body: { week_start: f.week_start, title: f.title, body: f.body } });
        form.reset();
        flash("ok", "Report posted. The client can see it now.");
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
  await attempt(enterPortal);
}

boot();
