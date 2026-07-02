import {
  authorizeDashboardOrApiKey,
  getServerSession,
  unauthorizedResponse,
} from "@/lib/api-auth";
import { requireFullAccessForApiKeyCaller } from "@/lib/api-key-permissions";
import { configurationSetService, dedicatedIpPoolRepo } from "@opensend/core";
import { NextResponse } from "next/server";
import { z } from "zod";

const lifecycleStatuses = [
  "requested",
  "provisioned",
  "warming",
  "active",
  "suspended",
  "retired",
] as const;

const updatePoolSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  status: z.enum(lifecycleStatuses).optional(),
  provider_pool_name: z.string().min(1).max(255).nullable().optional(),
  ses_pool_name: z.string().min(1).max(255).nullable().optional(),
  scaling_mode: z.enum(["STANDARD", "MANAGED"]).optional(),
  operator_notes: z.string().max(4000).nullable().optional(),
});

async function resolveUserId(req: Request): Promise<string | Response> {
  const auth = await authorizeDashboardOrApiKey(
    req.headers.get("authorization"),
  );
  if (!auth) return unauthorizedResponse();

  const permissionError = requireFullAccessForApiKeyCaller(auth);
  if (permissionError) return permissionError;

  if ("dashboard" in auth) {
    const session = await getServerSession();
    if (!session?.user?.id) return unauthorizedResponse();
    return session.user.id;
  }

  if ("userId" in auth && auth.userId) {
    return auth.userId;
  }

  return unauthorizedResponse();
}

function lifecycleTimestamps(status: (typeof lifecycleStatuses)[number]) {
  const now = new Date();
  if (status === "provisioned") return { provisionedAt: now };
  if (status === "warming") return { warmingStartedAt: now };
  if (status === "retired") return { retiredAt: now };
  return {};
}

function toDedicatedIpPoolResponse(
  pool: NonNullable<
    Awaited<ReturnType<typeof dedicatedIpPoolRepo.findByIdForUser>>
  >,
) {
  return {
    object: "dedicated_ip_pool",
    id: pool.id,
    name: pool.name,
    provider: pool.provider,
    provider_pool_name: pool.sesPoolName.startsWith("manual-")
      ? null
      : pool.sesPoolName,
    ses_pool_name: pool.sesPoolName,
    scaling_mode: pool.scalingMode,
    status: pool.status,
    operator_notes: pool.operatorNotes,
    ip_count: pool.ipCount ?? null,
    aws_region: pool.awsRegion ?? null,
    provisioned_at: pool.provisionedAt,
    warming_started_at: pool.warmingStartedAt,
    retired_at: pool.retiredAt,
    created_at: pool.createdAt,
    updated_at: pool.updatedAt,
  };
}

async function deleteSesPoolOrError(input: {
  id: string;
  poolName: string;
  region?: string | null;
  event: string;
}): Promise<Response | null> {
  try {
    await configurationSetService.deleteDedicatedIpPool({
      poolName: input.poolName,
      region: input.region ?? undefined,
    });
    return null;
  } catch (err) {
    console.error(
      JSON.stringify({
        level: "error",
        event: input.event,
        pool_id: input.id,
      }),
      err,
    );
    return NextResponse.json(
      {
        error:
          "Failed to delete SES dedicated IP pool; lifecycle record was not retired.",
        code: "ses_pool_delete_failed",
      },
      { status: 502 },
    );
  }
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const userIdOrResponse = await resolveUserId(req);
  if (userIdOrResponse instanceof Response) return userIdOrResponse;
  const userId = userIdOrResponse;

  const { id } = await params;

  const pool = await dedicatedIpPoolRepo.findByIdForUser(id, userId);
  if (!pool) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json(toDedicatedIpPoolResponse(pool));
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const userIdOrResponse = await resolveUserId(req);
  if (userIdOrResponse instanceof Response) return userIdOrResponse;
  const userId = userIdOrResponse;

  const { id } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = updatePoolSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", details: parsed.error.flatten() },
      { status: 422 },
    );
  }

  const providerPoolName =
    parsed.data.provider_pool_name ?? parsed.data.ses_pool_name ?? undefined;
  const status = parsed.data.status;
  const providerPoolNameProvided =
    parsed.data.provider_pool_name !== undefined ||
    parsed.data.ses_pool_name !== undefined;
  let existing:
    | NonNullable<
        Awaited<ReturnType<typeof dedicatedIpPoolRepo.findByIdForUser>>
      >
    | undefined;

  if (providerPoolNameProvided || status === "retired") {
    existing = await dedicatedIpPoolRepo.findByIdForUser(id, userId);
    if (!existing) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
  }

  if (providerPoolNameProvided && existing?.provider === "ses") {
    return NextResponse.json(
      {
        error: "SES pool names are immutable after provisioning.",
        code: "provider_pool_name_locked",
      },
      { status: 403 },
    );
  }

  // If retiring a SES-provisioned pool, release it from SES before marking the
  // local lifecycle record retired. deleteDedicatedIpPool treats SES not-found
  // as success; every other provider failure leaves the record retryable.
  if (status === "retired" && existing?.provider === "ses") {
    const deleteError = await deleteSesPoolOrError({
      id,
      poolName: existing.sesPoolName,
      region: existing.awsRegion,
      event: "dedicated_ip.patch.delete_ses_pool_failed",
    });
    if (deleteError) return deleteError;
  }

  const updated = await dedicatedIpPoolRepo.updateForUser(id, userId, {
    name: parsed.data.name,
    sesPoolName: providerPoolName === null ? undefined : providerPoolName,
    scalingMode: parsed.data.scaling_mode,
    status,
    operatorNotes: parsed.data.operator_notes,
    ...(status ? lifecycleTimestamps(status) : {}),
  });

  if (!updated) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json(toDedicatedIpPoolResponse(updated));
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const userIdOrResponse = await resolveUserId(req);
  if (userIdOrResponse instanceof Response) return userIdOrResponse;
  const userId = userIdOrResponse;

  const { id } = await params;

  // Load the pool before retiring so we know its SES name and provider.
  const existing = await dedicatedIpPoolRepo.findByIdForUser(id, userId);
  if (!existing) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Release the SES pool before marking the local record retired.
  // deleteDedicatedIpPool treats SES not-found as success; every other provider
  // failure leaves the record active/retryable so the real SES pool is not orphaned.
  if (existing.provider === "ses") {
    const deleteError = await deleteSesPoolOrError({
      id,
      poolName: existing.sesPoolName,
      region: existing.awsRegion,
      event: "dedicated_ip.delete.delete_ses_pool_failed",
    });
    if (deleteError) return deleteError;
  }

  const pool = await dedicatedIpPoolRepo.updateForUser(id, userId, {
    status: "retired",
    retiredAt: new Date(),
  });
  if (!pool) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json({
    object: "dedicated_ip_pool",
    id,
    retired: true,
    status: pool.status,
  });
}
