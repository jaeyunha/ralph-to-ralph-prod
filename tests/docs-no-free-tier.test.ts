import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// AC4: no hosted free tier advertised in public-facing surfaces or the catalog.
const surfaces = [
  "public/docs/knowledge-base/quotas-rate-limits-production-access.md",
  "src/components/landing/landing-page.tsx",
  "src/components/landing/pricing-page.tsx",
  "src/components/pricing/pricing-catalog.ts",
];

describe("no hosted free tier in public surfaces", () => {
  for (const file of surfaces) {
    it(`${file} contains no "free tier" marketing`, () => {
      const content = readFileSync(file, "utf8");
      expect(content).not.toMatch(/free tier/i);
    });
  }

  it("pricing catalog has no Free plan (slug/family)", () => {
    const content = readFileSync(
      "src/components/pricing/pricing-catalog.ts",
      "utf8",
    );
    expect(content).not.toMatch(/slug:\s*"free"/);
    expect(content).not.toMatch(/family:\s*"free"/);
    expect(content).toContain("cloud_lite_15k_monthly");
  });
  it("has no hosted Free-plan advertising in catalog/landing copy", () => {
    const catalog = readFileSync(
      "src/components/pricing/pricing-catalog.ts",
      "utf8",
    );
    expect(catalog).not.toContain("Everything in Free");

    const landing = readFileSync(
      "src/components/landing/landing-page.tsx",
      "utf8",
    );
    expect(landing).not.toMatch(/Free\s*\d/); // e.g. "Free 500/mo"
    expect(landing).not.toMatch(/Cloud free/i); // no "Try Cloud free" CTA — hosted is paid-only

    const pricing = readFileSync(
      "src/components/landing/pricing-page.tsx",
      "utf8",
    );
    // No "Free" column in the compare-plans headers.
    expect(pricing).not.toMatch(/headers\s*=\s*\[\s*"Free"/);
  });

  it("seeds hosted paid-plan overage prices before hiding Free", () => {
    const migration = readFileSync(
      "drizzle/0040_remove_free_tier_public.sql",
      "utf8",
    );
    const overageUpdate = migration.indexOf("stripe_overage_price_id");
    const hideFree = migration.indexOf("WHERE \"slug\" = 'free'");
    expect(overageUpdate).toBeGreaterThanOrEqual(0);
    expect(hideFree).toBeGreaterThan(overageUpdate);
    expect(migration).toContain("cloud_lite_15k_monthly");
    expect(migration).toContain("price_1TjDCQQe1Ex4Xxd5NiD8e7wG");
    expect(migration).not.toContain("REPLACE_WITH");
  });
});
