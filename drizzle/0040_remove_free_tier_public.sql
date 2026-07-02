-- Remove the hosted free tier. Hide the legacy `free` plan from public plan
-- listings so it can never be presented or self-selected as an entry plan.
-- Enforcement (resolveBillingEntitlement) already rejects any active subscription
-- that points at a free/zero-price plan (blocked:legacy_free); this migration is
-- defense-in-depth for the display/catalog surfaces. Lite (cloud_lite_15k_monthly)
-- is the mandatory paid entry plan for hosted users.
--
-- The metered overage Price is shared across all paid hosted tiers. Keep this
-- seeded in migrations before hiding Free so migration-only databases still have
-- at least one checkoutable public paid plan.
UPDATE "plans"
SET "stripe_overage_price_id" = 'price_1TjDCQQe1Ex4Xxd5NiD8e7wG'
WHERE "slug" IN (
  'cloud_lite_15k_monthly',
  'cloud_starter_55k_monthly',
  'cloud_starter_100k_monthly',
  'cloud_growth_120k_monthly',
  'cloud_growth_250k_monthly',
  'cloud_growth_500k_monthly'
)
AND ("stripe_overage_price_id" IS NULL OR btrim("stripe_overage_price_id") = '');
--> statement-breakpoint
UPDATE "plans"
SET "is_public" = false
WHERE "slug" = 'free';
