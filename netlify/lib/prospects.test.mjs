import { test } from "node:test";
import assert from "node:assert/strict";
import {
  NICHES, pickNiche, overpassQuery, parseOverpass, normaliseSite, publicHost, dedupeKey,
  auditHtml, auditMissing, fetchHomepage, templateProposition, propositionRequest, parseProposition, claudeProposition,
} from "./prospects.mjs";
import { buildProposalPdf, pdfSafe, wrap } from "./pdf.mjs";

const GOOD = `<html><head><title>Smith Roofing Manchester</title><meta name="viewport" content="width=device-width">
<meta name="description" content="Family roofers covering Greater Manchester since 1998, free quotes."></head>
<body><a href="tel:01611234567">0161 123 4567</a><form></form><p>Get a free quote today. Rated 5 star on Google reviews. © ${new Date().getFullYear()} Smith</p>
${"word ".repeat(120)}<script src="https://www.googletagmanager.com/gtag/js?id=G-1"></script></body></html>`;

test("one trade a day, rotating through the list", () => {
  const a = pickNiche(new Date("2026-10-26T06:00:00Z"));
  const b = pickNiche(new Date("2026-10-26T20:00:00Z"));
  const c = pickNiche(new Date("2026-10-27T06:00:00Z"));
  assert.equal(a.id, b.id);
  assert.notEqual(a.id, c.id);
  assert.ok(NICHES.every((n) => n.tags.length && n.label && n.job));
});

test("the Manchester search covers every tag and stays inside the box", () => {
  const q = overpassQuery({ tags: [["craft", "roofer"], ["craft", "plumber"]] });
  assert.match(q, /\["craft"="roofer"\]/);
  assert.match(q, /\["craft"="plumber"\]/);
  assert.match(q, /53\.33,-2\.55,53\.65,-1\.9/);
});

test("OpenStreetMap results become tidy businesses; chains and contactless ones are dropped", () => {
  const out = parseOverpass({ elements: [
    { type: "node", id: 1, tags: { name: "Smith Roofing", phone: "0161 123 4567; 07700 900123", website: "smithroofing.co.uk", "addr:housenumber": "4", "addr:street": "High St", "addr:postcode": "M1 1AA" } },
    { type: "node", id: 2, tags: { name: "Smith Roofing", phone: "+44 161 123 4567" } },
    { type: "node", id: 3, tags: { name: "Big Chain", brand: "Big", website: "https://big.example.com" } },
    { type: "node", id: 4, tags: { name: "No contact" } },
    { type: "node", id: 5, tags: { name: "Bad site", website: "http://192.168.0.1/admin" } },
    { type: "node", id: 6, tags: { phone: "01611234567" } },
  ] }, { label: "Roofers" });
  assert.equal(out.length, 2);
  assert.equal(out[0].phone, "+441611234567");
  assert.equal(out[0].website, "https://smithroofing.co.uk");
  assert.equal(out[0].address, "4 High St, M1 1AA");
  assert.equal(out[0].dedupe_key, "smithroofing.co.uk");
  assert.equal(out[1].website, null); // same firm listed again with only a phone: kept separately, you'd merge by hand
  assert.ok(!out.some((b) => b.name === "Bad site"), "an internal address with no phone is dropped");
});

test("only ordinary public websites are ever visited", () => {
  for (const bad of ["localhost", "10.0.0.1", "169.254.169.254", "metadata.google.internal", "printer.local", "[::1]", "intranet"]) assert.equal(publicHost(bad), false, bad);
  assert.equal(publicHost("smithroofing.co.uk"), true);
  assert.equal(normaliseSite("javascript:alert(1)"), null);
  assert.equal(normaliseSite("http://127.0.0.1"), null);
  assert.equal(normaliseSite("Smith.co.uk/"), "https://smith.co.uk");
});

test("same business is recognised by website, or by name and phone", () => {
  assert.equal(dedupeKey({ name: "A", website: "https://www.x.co.uk/" }), "x.co.uk");
  assert.equal(dedupeKey({ name: "A B!", phone: "+441", website: null }), "ab|+441");
});

test("a good homepage scores high with nothing urgent to fix", () => {
  const a = auditHtml(GOOD, { https: true });
  assert.ok(a.score >= 90, JSON.stringify(a.issues));
  assert.equal(a.checks.tapToCall, true);
});

test("a poor homepage scores low and every issue is something we observed", () => {
  const a = auditHtml(`<html><head></head><body><p>© 2018 Joe</p>Call 0161 123 4567</body></html>`, { https: false });
  assert.ok(a.score <= 30);
  const keys = a.issues.map((i) => i.key);
  for (const k of ["https", "mobile", "tapToCall", "tracking", "dated", "thin"]) assert.ok(keys.includes(k), k);
  assert.ok(a.issues.every((i) => /noticed|couldn't|can't|isn't|doesn't|still|There's|It loads|There isn't|When we/i.test(i.detail) || i.detail.length > 20));
  assert.equal(a.issues[0].penalty >= a.issues.at(-1).penalty, true); // worst first
});

test("no website, or one that is down, is scored and explained", () => {
  assert.equal(auditMissing("none").score, 0);
  assert.equal(auditMissing("down").unreachable, true);
});

test("redirects to internal addresses are refused", async () => {
  const fakeFetch = async (url) => (url.startsWith("https://ok.co.uk")
    ? new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data" } })
    : new Response("secret"));
  await assert.rejects(fetchHomepage("https://ok.co.uk", { fetchImpl: fakeFetch }), /Not a public website/);
});

test("a normal page is read and capped in size", async () => {
  const big = "x".repeat(900_000);
  const r = await fetchHomepage("https://ok.co.uk", { fetchImpl: async () => new Response(big, { headers: { "content-type": "text/html" } }), maxBytes: 100_000 });
  assert.ok(r.html.length < 700_000 && r.https);
});

test("the template proposal uses the audit and never invents a price", () => {
  const audit = auditHtml("<html><body>hi</body></html>", { https: true });
  const pr = templateProposition({ name: "Smith Roofing", website: "https://smith.co.uk" }, audit, NICHES[0]);
  assert.equal(pr.findings.length, 3);
  assert.match(pr.call.opener, /Smith Roofing/);
  assert.doesNotMatch(JSON.stringify(pr), /£\d/);
  assert.equal(pr.call.objections.length, 4);
});

test("Claude is told to use only the facts and not to invent a price", () => {
  const r = propositionRequest({ name: "Smith", website: null }, auditMissing("none"), NICHES[0]);
  assert.match(r.system, /ONLY the facts/);
  assert.match(r.system, /Do not state any price/);
  assert.match(r.user, /No website/);
});

test("Claude's reply is read, trimmed and checked; rubbish is rejected", () => {
  const good = { headline: "H", summary: "S", findings: [{ title: "T", detail: "D" }], plan: ["a", "b"], offer: "O", call: { opener: "Hi", why_now: "w", questions: ["q"], objections: [{ q: "x", a: "y" }] }, cover_note: "c" };
  const parsed = parseProposition("Sure!\n" + JSON.stringify(good) + "\nDone");
  assert.equal(parsed.headline, "H");
  assert.equal(parseProposition("no json here"), null);
  assert.equal(parseProposition(JSON.stringify({ headline: "H" })), null);
  assert.equal(parseProposition(undefined), null);
});

test("without a key Claude is skipped quietly; with one the reply is used", async () => {
  assert.equal(await claudeProposition({ name: "A" }, { issues: [] }, NICHES[0]), null);
  globalThis.Netlify = { env: { get: (k) => (k === "ANTHROPIC_API_KEY" ? "sk-test" : undefined) } };
  try {
    let sent;
    const good = { headline: "H", summary: "S", findings: [{ title: "T", detail: "D" }], plan: ["a", "b"], offer: "O", call: { opener: "Hi" }, cover_note: "c" };
    const ok = await claudeProposition({ name: "A" }, { score: 10, issues: [] }, NICHES[0], { fetchImpl: async (u, o) => { sent = JSON.parse(o.body); return Response.json({ content: [{ type: "text", text: JSON.stringify(good) }] }); } });
    assert.equal(ok.headline, "H");
    assert.match(sent.system, /British English/);
    const bad = await claudeProposition({ name: "A" }, { issues: [] }, NICHES[0], { fetchImpl: async () => new Response("no", { status: 500 }) });
    assert.equal(bad, null);
  } finally {
    delete globalThis.Netlify;
  }
});

test("PDF text is made safe and wraps inside the page", async () => {
  assert.equal(pdfSafe("It’s “fine” – £5 ✓ 日本"), 'It\'s "fine" - £5  ');
  const pr = templateProposition({ name: "Smith & Sons “Roofing” ✓", website: "https://smith.co.uk" }, auditHtml("<p>x</p>"), NICHES[0]);
  const bytes = await buildProposalPdf({ name: "Smith & Sons “Roofing” ✓", website: "https://smith.co.uk", proposition: pr, contact: "Jordan" });
  assert.equal(Buffer.from(bytes.slice(0, 5)).toString(), "%PDF-");
  assert.ok(bytes.length > 1500);
});

test("a long proposal flows onto a second page", async () => {
  const pr = templateProposition({ name: "X", website: null }, auditMissing("none"), NICHES[0]);
  pr.plan = Array.from({ length: 6 }, () => "A long step ".repeat(40));
  pr.findings = Array.from({ length: 4 }, () => ({ title: "Finding", detail: "Detail ".repeat(100) }));
  const bytes = await buildProposalPdf({ name: "X", website: null, proposition: pr });
  const { PDFDocument } = await import("pdf-lib");
  assert.ok((await PDFDocument.load(bytes)).getPageCount() >= 2);
});

test("Google and Facebook tags and the business's Facebook page are told apart", async () => {
  const { facebookPageOf, adLinks, adsSummary } = await import("./prospects.mjs");
  const a = auditHtml(`<html><body><script async src="https://www.googletagmanager.com/gtag/js?id=AW-1234567890"></script>
    <script>fbq('init','1')</script><a href="https://www.facebook.com/sharer/sharer.php?u=x">share</a>
    <a href="https://www.facebook.com/SmithRoofingManchester/">f</a></body></html>`);
  assert.equal(a.checks.googleAdsTag, true);
  assert.equal(a.checks.metaPixel, true);
  assert.equal(a.checks.facebookPage, "https://www.facebook.com/SmithRoofingManchester");
  assert.equal(facebookPageOf('<a href="https://facebook.com/tr?id=1">'), null);
  const none = auditHtml("<html><body>hi</body></html>");
  assert.equal(none.checks.googleAdsTag, false);
  assert.equal(none.checks.metaPixel, false);
  const l = adLinks({ name: "Smith & Sons", website: "https://www.smith.co.uk" });
  assert.match(l.google, /domain=smith\.co\.uk/);
  assert.match(l.meta, /q=Smith%20%26%20Sons/);
  assert.equal(adsSummary({ ads_google: "unknown", ads_meta: "yes" }, a).google_ads, "not checked");
});

test("the proposal only claims what was checked about advertising", () => {
  const plain = auditHtml("<html><body>hi</body></html>");
  const tagged = auditHtml("<html><body><script>fbq('init','1')</script></body></html>");
  const text = (p, a) => JSON.stringify(templateProposition(p, a, NICHES[0]).findings);
  assert.doesNotMatch(text({ name: "A", ads_google: "unknown", ads_meta: "unknown" }, plain), /adverts running|No Google or Facebook adverts|ad libraries/);
  assert.match(text({ name: "A", ads_google: "no", ads_meta: "no" }, plain), /No Google or Facebook adverts/);
  assert.doesNotMatch(text({ name: "A", ads_google: "no", ads_meta: "unknown" }, plain), /No Google or Facebook adverts/);
  assert.match(text({ name: "A", ads_google: "yes", ads_meta: "unknown" }, plain), /can't see what it brings in/);
  assert.doesNotMatch(text({ name: "A", ads_google: "yes", ads_meta: "unknown" }, tagged), /can't see what it brings in/);
  const req = propositionRequest({ name: "A", ads_google: "yes" }, plain, NICHES[0]);
  assert.match(req.user, /running ads \(checked by hand\)/);
  assert.match(req.system, /never claim they do or do not advertise/);
});

test("credentials, headings and the year started are read from the homepage and reused in the concept", async () => {
  const { conceptFor, ensureRich, NICHE_EXTRA } = await import("./prospects.mjs");
  const a = auditHtml(`<html><head><title>Smith Plumbing</title></head><body><h1>Boiler installation</h1><h2>Boiler repairs</h2><h2>Contact us</h2><h2>Landlord gas safety</h2><h2>Servicing</h2>
    <p>Gas Safe registered engineers. Worcester Bosch accredited installer. Trading since 2004. Call 07990 933344. ${"x ".repeat(300)}</p></body></html>`);
  const f = a.checks.facts;
  assert.ok(f.accreditations.includes("Gas Safe registered") && f.accreditations.includes("Worcester Bosch accredited"));
  assert.equal(f.since, 2004);
  assert.ok(f.phones[0].startsWith("07990"));
  const c = conceptFor({ name: "Smith", phone: "+441617720947" }, a, NICHES[1]);
  assert.deepEqual(c.services.slice(0, 2), ["Boiler installation", "Boiler repairs"]);
  assert.ok(!c.services.includes("Contact us"));
  assert.equal(c.trust[0], "Trading since 2004");
  assert.equal(c.phone, "01617720947");
  // with nothing found, credentials are never invented
  const bare = conceptFor({ name: "Bare" }, auditHtml("<html><body>hi</body></html>"), NICHES[0]);
  assert.deepEqual(bare.trust, []);
  assert.deepEqual(bare.services, NICHE_EXTRA.roofers.services);
  // an older proposal without a concept gets one
  const rich = ensureRich({ headline: "H", findings: [], plan: [] }, { name: "Old" }, a, NICHES[1]);
  assert.ok(rich.concept && rich.benefits.length >= 5 && rich.value_example.total === rich.value_example.jobs * rich.value_example.job_value);
});

test("the proposal is a three-page document with the mock-up and the worked example, and says it is illustrative", async () => {
  const { PDFDocument } = await import("pdf-lib");
  const p = { name: "Smith Plumbing", website: "https://smith.co.uk", phone: "+441610000000" };
  const audit = auditHtml("<html><head><title>x</title></head><body>Gas Safe registered. old</body></html>");
  const pr = templateProposition(p, audit, NICHES[1]);
  const bytes = await buildProposalPdf({ name: p.name, website: p.website, audit, phone: "0161 000 0000", proposition: pr, contact: "Jordan" });
  assert.equal((await PDFDocument.load(bytes)).getPageCount(), 3);
  assert.match(pr.value_example.job, /boiler/);
  assert.equal(pr.benefits.some((b) => /\d+%/.test(b.value + b.why)), false, "no invented percentages");
});

test("Claude's concept and benefits are accepted when present and ignored when thin", () => {
  const base = { headline: "H", summary: "S", findings: [{ title: "T", detail: "D" }], plan: ["a", "b"], offer: "O", call: { opener: "Hi" }, cover_note: "c" };
  const withExtras = parseProposition(JSON.stringify({ ...base, concept: { tagline: "Boilers done right", subline: "Free quotes", services: ["A", "B", "C", "D"], trust: ["Gas Safe registered"] },
    benefits: [1, 2, 3, 4, 5].map((n) => ({ title: "T" + n, why: "W", value: "V" })) }));
  assert.equal(withExtras.concept.tagline, "Boilers done right");
  assert.equal(withExtras.benefits.length, 5);
  const thin = parseProposition(JSON.stringify({ ...base, benefits: [{ title: "only one", why: "w", value: "v" }] }));
  assert.equal(thin.benefits, undefined);
});
