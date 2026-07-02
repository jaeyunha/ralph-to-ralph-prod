-- Remove the hosted free tier. Hide the legacy `free` plan from public plan
-- listings so it can never be presented or self-selected as an entry plan.
-- Enforcement (resolveBillingEntitlement) already rejects any active subscription
-- that points at a free/zero-price plan (blocked:legacy_free); this migration is
-- defense-in-depth for the display/catalog surfaces. Lite (cloud_lite_15k_monthly)
-- is the mandatory paid entry plan for hosted users.
UPDATE "plans"
SET "is_public" = false
WHERE "slug" = 'free';
