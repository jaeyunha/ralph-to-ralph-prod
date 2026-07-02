import { desc, eq } from "drizzle-orm";
import { db } from "../db/client";
import { dedicatedIpPoolRepo } from "../db/repositories/dedicatedIpPoolRepo";
import { usagePeriods } from "../db/schema";
import { configurationSetService } from "./configurationSet";

/**
 * Advisory minimum monthly email volume for a dedicated IP to warm successfully.
 * SES-recommended threshold for MANAGED dedicated IP pools.
 */
export const DEDICATED_IP_MIN_MONTHLY_VOLUME = 50_000;

function isAlreadyExistsError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error as { name: string }).name === "AlreadyExistsException"
  );
}

/**
 * Generate a collision-proof SES pool name from user and pool UUIDs.
 * SES pool names: alphanumeric + hyphens, max 64 chars.
 */
function buildSesPoolName(userId: string, poolId: string): string {
  const userSlug = userId
    .replace(/[^a-z0-9]/gi, "")
    .toLowerCase()
    .slice(0, 8);
  const poolSlug = poolId
    .replace(/[^a-z0-9]/gi, "")
    .toLowerCase()
    .slice(0, 8);
  return `opensend-${userSlug}-${poolSlug}`;
}

type ApproveResult =
  | { ok: false; code: "not_found" }
  | { ok: false; code: "invalid_status"; current: string }
  | {
      ok: true;
      pool: NonNullable<
        Awaited<ReturnType<typeof dedicatedIpPoolRepo.findById>>
      >;
      volumeWarning: boolean;
      emailsSent: number;
    };

/**
 * Operator-approval gate: provisions the SES dedicated IP pool for a requested record.
 * Never called from user-facing routes — only the internal operator endpoint calls this.
 *
 * Billing note: SES MANAGED pools accrue charges from creation. This function
 * must only be called after explicit operator review.
 */
export async function approveAndProvisionPool(
  poolId: string,
  opts: { awsRegion?: string; operatorNotes?: string } = {},
): Promise<ApproveResult> {
  const pool = await dedicatedIpPoolRepo.findById(poolId);
  if (!pool) return { ok: false, code: "not_found" };

  if (pool.status !== "requested") {
    return { ok: false, code: "invalid_status", current: pool.status };
  }

  // Volume-readiness check (advisory — does not block provisioning).
  let volumeWarning = false;
  let emailsSent = 0;
  try {
    const [latestPeriod] = await db
      .select()
      .from(usagePeriods)
      .where(eq(usagePeriods.userId, pool.userId))
      .orderBy(desc(usagePeriods.periodStart))
      .limit(1);
    emailsSent = latestPeriod?.emailsSent ?? 0;
    if (emailsSent < DEDICATED_IP_MIN_MONTHLY_VOLUME) {
      volumeWarning = true;
      console.warn(
        JSON.stringify({
          level: "warn",
          event: "dedicated_ip.approve.low_volume",
          pool_id: poolId,
          user_id: pool.userId,
          emails_sent: emailsSent,
          threshold: DEDICATED_IP_MIN_MONTHLY_VOLUME,
        }),
      );
    }
  } catch (err) {
    console.error("dedicated_ip.approve.volume_check_failed", err);
  }

  // If operator_notes provided, persist them first.
  if (opts.operatorNotes != null) {
    await dedicatedIpPoolRepo.updateById(poolId, {
      operatorNotes: opts.operatorNotes,
    });
  }

  // Always provision OpenSend-owned pool names. Tenant-supplied names are only
  // lifecycle-request metadata; they must never make approval collide with or
  // take ownership of an existing SES pool.
  const sesPoolName = buildSesPoolName(pool.userId, poolId);

  const awsRegion = opts.awsRegion ?? "us-east-1";

  // Call SES — swallow AlreadyExistsException (idempotent).
  try {
    await configurationSetService.createDedicatedIpPool({
      poolName: sesPoolName,
      scalingMode: (pool.scalingMode as "STANDARD" | "MANAGED") ?? "MANAGED",
      region: awsRegion,
    });
  } catch (err) {
    if (!isAlreadyExistsError(err)) throw err;
    console.warn(
      JSON.stringify({
        level: "warn",
        event: "dedicated_ip.approve.already_exists",
        pool_id: poolId,
        ses_pool_name: sesPoolName,
      }),
    );
  }

  const updated = await dedicatedIpPoolRepo.updateById(poolId, {
    status: "provisioned",
    sesPoolName,
    provider: "ses",
    awsRegion,
    provisionedAt: new Date(),
  });

  if (!updated) {
    throw new Error(
      `dedicated_ip.approve: pool ${poolId} disappeared after SES provisioning`,
    );
  }

  return { ok: true, pool: updated, volumeWarning, emailsSent };
}

type ReconcileResult = {
  ok: boolean;
  ipCount?: number;
  graduated?: boolean;
  newStatus?: string;
};

/**
 * Poll SES for the current IP list and advance the pool status as IPs warm.
 *
 * Status transitions:
 *   provisioned → warming  (STANDARD: when IPs appear)
 *   provisioned → active   (MANAGED: when IPs present and none IN_PROGRESS)
 *   warming     → active   (when ips.length > 0 && none IN_PROGRESS)
 */
export async function reconcileProvisionedPool(
  poolId: string,
): Promise<ReconcileResult> {
  const pool = await dedicatedIpPoolRepo.findById(poolId);
  if (!pool) return { ok: false };

  // Skip if synced recently (< 5 minutes ago).
  if (pool.lastSyncedAt) {
    const ageMs = Date.now() - pool.lastSyncedAt.getTime();
    if (ageMs < 5 * 60 * 1000) {
      return { ok: true, ipCount: pool.ipCount ?? 0, graduated: false };
    }
  }

  let ips: { ip: string; warmupStatus: string }[];
  try {
    ips = await configurationSetService.getDedicatedIps({
      poolName: pool.sesPoolName,
      region: pool.awsRegion ?? "us-east-1",
    });
  } catch (err) {
    console.error(
      JSON.stringify({
        level: "error",
        event: "dedicated_ip.reconcile.get_ips_failed",
        pool_id: poolId,
      }),
      err,
    );
    return { ok: false };
  }

  await dedicatedIpPoolRepo.updateSyncMetadata(poolId, {
    lastSyncedAt: new Date(),
    ipCount: ips.length,
    awsRegion: pool.awsRegion ?? undefined,
  });

  // Graduation logic.
  const allReady =
    ips.length > 0 && ips.every((ip) => ip.warmupStatus !== "IN_PROGRESS");
  const isManaged = pool.scalingMode === "MANAGED";

  if (pool.status === "provisioned") {
    if (allReady && isManaged) {
      // MANAGED pools auto-warm — advance directly to active.
      await dedicatedIpPoolRepo.updateById(poolId, { status: "active" });
      return {
        ok: true,
        ipCount: ips.length,
        graduated: true,
        newStatus: "active",
      };
    }
    if (ips.length > 0) {
      // IPs appeared — move to warming.
      await dedicatedIpPoolRepo.updateById(poolId, {
        status: "warming",
        warmingStartedAt: new Date(),
      });
      return {
        ok: true,
        ipCount: ips.length,
        graduated: true,
        newStatus: "warming",
      };
    }
  }

  if (pool.status === "warming" && allReady) {
    await dedicatedIpPoolRepo.updateById(poolId, { status: "active" });
    return {
      ok: true,
      ipCount: ips.length,
      graduated: true,
      newStatus: "active",
    };
  }

  return { ok: true, ipCount: ips.length, graduated: false };
}
