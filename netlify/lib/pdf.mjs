// A clean one- or two-page A4 proposal, built in code (no fonts or files needed).
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

const MIDNIGHT = rgb(0.039, 0.067, 0.157);
const GOLD = rgb(1, 0.718, 0.012);
const INK = rgb(0.1, 0.12, 0.2);
const SLATE = rgb(0.38, 0.42, 0.52);
const RULE = rgb(0.88, 0.9, 0.94);

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

export async function buildProposalPdf({ name, website, proposition: pr, niche, date = new Date(), contact = "" }) {
  const doc = await PDFDocument.create();
  const reg = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const W = 595.28, H = 841.89, M = 48, CW = W - M * 2;
  let page, y;

  const header = (first) => {
    page = doc.addPage([W, H]);
    if (first) {
      page.drawRectangle({ x: 0, y: H - 96, width: W, height: 96, color: MIDNIGHT });
      page.drawText("Alpha Analytica", { x: M, y: H - 52, size: 20, font: bold, color: rgb(1, 1, 1) });
      page.drawRectangle({ x: M, y: H - 62, width: 36, height: 3, color: GOLD });
      page.drawText(pdfSafe(`Proposal for ${name}`), { x: M, y: H - 82, size: 10.5, font: reg, color: rgb(0.8, 0.84, 0.92) });
      const when = date.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
      const w = reg.widthOfTextAtSize(when, 10.5);
      page.drawText(when, { x: W - M - w, y: H - 82, size: 10.5, font: reg, color: rgb(0.8, 0.84, 0.92) });
      y = H - 96 - 40;
    } else {
      page.drawRectangle({ x: 0, y: H - 14, width: W, height: 14, color: MIDNIGHT });
      y = H - 14 - 40;
    }
  };
  const need = (h) => { if (y - h < 70) header(false); };
  const para = (text, { size = 11, font = reg, color = INK, indent = 0, gap = 5, lead = 1.4 } = {}) => {
    for (const line of wrap(text, font, size, CW - indent)) {
      need(size * lead);
      page.drawText(line, { x: M + indent, y, size, font, color });
      y -= size * lead;
    }
    y -= gap;
  };
  const heading = (text) => {
    need(50);
    y -= 8;
    page.drawText(pdfSafe(text), { x: M, y, size: 13, font: bold, color: MIDNIGHT });
    y -= 6;
    page.drawRectangle({ x: M, y, width: CW, height: 1, color: RULE });
    y -= 18;
  };

  header(true);
  para(pr.headline, { size: 20, font: bold, color: MIDNIGHT, gap: 8, lead: 1.25 });
  para(pr.summary, { size: 11.5, color: SLATE, gap: 10 });

  heading("What we noticed");
  for (const f of pr.findings) {
    need(60);
    page.drawRectangle({ x: M, y: y - 3, width: 3, height: 13, color: GOLD });
    para(f.title, { font: bold, indent: 12, gap: 1 });
    para(f.detail, { indent: 12, color: SLATE, gap: 9 });
  }

  heading("What we would do");
  pr.plan.forEach((item, i) => {
    need(30);
    page.drawText(String(i + 1), { x: M, y, size: 11, font: bold, color: GOLD });
    para(item, { indent: 18, gap: 4 });
  });

  heading("How you pay");
  para(pr.offer, { gap: 8 });

  heading("Next step");
  para(pr.cover_note ? "Let's find ten minutes to talk it through. There's no obligation." : "Let's find ten minutes to talk it through.", { gap: 4 });
  if (contact) para(contact, { font: bold, gap: 4 });

  const pages = doc.getPages();
  pages.forEach((pg, i) => {
    const note = pdfSafe(`Based on a public look at ${website || "your online presence"} on ${date.toLocaleDateString("en-GB")}. Alpha Analytica, Manchester.   Page ${i + 1} of ${pages.length}`);
    pg.drawText(note, { x: M, y: 32, size: 8, font: reg, color: SLATE });
  });
  doc.setTitle(pdfSafe(`Proposal for ${name}`));
  doc.setAuthor("Alpha Analytica");
  return await doc.save();
}
