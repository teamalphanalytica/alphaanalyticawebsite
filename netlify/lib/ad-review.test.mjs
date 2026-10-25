import { test } from "node:test";
import assert from "node:assert/strict";
import { reviewRequest, parseReview, claudeReview, hasSomethingToReview } from "./ad-review.mjs";

const GOOD = { headline: "Enquiries held steady but spam doubled", working: ["Boilers campaign: 6 enquiries"], not_working: ["Facebook spam at 40%"],
  changes: [{ action: "Pause the Facebook lead form campaign", why: "4 of 10 leads were spam" }], test_next: "Try a shorter form", client_note: "Enquiries held steady. We are tightening the Facebook form to cut spam." };

test("the reviewer is told to use only the numbers, to recommend not change, and to be honest about thin data", () => {
  const r = reviewRequest({ business: "Joe", last_week: {}, week_before: {} });
  assert.match(r.system, /ONLY the numbers provided/);
  assert.match(r.system, /You recommend, a person decides/);
  assert.match(r.system, /too few enquiries/);
  assert.match(r.user, /Joe/);
});

test("a good review is read; a vague or empty one is refused", () => {
  assert.equal(parseReview("Here: " + JSON.stringify(GOOD)).changes.length, 1);
  assert.equal(parseReview(JSON.stringify({ ...GOOD, changes: [] })), null);
  assert.equal(parseReview(JSON.stringify({ ...GOOD, client_note: "" })), null);
  assert.equal(parseReview("not json"), null);
});

test("no key means no review, quietly; a server error is reported, not thrown", async () => {
  assert.deepEqual(await claudeReview({}), { skipped: "no ANTHROPIC_API_KEY" });
  globalThis.Netlify = { env: { get: (k) => (k === "ANTHROPIC_API_KEY" ? "sk-test" : undefined) } };
  try {
    assert.ok((await claudeReview({}, { fetchImpl: async () => Response.json({ content: [{ type: "text", text: JSON.stringify(GOOD) }] }) })).review);
    assert.ok((await claudeReview({}, { fetchImpl: async () => new Response("x", { status: 500 }) })).error);
  } finally { delete globalThis.Netlify; }
});

test("a client with no ad data and no enquiries isn't reviewed", () => {
  const empty = { last_week: { platforms: [], campaigns: [], calls: { calls: 0 } } };
  assert.equal(hasSomethingToReview(empty), false);
  assert.equal(hasSomethingToReview({ last_week: { ...empty.last_week, campaigns: [{ campaign: "x" }] } }), true);
});
