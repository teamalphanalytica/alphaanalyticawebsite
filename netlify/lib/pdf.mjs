// The proposal PDF: a scorecard, a drawn mock-up of the new website (desktop and phone), the benefits and why they matter,
// a worked example of what it could be worth, how you pay, and the next step. Built in code: no fonts, images or files needed.
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { imageType } from "./screenshot.mjs";

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
    ["Easy to use on a phone", t(c.mobile)],
    ["Phone number customers can tap", t(c.tapToCall)],
    ["Clear \"get a quote\" button", t(c.callToAction)],
    ["Reviews and credentials visible", c.reviews === undefined && !f.accreditations ? null : !!(c.reviews || f.accreditations?.length)],
    ["Secure (shows the padlock)", t(c.https)],
    ["Shows where enquiries come from", c.analytics === undefined ? null : !!(c.analytics || c.adTracking)],
    ...(extras.rows || []),
  ];
}

export async function buildProposalPdf({ name, website, proposition: pr, audit, rankings = [], rankingsSource = "Google", phone = "", date = new Date(), contact = "", screenshots = {} }) {
  const doc = await PDFDocument.create();
  const reg = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const serif = await doc.embedFont(StandardFonts.TimesRomanBold);
  const embedImg = async (bytes) => {
    try {
      const t = imageType(bytes);
      return t === "png" ? await doc.embedPng(bytes) : t === "jpg" ? await doc.embedJpg(bytes) : null;
    } catch { return null; }
  };
  const shotD = await embedImg(screenshots.desktop);
  const shotM = await embedImg(screenshots.mobile);
  const hasShots = !!(shotD || shotM);
  const SHOT_H = 182;
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
      const hl = wrap(pr.headline || "", serif, 25, CW - 20);
      const bandH = 128 + hl.length * 29 + 18;
      rect(0, 0, W, bandH, MIDNIGHT);
      rect(0, bandH, W, 4, GOLD);
      page.drawText("Alpha Analytica", { x: M, y: H - 38, size: 12, font: serif, color: GOLD });
      page.drawText("AI-driven websites and adverts for service businesses.", { x: W - M - reg.widthOfTextAtSize("AI-driven websites and adverts for service businesses.", 8.5), y: H - 36, size: 8.5, font: reg, color: MIST });
      rect(M, 46, W - M * 2, 0.6, rgb(0.2, 0.25, 0.4));
      page.drawText("Proposal for", { x: M, y: H - 70, size: 10, font: reg, color: MIST });
      page.drawText(clip(name, bold, 13, CW - 120), { x: M, y: H - 88, size: 13, font: bold, color: WHITE });
      page.drawText(whenText, { x: W - M - reg.widthOfTextAtSize(whenText, 10), y: H - 70, size: 10, font: reg, color: MIST });
      rect(M, 104, 40, 3, GOLD);
      hl.forEach((l, i) => page.drawText(l, { x: M, y: H - 120 - 25 - i * 29, size: 25, font: serif, color: WHITE }));
      y = bandH + 4 + 22;
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
    rect(M, y + 1, 4, 13, GOLD);
    text(t, M + 11, y, 14.5, serif, MIDNIGHT);
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


  const BRING = [
    ["Pay per genuine enquiry", "No retainer. Spam and wrong numbers are free."],
    ["Website and adverts together", "We build the site and run the Google and Facebook adverts, so nothing falls between suppliers."],
    ["Reviewed every week", "Every Monday our AI reads your results and recommends changes. A person checks each one first."],
    ["Every enquiry traced", "Each advert gets its own phone number and form. You see what brought the work, in a private login."],
    ["Wasted spend cut", "Adverts that cost money and brought no enquiries are stopped, and the budget moves to those that did."],
    ["The founder, not an account manager", "We are a small Manchester business. You deal with the person running it."],
  ];
  const bringHeight = () => {
    const gw3 = (CW - 20) / 3;
    const hs = [0, 1].map((r) => Math.max(...BRING.slice(r * 3, r * 3 + 3).map(([t, d]) => wrap(t, bold, 9.5, gw3 - 22).length * 12 + wrap(d, reg, 8.5, gw3 - 22).length * 11 + 22)));
    return { gw3, hs, total: 36 + hs[0] + hs[1] + 10 };
  };
  const drawBring = () => {
    heading("What Alpha Analytica brings");
    const { gw3, hs } = bringHeight();
    BRING.forEach(([t, d], i) => {
      const r = Math.floor(i / 3), c = i % 3;
      const x = M + c * (gw3 + 10), yy = y + (r ? hs[0] + 8 : 0);
      rect(x, yy, gw3, 1.2, MIDNIGHT);
      const th = textIn(t, x + 1, yy + 9, gw3 - 12, 10, bold, MIDNIGHT, 1.25);
      textIn(d, x + 1, yy + 11 + th, gw3 - 12, 8.5, reg, SLATE, 1.3);
    });
    y += hs[0] + hs[1] + 18;
  };
  const BRING_SHORT = [
    "No retainer. Spam and wrong numbers are free.",
    "We build the site and run the adverts.",
    "A person checks every change AI recommends.",
    "Each advert has its own number and form.",
    "Budget moves from adverts that brought nothing.",
    "A small Manchester team. You deal with the founder.",
  ];
  const drawBringCompact = () => {
    heading("What Alpha Analytica brings");
    const hw = (CW - 14) / 2;
    BRING.forEach(([t], i) => {
      const x = M + (i % 2) * (hw + 14), yy = y + Math.floor(i / 3 * 0) + (i >> 1) * 30;
      rect(x, yy, hw, 0.8, MIDNIGHT);
      text(clip(t, bold, 9.5, hw - 18), x + 11, yy + 4, 9.5, bold, MIDNIGHT);
      text(clip(BRING_SHORT[i], reg, 8, hw - 18), x + 11, yy + 16, 8, reg, SLATE);
    });
    y += 3 * 30 + 6;
  };
  let bringOnPage1 = false;

  /* ---------------- page 1: where you stand ---------------- */
  header(true);
  const drawValue = () => {
    const v = pr.value_example;
    if (!v) return;
    heading("What this could be worth to you");
    const sw = (CW - 2 * 26) / 3;
    const stats = [
      [String(v.enquiries), "genuine enquiries a month"],
      [String(v.jobs), `jobs won, 1 in ${v.one_in} enquiries`],
      [money(v.total), `of work a month at ${money(v.job_value)} a ${v.job}`],
    ];
    need(100);
    stats.forEach(([big, small], i) => {
      const x = M + i * (sw + 26);
      rect(x, y, sw, 68, i === 2 ? MIDNIGHT : WHITE, MIDNIGHT);
      rect(x, y, 4, 68, GOLD);
      text(big, x + 16, y + 9, 26, serif, i === 2 ? GOLD : MIDNIGHT);
      textIn(small, x + 16, y + 42, sw - 24, 8.5, reg, i === 2 ? WHITE : SLATE, 1.25);
      if (i < 2) {
        const ax = x + sw + 6, ay = top(y + 31);
        page.drawLine({ start: { x: ax, y: ay }, end: { x: ax + 12, y: ay }, thickness: 1.6, color: GOLD });
        page.drawLine({ start: { x: ax + 8, y: ay + 3.5 }, end: { x: ax + 13, y: ay }, thickness: 1.6, color: GOLD });
        page.drawLine({ start: { x: ax + 8, y: ay - 3.5 }, end: { x: ax + 13, y: ay }, thickness: 1.6, color: GOLD });
      }
    });
    y += 76;
    para("Illustrative numbers to show how it adds up. They are not a forecast or a promise. On our call we use your own figures.", { size: 8, color: SLATE, gap: 6 });
  };

  // Does everything fit on page 1? If not, the worked example moves to page 3.
  const p1Need = (() => {
    const fh = (pr.findings || []).reduce((a, f) => a + wrap(f.title, bold, 10.5, CW - 12).length * 14.2 + 1 + wrap(f.detail, reg, 10.5, CW - 12).length * 14.2 + 8, 0);
    const rk = (rankings || []).some((r) => r.bucket && r.bucket !== "unknown") ? 170 : 0;
    return (hasShots ? SHOT_H + 60 : 42 + 35 + Math.ceil(scoreRows(audit).filter((r) => r[1] === false).length / 2) * 24 + 20) + rk + 35 + fh;
  })();
  const valueOnPage1 = y + 130 + p1Need < H - 62;
  if (valueOnPage1) drawValue();
  {
    const ph2 = 34;
    rect(M, y, CW, ph2, GOLD);
    text("No retainer. You pay only for genuine enquiries.", M + 14, y + 7, 11, bold, MIDNIGHT);
    text("Spam, sales calls and wrong numbers are free. Every enquiry is logged so you can check.", M + 14, y + 22, 8, reg, MIDNIGHT);
    y += ph2 + 8;
  }

  const missing = scoreRows(audit).filter((r) => r[1] === false);
  if (missing.length && !hasShots) {
    heading("What your website is missing");
    const colW = CW / 2;
    missing.forEach((r, i) => {
      const cx = M + (i % 2) * colW;
      const ct = y + Math.floor(i / 2) * 24;
      rect(cx, ct + 18, colW - 14, 0.6, RULE);
      tick(cx + 14, ct + 7.5, false);
      text(r[0], cx + 28, ct + 3, 10, reg, INK);
    });
    y += Math.ceil(missing.length / 2) * 24 + 2;
    para("Things we could not find on a public look at your website.", { size: 8.5, color: SLATE, gap: 6 });
  }

  const ranked = (rankings || []).filter((r) => r.bucket && r.bucket !== "unknown").slice(0, 3);
  if (ranked.length) {
    heading(`Do customers find you? (${rankingsSource})`);
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

  if (hasShots) {
    heading("Your website today");
    const T0 = y;
    const imgIn = (img, x, t, w, h) => {
      const sc = Math.min(w / img.width, h / img.height);
      const dw = img.width * sc, dh = img.height * sc;
      page.drawImage(img, { x: x + (w - dw) / 2, y: top(t) - dh, width: dw, height: dh });
      return dh;
    };
    let dx = M;
    if (shotD) {
      const ratio = shotD.height / shotD.width;
      const dw = Math.min(shotM ? CW - 130 : CW, (SHOT_H - 16) / ratio);
      const dh = dw * ratio;
      rect(dx, T0, dw, 14, rgb(0.93, 0.94, 0.97), RULE);
      [0, 1, 2].forEach((i) => page.drawCircle({ x: dx + 9 + i * 8, y: top(T0 + 7), size: 2.2, color: GREY }));
      text(clip((website || "").replace(/^https?:\/\//, "").replace(/\/$/, ""), reg, 6.5, dw - 60), dx + 40, T0 + 4, 6.5, reg, SLATE);
      rect(dx, T0 + 14, dw, dh, WHITE, RULE);
      imgIn(shotD, dx, T0 + 14, dw, dh);
      text("On a computer", dx, T0 + 14 + dh + 5, 8, bold, SLATE);
      y = Math.max(y, T0 + 14 + dh + 18);
      dx += dw + 16;
    }
    if (shotM) {
      const mw = shotD ? 114 : 140, mh = SHOT_H - 14;
      rect(dx, T0, mw, mh, MIDNIGHT);
      const ih = imgIn(shotM, dx + 4, T0 + 8, mw - 8, mh - 16);
      text("On a phone", dx, T0 + mh + 5, 8, bold, SLATE);
      y = Math.max(y, T0 + mh + 18);
    }
    para(`Captured ${whenText}. This is what a customer sees first, before they scroll.`, { size: 8.5, color: SLATE, gap: 6 });
  }

  heading("What we found");
  for (const f of pr.findings) {
    // Page 1 holds the findings; any that would spill over are left out (they are in order of importance).
    const fh = wrap(f.title, bold, 10.5, CW - 12).length * 14.2 + wrap(f.detail, reg, 10.5, CW - 12).length * 14.2 + 9;
    if (y + fh > H - 62) break;
    rect(M, y + 1, 3, 13, GOLD);
    para(f.title, { font: bold, indent: 12, gap: 1 });
    para(f.detail, { indent: 12, color: SLATE, gap: 8 });
  }

  if (y + bringHeight().total + 6 < H - 52) { drawBring(); bringOnPage1 = true; }
  else if (y + 35 + 96 < H - 52) { drawBringCompact(); bringOnPage1 = true; }

  /* ---------------- page 2: the new website ---------------- */
  header(false);
  rect(M, y + 1, 4, 13, GOLD);
  text("What your new website could look like", M + 11, y, 14.5, serif, MIDNIGHT);
  y += 19;
  rect(M, y, CW, 1, RULE);
  y += 8;
  y += textIn("A concept to show the layout. Your photos, wording and branding replace the placeholders, and we agree the final design with you before anything goes live.", M, y, CW, 9, reg, SLATE) + 8;

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
    ["Your credentials and reviews straight under the headline", "Reviews and accreditations sit where a visitor looks first."],
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
    heading("What we'd do for you");
    pr.plan.forEach((item, i) => {
      need(30);
      text(String(i + 1), M, y, 10.5, bold, GOLD);
      para(item, { indent: 18, gap: 4 });
    });
  }

  /* ---------------- page 3: how the AI works, and what it could be worth ---------------- */
  header(false);
  rect(M, y + 1, 4, 13, GOLD);
  text("How our AI works for you, every week", M + 11, y, 14.5, serif, MIDNIGHT);
  y += 19;
  rect(M, y, CW, 1, RULE);
  y += 12;
  y += textIn("We build and run websites and adverts for local service businesses, with AI doing the reading and a person making the decisions. This is the loop that runs on your account.", M, y, CW, 10, reg, SLATE, 1.35) + 10;
  const loop = [
    ["Track", "Every call and form is logged against the advert that caused it."],
    ["Read", "Each Monday our AI reads the last seven days of spend, enquiries and spam."],
    ["Recommend", "It flags what to stop, what to fund and what to change on the site."],
    ["Check and act", "A person reviews every recommendation before anything changes."],
  ];
  const lw4 = (CW - 3 * 22) / 4;
  const lh = Math.max(...loop.map(([t, d]) => 30 + wrap(d, reg, 8.5, lw4 - 20).length * 11.5)) + 10;
  need(lh + 20);
  loop.forEach(([t, d], i) => {
    const x = M + i * (lw4 + 22);
    rect(x, y, lw4, lh, i === 3 ? MIDNIGHT : WHITE, MIDNIGHT);
    rect(x, y, lw4, 4, GOLD);
    text(t, x + 10, y + 13, 12, serif, i === 3 ? WHITE : MIDNIGHT);
    textIn(d, x + 10, y + 31, lw4 - 20, 8.5, reg, i === 3 ? MIST : SLATE, 1.35);
    if (i < 3) {
      const ax = x + lw4 + 4, ay = top(y + lh / 2);
      page.drawLine({ start: { x: ax, y: ay }, end: { x: ax + 12, y: ay }, thickness: 1.6, color: GOLD });
      page.drawLine({ start: { x: ax + 8, y: ay + 3.5 }, end: { x: ax + 13, y: ay }, thickness: 1.6, color: GOLD });
      page.drawLine({ start: { x: ax + 8, y: ay - 3.5 }, end: { x: ax + 13, y: ay }, thickness: 1.6, color: GOLD });
    }
  });
  y += lh + 6;
  para("The loop repeats every week, so your adverts and website keep improving instead of staying as they were on launch day.", { size: 9, color: SLATE, gap: 8 });

  if (!valueOnPage1) drawValue();
  const room = () => H - 62 - y - 205;
  if (!bringOnPage1) { if (bringHeight().total < room()) drawBring(); else drawBringCompact(); }

  if ((pr.benefits || []).length && Math.ceil(Math.min(6, pr.benefits.length) / 2) * 36 + 40 < room()) {
    heading("Built into every site we make");
    const bh = pr.benefits.slice(0, 6);
    const hw2 = (CW - 16) / 2;
    bh.forEach((b, i) => {
      const x = M + (i % 2) * (hw2 + 16), yy = y + (i >> 1) * 36;
      need(0);
      rect(x, yy + 1, 8, 8, GOLD);
      text(clip(b.title, bold, 9.5, hw2 - 18), x + 15, yy, 9.5, bold, INK);
      textIn(b.value, x + 15, yy + 12, hw2 - 18, 8.5, reg, SLATE, 1.25);
    });
    y += Math.ceil(bh.length / 2) * 36 + 4;
  }

  heading("What it costs, and what happens next");
  para(pr.offer, { gap: 6 });
  [
    ["A ten-minute call", "We talk through this and what you'd want. No obligation."],
    ["We show you the design", "We agree your new website with you before anything goes live."],
    ["Weekly reviews", "Every Monday we review your results. You see every enquiry and call in your own login."],
  ].forEach(([t, d], i) => {
    need(24);
    page.drawCircle({ x: M + 7, y: top(y + 6), size: 7, color: GOLD });
    page.drawText(String(i + 1), { x: M + 4.6, y: top(y + 6) - 3.2, size: 9, font: bold, color: MIDNIGHT });
    text(t, M + 22, y, 10, bold, INK);
    text(d, M + 22, y + 12, 9, reg, SLATE);
    y += 26;
  });
  if (contact) {
    y += 4;
    const ch = 40;
    need(ch + 6);
    rect(M, y, CW, ch, MIDNIGHT);
    rect(M, y, 4, ch, GOLD);
    text("Want to talk it through?", M + 16, y + 8, 10.5, bold, GOLD);
    text(clip(contact, reg, 10, CW - 32), M + 16, y + 23, 10, reg, WHITE);
    y += ch + 4;
  }

  const pages = doc.getPages();
  pages.forEach((pg, i) => {
    pg.drawRectangle({ x: M, y: 44, width: CW, height: 0.6, color: RULE });
    pg.drawText(pdfSafe(`Based on a public look at ${website || "your online presence"} on ${date.toLocaleDateString("en-GB")}. Alpha Analytica, Manchester.   Page ${i + 1} of ${pages.length}`), { x: M, y: 28, size: 8, font: reg, color: SLATE });
  });
  doc.setTitle(pdfSafe(`Proposal for ${name}`));
  doc.setAuthor("Alpha Analytica");
  return await doc.save();
}
