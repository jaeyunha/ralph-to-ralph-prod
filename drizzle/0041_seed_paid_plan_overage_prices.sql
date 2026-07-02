-- Backfill the shared metered overage Stripe Price for hosted paid plans.
-- This must remain a separate migration from 0040 because some staging/prod
-- databases may have already recorded 0040 before the seed was added.
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
