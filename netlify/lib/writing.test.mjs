import test from "node:test";
import assert from "node:assert/strict";
import { slopFlags, WRITING_RULES } from "./writing.mjs";
import { templateProposition, NICHES } from "./prospects.mjs";

test("slopFlags catches common AI-writing patterns", () => {
  assert.deepEqual(slopFlags("It's not just a website, it's a statement. Let's dive in!").sort(), ["contrast", "exclamation", "opener"].sort());
  assert.ok(slopFlags("We leverage a robust approach — seamlessly.").includes("stock word"));
  assert.ok(slopFlags("A pivotal step — done").includes("dash"));
  assert.ok(slopFlags("The future looks bright.").includes("significance"));
});

test("slopFlags passes plain writing", () => {
  assert.deepEqual(slopFlags("Your website has no quote button. Visitors have to find the contact page and fill in a long form."), []);
});

test("writing rules are included for prompts", () => {
  assert.match(WRITING_RULES, /not just X, but Y/);
});

test("template proposals contain no AI-writing patterns for any trade", () => {
  const audits = [
    { score: 40, issues: [{ title: "No clear way to get a quote", detail: "We couldn't see a quote button or form." }], checks: { facts: { accreditations: ["Gas Safe registered"] } } },
    { score: 80, issues: [], checks: {} },
    null,
  ];
  for (const niche of NICHES) {
    for (const audit of audits) {
      const p = { name: "Example Ltd", website: audit ? "https://example.co.uk" : null, ads_google: "no", ads_meta: "no", rankings: [{ query: "plumber Bury", bucket: "later" }] };
      const t = templateProposition(p, audit, niche);
      assert.deepEqual(slopFlags(t), [], `${niche.id}: ${JSON.stringify(slopFlags(t))}`);
    }
  }
});
