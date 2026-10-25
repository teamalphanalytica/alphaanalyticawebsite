// Manchester prospecting: find a few local businesses each day, look at their public website the way a
// visitor would, and write a proposal and call script for each. Nothing is ever sent to anyone from here.
//
// Where businesses come from: OpenStreetMap (free, no key). Coverage of small firms is patchy, so
// "Add a business" in the admin lets you add any you find yourself.
// Data from OpenStreetMap is © OpenStreetMap contributors, licensed ODbL.

import { normaliseUkPhone, clean } from "./util.mjs";

const UA = "AlphaAnalyticaBot/1.0 (+https://alpha-analytica.netlify.app; looks at a business's public homepage once)";

/** Greater Manchester, roughly: south, west, north, east. */
export const BBOX = [53.33, -2.55, 53.65, -1.9];

/** One trade a day, in turn, so each morning has a theme ("today is roofers"). Tags are OpenStreetMap tags. */
export const NICHES = [
  { id: "roofers", label: "Roofers", tags: [["craft", "roofer"]], job: "roof repairs and replacements" },
  { id: "plumbers", label: "Plumbers and heating engineers", tags: [["craft", "plumber"], ["craft", "hvac"], ["craft", "heating_engineer"]], job: "boiler and plumbing jobs" },
  { id: "electricians", label: "Electricians", tags: [["craft", "electrician"]], job: "rewires, EV chargers and electrical work" },
  { id: "builders", label: "Builders and extensions", tags: [["craft", "builder"], ["craft", "carpenter"]], job: "extensions, loft conversions and renovations" },
  { id: "landscapers", label: "Landscapers and gardeners", tags: [["craft", "gardener"], ["craft", "landscaper"], ["shop", "garden_centre"]], job: "garden design and landscaping" },
  { id: "windows", label: "Windows, doors and conservatories", tags: [["craft", "window_construction"], ["craft", "glaziery"], ["shop", "doityourself"]], job: "windows, doors and conservatories" },
  { id: "kitchens", label: "Kitchen and bathroom fitters", tags: [["shop", "kitchen"], ["shop", "bathroom_furnishing"], ["craft", "tiler"]], job: "kitchens and bathrooms" },
  { id: "solar", label: "Solar and renewables", tags: [["craft", "solar"], ["craft", "photovoltaic"]], job: "solar panel and battery installs" },
  { id: "locksmiths", label: "Locksmiths", tags: [["shop", "locksmith"], ["craft", "locksmith"]], job: "lockouts and lock changes" },
  { id: "removals", label: "Removals", tags: [["office", "moving_company"]], job: "house and office moves" },
  { id: "driveways", label: "Driveways and paving", tags: [["craft", "paver"], ["craft", "stonemason"], ["craft", "concrete"]], job: "driveways and patios" },
  { id: "painters", label: "Decorators and plasterers", tags: [["craft", "painter"], ["craft", "plasterer"]], job: "decorating and plastering" },
  { id: "dentists", label: "Private dentists", tags: [["amenity", "dentist"]], job: "new patient bookings" },
  { id: "solicitors", label: "Solicitors", tags: [["office", "lawyer"]], job: "new client enquiries" },
  { id: "driving", label: "Driving schools", tags: [["amenity", "driving_school"]], job: "new learner bookings" },
];

/** Same niche all day, a new one tomorrow. */
export function pickNiche(date = new Date(), niches = NICHES) {
  const day = Math.floor(date.getTime() / 86_400_000);
  return niches[((day % niches.length) + niches.length) % niches.length];
}

export function overpassQuery(niche, bbox = BBOX) {
  const box = bbox.join(",");
  const parts = niche.tags.map(([k, v]) => `nwr["${k}"="${v}"]["name"](${box});`).join("");
  return `[out:json][timeout:20];(${parts});out tags center 400;`;
}

const OVERPASS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"];

export async function fetchOverpass(niche, { fetchImpl = fetch, timeoutMs = 12_000 } = {}) {
  let lastErr;
  for (const endpoint of OVERPASS) {
    try {
      const res = await fetchImpl(endpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": UA },
        body: "data=" + encodeURIComponent(overpassQuery(niche)),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`Overpass ${res.status}`);
      return parseOverpass(await res.json(), niche);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("Overpass unavailable");
}

/** OpenStreetMap elements to plain businesses. Chains are skipped: they don't buy from small agencies. */
export function parseOverpass(data, niche) {
  const out = [];
  const seen = new Set();
  for (const el of data?.elements || []) {
    const t = el.tags || {};
    const name = clean(t.name, 120);
    if (!name || t.brand || t["brand:wikidata"] || t.operator === "Royal Mail") continue;
    const phone = normaliseUkPhone(String(t.phone || t["contact:phone"] || "").split(";")[0].trim());
    const website = normaliseSite(t.website || t["contact:website"] || t.url);
    if (!phone && !website) continue;
    const address = [t["addr:housenumber"] && `${t["addr:housenumber"]} ${t["addr:street"] || ""}`.trim() || t["addr:street"], t["addr:city"] || t["addr:suburb"], t["addr:postcode"]].filter(Boolean).join(", ") || null;
    const key = dedupeKey({ name, phone, website });
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name, phone, website, address, niche: niche.label, dedupe_key: key, source: "osm" });
  }
  return out;
}

/** A tidy website address, or null. */
export function normaliseSite(input) {
  const s = clean(input, 300);
  if (!s) return null;
  try {
    const u = new URL(/^https?:\/\//i.test(s) ? s : "https://" + s);
    if (!publicHost(u.hostname)) return null;
    return u.origin + (u.pathname === "/" ? "" : u.pathname);
  } catch {
    return null;
  }
}

/** Only ordinary public hostnames: no IP addresses, localhost, or internal names. */
export function publicHost(host) {
  const h = String(host || "").toLowerCase();
  if (!h.includes(".") || h.length > 253) return false;
  if (/^[\d.]+$/.test(h) || h.includes(":") || h.includes("[")) return false;
  if (/(^|\.)(localhost|local|internal|lan|home|corp|test|invalid|example)$/.test(h)) return false;
  return /^[a-z0-9.-]+$/.test(h);
}

export function hostOf(website) {
  try {
    return new URL(website).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

export function dedupeKey({ name, phone, website }) {
  const host = website && hostOf(website);
  if (host) return host;
  return `${String(name).toLowerCase().replace(/[^a-z0-9]+/g, "")}|${phone || ""}`;
}

/* ---------- looking at a website like a visitor ---------- */

/** Fetch one homepage. Follows up to 3 redirects, re-checking each one stays on a public host. */
export async function fetchHomepage(website, { fetchImpl = fetch, timeoutMs = 6000, maxBytes = 600_000 } = {}) {
  let url = website;
  for (let hop = 0; hop < 4; hop++) {
    const u = new URL(url);
    if (!["http:", "https:"].includes(u.protocol) || !publicHost(u.hostname) || (u.port && !["80", "443"].includes(u.port))) throw new Error("Not a public website");
    const res = await fetchImpl(u.toString(), { redirect: "manual", headers: { "user-agent": UA, accept: "text/html" }, signal: AbortSignal.timeout(timeoutMs) });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      url = new URL(res.headers.get("location"), u).toString();
      continue;
    }
    if (!res.ok) throw new Error(`Website answered ${res.status}`);
    const type = res.headers.get("content-type") || "";
    if (type && !/html|text/i.test(type)) throw new Error("Not a web page");
    let html = "";
    if (res.body?.getReader) {
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let got = 0;
      while (got < maxBytes) {
        const { done, value } = await reader.read();
        if (done) break;
        got += value.length;
        html += dec.decode(value, { stream: true });
      }
      reader.cancel().catch(() => {});
      html = html.slice(0, maxBytes);
    } else html = (await res.text()).slice(0, maxBytes);
    return { html, finalUrl: u.toString(), https: u.protocol === "https:" };
  }
  throw new Error("Too many redirects");
}

/** The business's own Facebook page, if the homepage links to it (not share buttons or trackers). */
export function facebookPageOf(html) {
  const skip = new Set(["sharer", "sharer.php", "share.php", "tr", "plugins", "dialog", "login", "policy", "policies", "legal", "help", "groups", "events", "watch", "marketplace", "pages", "profile.php", "people", "hashtag", "ads", "business"]);
  for (const m of String(html).matchAll(/https?:\/\/(?:www\.|m\.)?facebook\.com\/([A-Za-z0-9._-]{3,80})(?:[/?#"'\s]|$)/g)) {
    if (!skip.has(m[1].toLowerCase())) return "https://www.facebook.com/" + m[1];
  }
  return null;
}

const UK_PHONE = /(?:\+44\s?\(?0?\)?\s?|\(?0)\d{2,4}\)?[\s-]?\d{3,4}[\s-]?\d{3,4}/;

/**
 * What a visitor (and Google) would see on the homepage. Only things we actually observed.
 * score: 100 is a site with nothing obvious to fix; lower means more we can help with.
 */
export function auditHtml(html, { https = true, year = new Date().getFullYear() } = {}) {
  const h = String(html || "");
  const lower = h.toLowerCase();
  const text = lower.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  const checks = {
    https,
    mobile: /<meta[^>]+name=["']viewport["']/.test(lower),
    title: /<title[^>]*>\s*[^<\s][^<]*<\/title>/.test(lower),
    description: /<meta[^>]+name=["']description["'][^>]*content=["'][^"']{20,}/.test(lower) || /<meta[^>]+content=["'][^"']{20,}["'][^>]*name=["']description["']/.test(lower),
    tapToCall: /href=["']tel:/.test(lower),
    phoneShown: UK_PHONE.test(text),
    form: /<form[\s>]/.test(lower),
    callToAction: /(free quote|get a quote|request a quote|get in touch|call (us )?(now|today)|book (a|your|now)|free survey|enquire|contact us)/.test(text),
    reviews: /(testimonial|reviews?\b|trustpilot|checkatrade|google reviews|rated|5 star|five star)/.test(text),
    analytics: /(googletagmanager\.com|google-analytics\.com|gtag\(|\bga\(|plausible\.io|clarity\.ms)/.test(lower),
    googleAdsTag: /(aw-\d{6,}|googleadservices\.com|googleads\.g\.doubleclick)/.test(lower),
    metaPixel: /(fbq\(|connect\.facebook\.net\/[a-z_]+\/fbevents|fbevents\.js)/.test(lower),
    facebookPage: facebookPageOf(h),
  };
  checks.adTracking = checks.googleAdsTag || checks.metaPixel;
  const years = [...text.matchAll(/(?:©|&copy;|copyright)\s*(?:\d{4}\s*[-–]\s*)?(20\d\d)/g)].map((m) => Number(m[1]));
  const newest = years.length ? Math.max(...years) : null;
  checks.copyrightYear = newest;
  checks.dated = newest !== null && newest <= year - 3;
  checks.thin = text.length < 400;

  const issues = [];
  const add = (key, penalty, title, detail) => issues.push({ key, penalty, title, detail });
  if (!checks.https) add("https", 15, "The site isn't secure", "It loads without the padlock, so browsers warn visitors and Google ranks it lower.");
  if (!checks.mobile) add("mobile", 20, "It isn't built for phones", "There's no mobile setting on the page, so on a phone it is likely to show as a tiny desktop page. Most trade searches happen on phones.");
  if (!checks.tapToCall) add("tapToCall", 15, "Phone number isn't tap-to-call", "We couldn't find a number a visitor can tap to ring. On mobile that is the quickest way for a customer to reach you.");
  if (!checks.form && !checks.tapToCall) add("form", 10, "No quick way to enquire", "We couldn't find an enquiry form or a tap-to-call link on the homepage.");
  if (!checks.callToAction) add("callToAction", 5, "No clear next step", "We couldn't see a clear \"get a quote\" or \"call us\" prompt on the homepage.");
  if (!checks.analytics && !checks.adTracking) add("tracking", 15, "Nothing measures where enquiries come from", "We couldn't see any analytics or advertising tracking on the page, so there's no way to tell which marketing brings in work.");
  if (!checks.reviews) add("reviews", 5, "No reviews shown", "We couldn't see reviews or testimonials on the homepage. They're one of the biggest reasons people pick one tradesperson over another.");
  if (!checks.title || !checks.description) add("seo", 5, "Missing search listing text", "The page title or description that appears in Google results looks missing or very thin.");
  if (checks.dated) add("dated", 10, "Looks out of date", `The footer still says ${checks.copyrightYear}, which makes a business look inactive.`);
  if (checks.thin) add("thin", 10, "Very little on the page", "There isn't much text for Google (or a visitor) to go on.");

  const score = Math.max(0, 100 - issues.reduce((n, i) => n + i.penalty, 0));
  issues.sort((a, b) => b.penalty - a.penalty);
  return { checks, issues, score };
}

/** For a business with no website, or one that wouldn't load. */
export function auditMissing(reason) {
  const noSite = reason === "none";
  return {
    checks: { website: false },
    issues: [{
      key: noSite ? "nosite" : "down",
      penalty: 100,
      title: noSite ? "No website" : "The website didn't load",
      detail: noSite
        ? "We couldn't find a website for the business. Customers who search for them online have nothing to land on, and ads have nowhere to send people."
        : "When we looked, the website didn't load for us. If that's happening to customers too, they're being lost.",
    }],
    score: noSite ? 0 : 10,
    unreachable: !noSite,
  };
}

export async function auditProspect(p, opts = {}) {
  if (!p.website) return auditMissing("none");
  try {
    const page = await fetchHomepage(p.website, opts);
    return { ...auditHtml(page.html, { https: page.https }), checkedAt: new Date().toISOString() };
  } catch (e) {
    return { ...auditMissing("down"), error: String(e.message).slice(0, 120), checkedAt: new Date().toISOString() };
  }
}

/** One-click searches of the public ad libraries (no scraping: you look, then record what you saw). */
export function adLinks(p) {
  const host = p.website ? hostOf(p.website) : null;
  return {
    google: host ? `https://adstransparency.google.com/?region=GB&domain=${encodeURIComponent(host)}` : "https://adstransparency.google.com/?region=GB",
    meta: `https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=GB&q=${encodeURIComponent(p.name)}&search_type=keyword_unordered`,
  };
}

/** In plain words: what we know about their advertising. Only things we saw or were told. */
export function adsSummary(p, audit) {
  const c = audit?.checks || {};
  const word = (v) => (v === "yes" ? "running ads (checked by hand)" : v === "no" ? "no ads found (checked by hand)" : "not checked");
  return {
    google_ads: word(p.ads_google),
    facebook_ads: word(p.ads_meta),
    google_ads_tag_on_website: !!c.googleAdsTag,
    facebook_pixel_on_website: !!c.metaPixel,
    has_facebook_page: !!c.facebookPage,
  };
}

/* ---------- the proposal ---------- */

const pitchPrice = () => clean(globalThis.Netlify?.env?.get?.("PITCH_PRICE_TEXT"), 200);

/** Written from the audit alone. Used when there is no Claude key, and as a safe fallback. */
export function templateProposition(p, audit, niche) {
  const issues = audit?.issues || [];
  const top = issues.slice(0, 3);
  const job = niche?.job || "new enquiries";
  const first = top[0];
  const price = pitchPrice();
  const c = audit?.checks || {};
  const tracked = !!(c.googleAdsTag || c.metaPixel);
  const adsSeen = p.ads_google === "yes" || p.ads_meta === "yes";
  const adFinding = adsSeen && !tracked
    ? { title: "You advertise, but can't see what it brings in", detail: "We found adverts running for the business, but nothing on the website that records which ads lead to enquiries. Without that it's hard to know which ones are worth the money." }
    : p.ads_google === "no" && p.ads_meta === "no"
      ? { title: "No Google or Facebook adverts that we could find", detail: "We checked Google's and Facebook's public ad libraries and found nothing running. Competitors who do advertise are being seen first by people searching nearby." }
      : null;
  const running = adsSeen || tracked;
  const findings = [...(adFinding ? [adFinding] : []), ...top].slice(0, 3);
  return {
    headline: `More of the right enquiries for ${p.name}`,
    summary: `We took a look at ${p.website ? "your website" : "how customers find you online"} and found a few things that may be costing ${p.name} work. Here is what we noticed and what we would do about it.`,
    findings: (findings.length ? findings : [{ title: "A good starting point", detail: "Your website covers the basics. The opportunity is bringing more of the right people to it." }])
      .map((i) => ({ title: i.title, detail: i.detail })),
    plan: [
      p.website ? "Fix the points above on your website, so every visit has the best chance of turning into an enquiry" : "Build you a simple, fast website that works on phones, with a tap-to-call button and an enquiry form",
      running ? "Review the Google and Facebook adverts you already run, cut what isn't bringing enquiries and put the money into what is" : "Run Google and Facebook adverts aimed at people near you who are looking for your service",
      "Give every ad enquiry and call a tracking number, so each call or message is linked back to the advert that produced it",
      "Give you a private login showing every enquiry and call, and where it came from",
    ],
    offer: price || "You pay per genuine enquiry, not a monthly retainer. Spam and wrong numbers aren't charged. We agree the price per enquiry on a short call.",
    call: {
      opener: `Hi, is that ${p.name}? My name's Jordan. I do local online marketing in Manchester. I had a quick look at ${p.website ? "your website" : "how you show up online"} this morning and spotted something that might be costing you work. Have you got two minutes?`,
      why_now: first ? first.title : "Customers search on their phones when they need someone quickly",
      questions: [
        "Where do most of your enquiries come from at the moment?",
        "How many enquiries a week would you like to be getting?",
        "Have you tried Google or Facebook adverts before? How did it go?",
      ],
      objections: [
        { q: "We've got enough work.", a: "That's good to hear. Most firms we speak to want the choice of better jobs, not just more of them. Can I send over what I noticed anyway?" },
        { q: "We've been burnt by marketing firms.", a: "That's why we only charge per genuine enquiry. If there's no enquiry, there's no charge." },
        { q: "Send me something in the post/email.", a: "Of course. I'll send a one-page summary of what I saw on your site. What's the best email address?" },
      ],
    },
    cover_note: `Hi, thanks for taking my call. As promised, here's the one-page summary of what I noticed${p.website ? " on your website" : ""} and how we'd help ${p.name} get more ${job}. Have a read and let me know if you'd like to talk it through.`,
  };
}

export function propositionRequest(p, audit, niche) {
  const system = [
    "You write short, honest sales proposals for Alpha Analytica, a small Manchester marketing agency that builds websites and runs Google and Facebook ads for local businesses, charging per genuine enquiry (spam and wrong numbers are not charged).",
    "Write in plain British English for a busy tradesperson or small-business owner. No jargon, no hype, no exclamation marks.",
    "Use ONLY the facts provided. Never invent statistics, rankings, competitor claims, revenue figures, reviews, guarantees or results. Never claim to have seen their ads, accounts or analytics. Describe website problems as things we noticed or could not find on the page, not as certainties about their business.",
    "For advertising, only say what the facts show. \"not checked\" means unknown: never claim they do or do not advertise. If an ad tag or pixel is on their website, say we saw it; never claim to have seen their actual ads unless checked by hand says running ads.",
    "Do not state any price unless one is given in the facts. If none is given, say the price per enquiry is agreed on a short call.",
    "Reply with ONE JSON object and nothing else, in exactly this shape:",
    '{"headline": string (max 70 chars), "summary": string (2 sentences), "findings": [{"title": string, "detail": string}] (exactly 3, taken from the issues given), "plan": [string] (4 items), "offer": string (2 sentences), "call": {"opener": string (what to say in the first 15 seconds, naming the business), "why_now": string, "questions": [string] (3), "objections": [{"q": string, "a": string}] (3)}, "cover_note": string (3 sentences, to send with the PDF after a call)}',
  ].join("\n");
  const facts = {
    business: p.name,
    trade: niche?.label || p.niche,
    area: "Greater Manchester",
    website: p.website || "none found",
    audit_score_out_of_100: audit?.score,
    issues_we_observed: (audit?.issues || []).slice(0, 5).map((i) => ({ title: i.title, detail: i.detail })),
    advertising: adsSummary(p, audit),
    price_wording: pitchPrice() || "none given",
  };
  return { system, user: "Facts about this prospect:\n" + JSON.stringify(facts, null, 2) };
}

export function parseProposition(text) {
  if (typeof text !== "string") return null;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let o;
  try {
    o = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  const s = (v, n) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, n) : "");
  const list = (v, n, f) => (Array.isArray(v) ? v.slice(0, n).map(f).filter(Boolean) : []);
  const out = {
    headline: s(o.headline, 90),
    summary: s(o.summary, 500),
    findings: list(o.findings, 4, (f) => (f && s(f.title, 90) && s(f.detail, 400) ? { title: s(f.title, 90), detail: s(f.detail, 400) } : null)),
    plan: list(o.plan, 6, (x) => s(x, 240)),
    offer: s(o.offer, 400),
    call: {
      opener: s(o.call?.opener, 600),
      why_now: s(o.call?.why_now, 240),
      questions: list(o.call?.questions, 4, (x) => s(x, 200)),
      objections: list(o.call?.objections, 4, (x) => (x && s(x.q, 160) && s(x.a, 400) ? { q: s(x.q, 160), a: s(x.a, 400) } : null)),
    },
    cover_note: s(o.cover_note, 700),
  };
  if (!out.headline || out.findings.length < 1 || out.plan.length < 2 || !out.call.opener) return null;
  return out;
}

/** Ask Claude to write the proposal. Returns null without a key or on any failure; the template is used instead. */
export async function claudeProposition(p, audit, niche, { fetchImpl = fetch } = {}) {
  const key = globalThis.Netlify?.env?.get?.("ANTHROPIC_API_KEY");
  if (!key) return null;
  const req = propositionRequest(p, audit, niche);
  try {
    const res = await fetchImpl("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: globalThis.Netlify.env.get("PROPOSAL_MODEL") || "claude-sonnet-5-5", max_tokens: 1800, system: req.system, messages: [{ role: "user", content: req.user }] }),
      signal: AbortSignal.timeout(25_000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Anthropic ${res.status}`);
    return parseProposition(data?.content?.find((b) => b.type === "text")?.text);
  } catch (e) {
    console.error("proposal failed", e.message);
    return null;
  }
}

export async function buildProposition(p, audit, niche, opts) {
  const fromClaude = await claudeProposition(p, audit, niche, opts);
  return fromClaude ? { proposition: fromClaude, by: "claude" } : { proposition: templateProposition(p, audit, niche), by: "template" };
}

/* ---------- the daily run ---------- */

const NICHE_BY_LABEL = (label) => NICHES.find((n) => n.label === label);

export function perDay() {
  const n = Number(globalThis.Netlify?.env?.get?.("PROSPECTS_PER_DAY"));
  return Number.isInteger(n) && n >= 1 && n <= 10 ? n : 5;
}

/** Run in turn with limited parallelism. */
async function pool(items, size, fn) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }));
  return results;
}

/**
 * Pick today's niche, look at candidates, keep the few with most we can help with, and write their proposals.
 * Scheduled functions get about 30 seconds, so everything runs in parallel with a deadline.
 */
export async function findProspects(db, { count = perDay(), now = new Date(), niche = pickNiche(now), fetchImpl = fetch, deadlineMs = 24_000 } = {}) {
  const started = Date.now();
  const left = () => deadlineMs - (Date.now() - started);
  const result = { niche: niche.label, candidates: 0, examined: 0, added: 0, polished: 0 };

  let found;
  try {
    found = await fetchOverpass(niche, { fetchImpl });
  } catch (e) {
    return { ...result, error: "Couldn't reach the business map just now: " + String(e.message).slice(0, 80) };
  }
  result.candidates = found.length;

  const existing = new Set((await db.sql`SELECT dedupe_key FROM prospects`).map((r) => r.dedupe_key));
  const fresh = found.filter((b) => !existing.has(b.dedupe_key));
  // A different shuffle each day, so we don't always look at the same first few.
  const seed = Math.floor(now.getTime() / 86_400_000);
  fresh.sort((a, b) => hash(a.dedupe_key + seed) - hash(b.dedupe_key + seed));
  const pool12 = fresh.slice(0, 14);
  result.examined = pool12.length;

  const audited = await pool(pool12, 14, async (b) => ({ b, audit: await auditProspect(b, { fetchImpl, timeoutMs: Math.min(6000, Math.max(1500, left() - 6000)) }) }));
  // Businesses whose site is genuinely down are less certain leads than ones with fixable problems; sites with
  // little to fix (score 80+) aren't worth a call.
  const picks = audited.filter(({ audit }) => audit.score < 80).sort((a, b) => a.audit.score - b.audit.score).slice(0, count);

  for (const { b, audit } of picks) {
    const proposition = templateProposition(b, audit, niche);
    const rows = await db.sql`
      INSERT INTO prospects (dedupe_key, name, niche, address, phone, website, source, audit, score, proposition, proposition_by)
      VALUES (${b.dedupe_key}, ${b.name}, ${b.niche}, ${b.address}, ${b.phone}, ${b.website}, 'osm', ${JSON.stringify(audit)}::jsonb, ${audit.score}, ${JSON.stringify(proposition)}::jsonb, 'template')
      ON CONFLICT (dedupe_key) DO NOTHING RETURNING id`;
    if (rows.length) result.added++;
  }

  result.polished = (await polishTemplates(db, { fetchImpl, budgetMs: left() - 1500 })).polished;
  return result;
}

const hash = (s) => {
  let h = 2166136261;
  for (const c of String(s)) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return h >>> 0;
};

/** Rewrite template proposals with Claude when there's a key. Quietly does nothing without one. */
export async function polishTemplates(db, { fetchImpl = fetch, budgetMs = 15_000, limit = 8 } = {}) {
  if (!globalThis.Netlify?.env?.get?.("ANTHROPIC_API_KEY") || budgetMs < 4000) return { polished: 0 };
  const rows = await db.sql`
    SELECT id, name, niche, website, audit, ads_google, ads_meta FROM prospects
    WHERE proposition_by = 'template' AND status IN ('new','to_call') AND found_at > NOW() - INTERVAL '14 days'
    ORDER BY found_at DESC LIMIT ${limit}`;
  let polished = 0;
  const until = Date.now() + budgetMs;
  await pool(rows, 4, async (r) => {
    if (Date.now() > until - 3000) return;
    const out = await claudeProposition(r, r.audit, NICHE_BY_LABEL(r.niche), { fetchImpl });
    if (!out) return;
    await db.sql`UPDATE prospects SET proposition = ${JSON.stringify(out)}::jsonb, proposition_by = 'claude' WHERE id = ${r.id}`;
    polished++;
  });
  return { polished };
}

/** Add one business by hand (a name, and ideally a website or phone). Looks at the site straight away. */
export async function addProspect(db, input, { fetchImpl = fetch } = {}) {
  const name = clean(input?.name, 120);
  if (!name) return { error: "Give the business a name." };
  const website = input?.website ? normaliseSite(input.website) : null;
  if (input?.website && !website) return { error: "That website address doesn't look right." };
  const phone = input?.phone ? normaliseUkPhone(String(input.phone)) : null;
  if (input?.phone && !phone) return { error: "That phone number doesn't look like a UK number." };
  if (!website && !phone) return { error: "Add a website or a phone number." };
  const niche = clean(input?.niche, 80) || "Other";
  const p = { name, website, phone, niche, address: clean(input?.address, 200) };
  const key = dedupeKey(p);
  const [dupe] = await db.sql`SELECT id FROM prospects WHERE dedupe_key = ${key}`;
  if (dupe) return { error: "That business is already in the list.", id: dupe.id };
  const audit = await auditProspect(p, { fetchImpl });
  const { proposition, by } = await buildProposition(p, audit, NICHE_BY_LABEL(niche) || { label: niche, job: "new enquiries" }, { fetchImpl });
  const [row] = await db.sql`
    INSERT INTO prospects (dedupe_key, name, niche, address, phone, website, source, audit, score, proposition, proposition_by, status)
    VALUES (${key}, ${name}, ${niche}, ${p.address}, ${phone}, ${website}, 'manual', ${JSON.stringify(audit)}::jsonb, ${audit.score}, ${JSON.stringify(proposition)}::jsonb, ${by}, 'to_call')
    RETURNING id`;
  return { id: row.id };
}

export const PROSPECT_STATUSES = ["new", "to_call", "contacted", "replied", "won", "lost", "skip"];
export const nicheFor = NICHE_BY_LABEL;
