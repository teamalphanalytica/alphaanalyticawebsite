// Screenshots of a prospect's homepage for the proposal: what a visitor sees first on a computer and on a phone.
// Uses the Microlink screenshot API (free without a key, about 50 a day; set MICROLINK_API_KEY for more).
// Any failure returns null so the proposal is still built without pictures.

const MAX_BYTES = 3_000_000;

export function imageType(bytes) {
  if (!bytes || bytes.length < 8) return null;
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpg";
  return null;
}

export function screenshotUrl(website, { mobile = false, apiKey = "" } = {}) {
  const base = apiKey ? "https://pro.microlink.io/" : "https://api.microlink.io/";
  const q = new URLSearchParams({ url: website, screenshot: "true", meta: "false", embed: "screenshot.url", waitForTimeout: "1500" });
  if (mobile) q.set("device", "iPhone 13");
  else { q.set("viewport.width", "1280"); q.set("viewport.height", "800"); }
  return base + "?" + q.toString();
}

async function one(website, { mobile, fetchImpl, timeoutMs, apiKey }) {
  try {
    const res = await fetchImpl(screenshotUrl(website, { mobile, apiKey }), {
      headers: apiKey ? { "x-api-key": apiKey } : {},
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length > MAX_BYTES || !imageType(bytes)) return null;
    return bytes;
  } catch {
    return null;
  }
}

/** { desktop, mobile } as image bytes, either may be null. */
export async function fetchScreenshots(website, { fetchImpl = fetch, timeoutMs = 9000, apiKey = "" } = {}) {
  if (!website || !/^https?:\/\//i.test(website)) return { desktop: null, mobile: null };
  const [desktop, mobile] = await Promise.all([
    one(website, { mobile: false, fetchImpl, timeoutMs, apiKey }),
    one(website, { mobile: true, fetchImpl, timeoutMs, apiKey }),
  ]);
  return { desktop, mobile };
}
