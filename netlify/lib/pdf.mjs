// The proposal PDF: a scorecard, a drawn mock-up of the new website (desktop and phone), the benefits and why they matter,
// a worked example of what it could be worth, how you pay, and the next step. Built in code: no fonts, images or files needed.
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

const MIDNIGHT = rgb(0.039, 0.067, 0.157);
const GOLD = rgb(1, 0.718, 0.012);
const INK = rgb(0.1, 0.12, 0.2);
const SLATE = rgb(0.38, 0.42, 0.52);
const MIST = rgb(0.8, 0.84, 0.92);
const RULE = rgb(0.88, 0.9, 0.94);
const TINT = rgb(0.96, 0.965, 0.985);
const WHITE = rgb(1, 1, 1);
const GREEN = rgb(0.1, 0.55, 0.32);
const RED = rgb(0.78, 0.2, 0.2);
const GREY = rgb(0.6, 0.63, 0.7);

/** Standard PDF fonts only cover Latin-1, so swap anything else for a plain look-alike. */
export function pdfSafe(s) {
  return String(s ?? "")
    .replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-").replace(/…/g, "...").replace(/[•·]/g, "-")
    .replace(/ /g, " ")
    .replace(/[^\x20-\x7E£©]/g, "");
}

export function wrap(text, font, size, width) {
  const lines = [];
  for (const para of pdfSafe(text).split(/\n/)) {
    let line = "";
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const next = line ? line + " " + word : word;
      if (font.widthOfTextAtSize(next, size) <= width) line = next;
      else {
        if (line) lines.push(line);
        line = word;
      }
    }
    lines.push(line);
  }
  return lines;
}

const clip = (text, font, size, width) => {
  let t = pdfSafe(text);
  if (font.widthOfTextAtSize(t, size) <= width) return t;
  while (t.length > 1 && font.widthOfTextAtSize(t + "...", size) > width) t = t.slice(0, -1);
  return t.trimEnd() + "...";
};

const money = (n) => "£" + Number(n).toLocaleString("en-GB");

/** The scorecard: only things the website check actually observed. null means we couldn't tell. */
export function scoreRows(audit, extras = {}) {
  const c = audit?.checks || {};
  const f = c.facts || {};
  const t = (v) => (v === undefined ? null : v);
  return [
    ["Works well on a phone", t(c.mobile)],
    ["Number you can tap to call", t(c.tapToCall)],
    ["Clear \"get a quote\" prompt", t(c.callToAction)],
    ["Reviews or credentials shown", c.reviews === undefined && !f.accreditations ? null : !!(c.reviews || f.accreditations?.length)],
    ["Secure (padlock in the browser)", t(c.https)],
    ["Measures where enquiries come from", c.analytics === undefined ? null : !!(c.analytics || c.adTracking)],
    ...(extras.rows || []),
  ];
}

export async function buildProposalPdf({ name, website, proposition: pr, audit, rankings = [], rankingsSource = "Google", phone = "", date = new Date(), contact = "" }) {
  const doc = await PDFDocument.create();
  const reg = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const W = 595.28, H = 841.89, M = 44, CW = W - M * 2;
  let page, y;

  const whenText = date.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
  const top = (t) => H - t; // measure from the top of the page
  const rect = (x, t, w, h, fill, border) => page.drawRectangle({ x, y: top(t) - h, width: w, height: h, color: fill, ...(border ? { borderColor: border, borderWidth: 0.7 } : {}) });
  const text = (t, x, tt, size, font = reg, color = INK) => page.drawText(pdfSafe(t), { x, y: top(tt) - size, size, font, color });
  const textIn = (t, x, tt, w, size, font = reg, color = INK, lead = 1.25) => {
    const lines = wrap(t, font, size, w);
    lines.forEach((l, i) => text(l, x, tt + i * size * lead, size, font, color));
    return lines.length * size * lead;
  };

  const header = (first) => {
    page = doc.addPage([W, H]);
    if (first) {
      rect(0, 0, W, 90, MIDNIGHT);
      page.drawText("Alpha Analytica", { x: M, y: H - 50, size: 20, font: bold, color: WHITE });
      rect(M, 58, 36, 3, GOLD);
      page.drawText(pdfSafe(`Proposal for ${name}`), { x: M, y: H - 80, size: 10.5, font: reg, color: MIST });
      page.drawText(whenText, { x: W - M - reg.widthOfTextAtSize(whenText, 10.5), y: H - 80, size: 10.5, font: reg, color: MIST });
      y = 90 + 28;
    } else {
      rect(0, 0, W, 14, MIDNIGHT);
      y = 14 + 30;
    }
  };
  const need = (h) => { if (y + h > H - 62) header(false); };
  const para = (t, { size = 10.5, font = reg, color = INK, indent = 0, gap = 4, lead = 1.35, width = CW - indent } = {}) => {
    for (const line of wrap(t, font, size, width)) {
      need(size * lead);
      text(line, M + indent, y, size, font, color);
      y += size * lead;
    }
    y += gap;
  };
  const heading = (t) => {
    need(80);
    y += 4;
    text(t, M, y, 13, bold, MIDNIGHT);
    y += 19;
    rect(M, y, CW, 1, RULE);
    y += 12;
  };
  const tick = (cx, ct, state) => {
    const cy = top(ct);
    if (state === true) {
      page.drawCircle({ x: cx, y: cy, size: 6, color: GREEN });
      page.drawLine({ start: { x: cx - 3, y: cy }, end: { x: cx - 0.8, y: cy - 2.4 }, thickness: 1.4, color: WHITE });
      page.drawLine({ start: { x: cx - 0.8, y: cy - 2.4 }, end: { x: cx + 3.2, y: cy + 2.6 }, thickness: 1.4, color: WHITE });
    } else if (state === false) {
      page.drawCircle({ x: cx, y: cy, size: 6, color: RED });
      page.drawLine({ start: { x: cx - 2.4, y: cy - 2.4 }, end: { x: cx + 2.4, y: cy + 2.4 }, thickness: 1.4, color: WHITE });
      page.drawLine({ start: { x: cx - 2.4, y: cy + 2.4 }, end: { x: cx + 2.4, y: cy - 2.4 }, thickness: 1.4, color: WHITE });
    } else {
      page.drawCircle({ x: cx, y: cy, size: 6, color: GREY });
      page.drawText("?", { x: cx - 2.2, y: cy - 3, size: 8, font: bold, color: WHITE });
    }
  };
  const badge = (cx, ct, n) => {
    page.drawCircle({ x: cx, y: top(ct), size: 6.5, color: GOLD, borderColor: MIDNIGHT, borderWidth: 0.8 });
    page.drawText(String(n), { x: cx - (n > 9 ? 4 : 2.3), y: top(ct) - 3, size: 8, font: bold, color: MIDNIGHT });
  };

  /* ---------------- page 1: where you stand ---------------- */
  header(true);
  para(pr.headline, { size: 20, font: bold, color: MIDNIGHT, gap: 6, lead: 1.22 });
  para(pr.summary, { size: 11, color: SLATE, gap: 6 });

  heading("Where you stand today");
  const rows = scoreRows(audit);
  const colW = CW / 2;
  rows.forEach((r, i) => {
    const cx = M + (i % 2) * colW;
    const ct = y + Math.floor(i / 2) * 24;
    rect(cx, ct - 3, colW - 8, 21, TINT);
    tick(cx + 14, ct + 7.5, r[1]);
    text(r[0], cx + 28, ct + 3, 10, reg, INK);
  });
  y += Math.ceil(rows.length / 2) * 24 + 2;
  para("Green is something we saw working, red is something we could not find, grey means we couldn't tell from a public look.", { size: 8.5, color: SLATE, gap: 6 });

  const ranked = (rankings || []).filter((r) => r.bucket && r.bucket !== "unknown").slice(0, 3);
  if (ranked.length) {
    heading(`Where you show up on ${rankingsSource}`);
    const gap = 10, cw = (CW - gap * (ranked.length - 1)) / ranked.length;
    const lines = ranked.map((r) => wrap(`"${r.query}"`, bold, 9, cw - 20).length);
    const h = Math.max(...lines) * 11.5 + 56;
    need(h + 24);
    ranked.forEach((r, i) => {
      const x = M + i * (cw + gap);
      const good = r.bucket === "top3" || r.bucket === "top10";
      rect(x, y, cw, h, TINT);
      rect(x, y, 3, h, good ? GREEN : RED);
      const qh = textIn(`"${r.query}"`, x + 12, y + 8, cw - 20, 9, bold, INK, 1.28);
      const label = r.bucket === "top3" ? "In the top 3" : r.bucket === "top10" ? "On the first page" : r.bucket === "later" ? "Not on the first page" : "Not found";
      rect(x + 12, y + 12 + qh, Math.min(cw - 24, bold.widthOfTextAtSize(label, 8.5) + 16), 14, good ? GREEN : RED);
      text(label, x + 20, y + 15.5 + qh, 8.5, bold, WHITE);
      const extra = [r.position ? `Position ${r.position}` : null, r.map_pack === true ? "In the map results" : r.map_pack === false ? "Not in the map results" : null].filter(Boolean).join(" · ".replace("·", "-"));
      if (extra) textIn(extra, x + 12, y + 32 + qh, cw - 20, 8, reg, SLATE);
    });
    y += h + 6;
    const when = new Date(rankings.find((r) => r.checked_at)?.checked_at || date).toLocaleDateString("en-GB");
    para(`What a local customer sees when they search. Checked ${when}. Results vary a little by location and device.`, { size: 8.5, color: SLATE, gap: 6 });
  }

  heading("What we noticed");
  for (const f of pr.findings) {
    need(56);
    rect(M, y + 1, 3, 13, GOLD);
    para(f.title, { font: bold, indent: 12, gap: 1 });
    para(f.detail, { indent: 12, color: SLATE, gap: 8 });
  }

  /* ---------------- page 2: the new website ---------------- */
  header(false);
  text("What your new website could look like", M, y, 13, bold, MIDNIGHT);
  y += 19;
  rect(M, y, CW, 1, RULE);
  y += 8;
  y += textIn("A concept to show the layout and the thinking. Your photos, wording and branding replace the placeholders, and we agree the final design with you before anything goes live.", M, y, CW, 9, reg, SLATE) + 8;

  const cn = pr.concept || {};
  const ph = phone || cn.phone || "";
  const T = y;
  // desktop browser
  const bw = CW, bh = 272;
  rect(M, T, bw, bh, WHITE, RULE);
  rect(M, T, bw, 16, rgb(0.93, 0.94, 0.97));
  [0, 1, 2].forEach((i) => page.drawCircle({ x: M + 10 + i * 9, y: top(T + 8), size: 2.3, color: GREY }));
  rect(M + 44, T + 3.5, 220, 9, WHITE);
  text(clip((website || "yourbusiness.co.uk").replace(/^https?:\/\//, "").replace(/\/$/, ""), reg, 6, 210), M + 49, T + 5, 6, reg, SLATE);
  // nav
  text(clip(name, bold, 9, 190), M + 12, T + 24, 9, bold, MIDNIGHT);
  const links = (cn.services || []).slice(0, 3);
  let lx = M + 215;
  [...links.map((l) => clip(l, reg, 6.5, 70)), "Areas", "Contact"].forEach((l) => {
    const w = reg.widthOfTextAtSize(l, 6.5);
    if (lx + w > M + bw - 130) return;
    text(l, lx, T + 26, 6.5, reg, SLATE);
    lx += w + 14;
  });
  rect(M + bw - 112, T + 20, 100, 15, GOLD);
  text(clip(ph ? `Call ${ph}` : "Call us now", bold, 7, 92), M + bw - 106, T + 24.5, 7, bold, MIDNIGHT);
  // hero
  const hy = T + 42;
  rect(M, hy, bw, 108, MIDNIGHT);
  textIn(cn.tagline || pr.headline, M + 14, hy + 14, 290, 15, bold, WHITE, 1.2);
  textIn(cn.subline || "", M + 14, hy + 68, 270, 7.5, reg, MIST);
  rect(M + 14, hy + 84, 86, 17, GOLD);
  text("Get a free quote", M + 24, hy + 89, 7.5, bold, MIDNIGHT);
  rect(M + 108, hy + 84, 62, 17, MIDNIGHT, MIST);
  text("Call now", M + 123, hy + 89, 7.5, bold, WHITE);
  // quote form
  rect(M + bw - 182, hy + 8, 168, 92, WHITE);
  text("Get your free quote", M + bw - 172, hy + 17, 8.5, bold, MIDNIGHT);
  ["Your name", "Phone number", "What do you need?"].forEach((l, i) => { rect(M + bw - 172, hy + 33 + i * 18, 148, 13, TINT, RULE); text(l, M + bw - 168, hy + 36.5 + i * 18, 6.5, reg, GREY); });
  rect(M + bw - 172, hy + 82, 148, 13, GOLD);
  text("Send my enquiry", M + bw - 128, hy + 85.5, 7, bold, MIDNIGHT);
  // trust strip
  const ty = hy + 108;
  rect(M, ty, bw, 26, TINT);
  const trust = (cn.trust && cn.trust.length ? cn.trust : ["Your reviews here", "Your accreditations here"]).slice(0, 4);
  trust.forEach((t, i) => {
    const tx = M + 14 + i * (bw / trust.length);
    rect(tx, ty + 9, 7, 7, GOLD);
    text(clip(t, bold, 7, bw / trust.length - 26), tx + 12, ty + 9, 7, bold, INK);
  });
  // services
  const sy = ty + 34;
  text("What we do", M + 14, sy, 8.5, bold, MIDNIGHT);
  const svc = (cn.services && cn.services.length ? cn.services : ["Service one", "Service two", "Service three", "Service four"]).slice(0, 4);
  const cw4 = (bw - 28 - 3 * 8) / 4;
  svc.forEach((s2, i) => {
    const sx = M + 14 + i * (cw4 + 8);
    rect(sx, sy + 14, cw4, 52, WHITE, RULE);
    rect(sx, sy + 14, cw4, 3, GOLD);
    textIn(s2, sx + 7, sy + 24, cw4 - 14, 7.5, bold, INK);
    rect(sx + 7, sy + 46, cw4 - 24, 3, RULE);
    rect(sx + 7, sy + 54, cw4 - 40, 3, RULE);
  });
  // desktop callout badges
  badge(M + bw - 120, T + 27, 1);
  badge(M + bw - 190, hy + 20, 2);
  badge(M + 6, ty + 13, 3);
  badge(M + bw - 6, sy + 18, 4);

  // phone
  const PT = T + bh + 14;
  const pw = 112, phh = 210, px = M + 8;
  rect(px, PT, pw, phh, WHITE, MIDNIGHT);
  rect(px + 36, PT + 3, 40, 3, MIDNIGHT);
  text(clip(name, bold, 7, pw - 16), px + 8, PT + 14, 7, bold, MIDNIGHT);
  rect(px, PT + 26, pw, 74, MIDNIGHT);
  textIn(cn.tagline || pr.headline, px + 8, PT + 33, pw - 16, 8.5, bold, WHITE, 1.2);
  rect(px + 8, PT + 80, 68, 14, GOLD);
  text("Get a free quote", px + 13, PT + 84, 6.5, bold, MIDNIGHT);
  trust.slice(0, 3).forEach((t, i) => { rect(px + 8, PT + 108 + i * 15, 6, 6, GOLD); text(clip(t, bold, 6.5, pw - 34), px + 19, PT + 108 + i * 15, 6.5, bold, INK); });
  rect(px, PT + phh - 26, pw, 26, TINT);
  rect(px + 6, PT + phh - 21, 48, 16, GOLD);
  text("Call now", px + 14, PT + phh - 16, 6.5, bold, MIDNIGHT);
  rect(px + 58, PT + phh - 21, 48, 16, MIDNIGHT);
  text("Get a quote", px + 62, PT + phh - 16, 6.5, bold, WHITE);
  badge(px + pw - 4, PT + phh - 26, 1);

  // what changes
  const cx = px + pw + 40;
  const calls = [
    ["A call button that is always there", "In the header on a computer, and pinned to the bottom of the screen on a phone, so a customer can ring with one tap."],
    ["A quote form beside the first thing they read", "A short form with three questions, so asking for a quote takes seconds."],
    ["Your credentials and reviews straight under the headline", "The things that make someone trust you are seen first, not buried."],
    ["A clear page for each service", "Each service (and later each town) gets its own page, so Google has more to show for what people search."],
  ];
  let cy = PT + 2;
  calls.forEach(([t, d], i) => {
    badge(cx + 8, cy + 8, i + 1);
    text(t, cx + 24, cy + 3, 9.5, bold, INK);
    const h2 = textIn(d, cx + 24, cy + 16, W - M - cx - 24, 8.5, reg, SLATE, 1.3);
    cy += 16 + h2 + 12;
  });
  y = Math.max(PT + phh, cy) + 6;
  text("Concept for illustration only. Logos, photos and wording are placeholders until we agree your design.", M, y, 7.5, reg, SLATE);
  y += 8;
  if (pr.plan && pr.plan.length) {
    heading("What we would do");
    pr.plan.forEach((item, i) => {
      need(30);
      text(String(i + 1), M, y, 10.5, bold, GOLD);
      para(item, { indent: 18, gap: 4 });
    });
  }

  /* ---------------- page 3: benefits and value ---------------- */
  header(false);
  text("What you get, and why it matters", M, y, 13, bold, MIDNIGHT);
  y += 19;
  rect(M, y, CW, 1, RULE);
  y += 10;
  const cols = [128, 200, CW - 128 - 200];
  rect(M, y, CW, 17, MIDNIGHT);
  ["What you get", "Why it matters", "What it means for you"].forEach((h, i) => text(h, M + 8 + (i === 0 ? 0 : cols.slice(0, i).reduce((a, b) => a + b, 0)), y + 4.5, 8.5, bold, WHITE));
  y += 17;
  (pr.benefits || []).forEach((b, i) => {
    const size = 8.5;
    const l1 = wrap(b.title, bold, size + 0.5, cols[0] - 14);
    const l2 = wrap(b.why, reg, size, cols[1] - 14);
    const l3 = wrap(b.value, reg, size, cols[2] - 12);
    const h = Math.max(l1.length, l2.length, l3.length) * size * 1.3 + 9;
    need(h);
    rect(M, y, CW, h, i % 2 ? WHITE : TINT);
    l1.forEach((l, k) => text(l, M + 8, y + 4.5 + k * (size + 0.5) * 1.3, size + 0.5, bold, INK));
    l2.forEach((l, k) => text(l, M + cols[0] + 6, y + 4.5 + k * size * 1.3, size, reg, INK));
    l3.forEach((l, k) => text(l, M + cols[0] + cols[1] + 6, y + 4.5 + k * size * 1.3, size, reg, INK));
    y += h;
  });
  y += 14;

  const v = pr.value_example;
  if (v) {
    need(90);
    rect(M, y, CW, 76, TINT);
    rect(M, y, 4, 76, GOLD);
    text("What it could be worth: an example", M + 16, y + 9, 11, bold, MIDNIGHT);
    textIn(`Say your new website and adverts bring in ${v.enquiries} genuine enquiries a month. If 1 in ${v.one_in} turns into a ${v.job} worth ${money(v.job_value)}, that is ${v.jobs} jobs and ${money(v.total)} of work a month.`, M + 16, y + 26, CW - 32, 9.5, reg, INK, 1.35);
    textIn("Illustrative numbers to show how it adds up. They are not a forecast or a promise. On our call we use your own figures.", M + 16, y + 56, CW - 32, 8, reg, SLATE);
    y += 88;
  }

  heading("Why a small, AI-driven agency");
  const why = [
    ["You deal with the person running it", "We're a small Manchester business. You talk to the founder, not an account manager passing messages along."],
    ["Your results are reviewed every week", "Every Monday our AI reads your last seven days: spend, enquiries, spam, which campaigns bring customers. It recommends changes and we check each one before it's made."],
    ["Your adverts keep improving", "Adverts that are set up once and left tend to drift. Yours are looked at every week, so wasted spend is cut and what works gets more of the budget."],
    ["You see what we see", "Your private login shows every enquiry and call, and where it came from."],
  ];
  const gw = (CW - 12) / 2;
  for (let r = 0; r < 2; r++) {
    const pair = why.slice(r * 2, r * 2 + 2);
    const hs = pair.map(([t, d]) => wrap(t, bold, 9.5, gw - 22).length * 12 + wrap(d, reg, 8.5, gw - 22).length * 11.2 + 16);
    const h = Math.max(...hs);
    need(h + 8);
    pair.forEach(([t, d], i) => {
      const x = M + i * (gw + 12);
      rect(x, y, gw, h, TINT);
      rect(x, y, 3, h, GOLD);
      const th = textIn(t, x + 12, y + 7, gw - 22, 9.5, bold, INK, 1.25);
      textIn(d, x + 12, y + 9 + th, gw - 22, 8.5, reg, SLATE, 1.3);
    });
    y += h + 8;
  }
  y += 2;

  heading("How you pay, and the next step");
  para(pr.offer, { gap: 5 });
  para("Let's find ten minutes to talk it through. There's no obligation.", { gap: 4 });
  if (contact) para(contact, { font: bold, gap: 2 });

  const pages = doc.getPages();
  pages.forEach((pg, i) => {
    pg.drawText(pdfSafe(`Based on a public look at ${website || "your online presence"} on ${date.toLocaleDateString("en-GB")}. Alpha Analytica, Manchester.   Page ${i + 1} of ${pages.length}`), { x: M, y: 28, size: 8, font: reg, color: SLATE });
  });
  doc.setTitle(pdfSafe(`Proposal for ${name}`));
  doc.setAuthor("Alpha Analytica");
  return await doc.save();
}
