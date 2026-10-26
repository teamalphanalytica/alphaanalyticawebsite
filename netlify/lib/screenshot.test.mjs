import test from "node:test";
import assert from "node:assert/strict";
import { PDFDocument } from "pdf-lib";
import { fetchScreenshots, imageType, screenshotUrl } from "./screenshot.mjs";
import { buildProposalPdf } from "./pdf.mjs";
import { auditHtml, templateProposition, NICHES } from "./prospects.mjs";

// A real 1x1 PNG.
const PNG = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));

test("screenshot URLs ask for a computer and a phone view", () => {
  assert.match(screenshotUrl("https://a.co.uk"), /viewport\.width=1280/);
  assert.match(screenshotUrl("https://a.co.uk", { mobile: true }), /device=iPhone/);
  assert.match(screenshotUrl("https://a.co.uk", { apiKey: "k" }), /^https:\/\/pro\.microlink\.io/);
});

test("screenshots: only real images are kept, failures give null", async () => {
  assert.equal(imageType(PNG), "png");
  assert.equal(imageType(new TextEncoder().encode("<html>")), null);
  const ok = await fetchScreenshots("https://a.co.uk", { fetchImpl: async () => new Response(PNG) });
  assert.ok(ok.desktop && ok.mobile);
  const bad = await fetchScreenshots("https://a.co.uk", { fetchImpl: async () => new Response("<html>") });
  assert.deepEqual(bad, { desktop: null, mobile: null });
  const err = await fetchScreenshots("https://a.co.uk", { fetchImpl: async () => { throw new Error("down"); } });
  assert.deepEqual(err, { desktop: null, mobile: null });
  assert.deepEqual(await fetchScreenshots(""), { desktop: null, mobile: null });
});

test("the proposal with screenshots and Google results stays at three pages", async () => {
  const p = { name: "Smith Plumbing", website: "https://smith.co.uk" };
  const audit = auditHtml("<html><body>old</body></html>");
  const rankings = ["a b", "c d", "e f"].map((query) => ({ query, bucket: "later", checked_at: new Date().toISOString() }));
  for (const rk of [[], rankings]) {
    const bytes = await buildProposalPdf({ ...p, audit, rankings: rk, screenshots: { desktop: PNG, mobile: PNG }, proposition: templateProposition({ ...p, rankings: rk }, audit, NICHES[1]), contact: "Jordan" });
    assert.equal((await PDFDocument.load(bytes)).getPageCount(), 3);
  }
});
