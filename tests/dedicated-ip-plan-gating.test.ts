import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Mocks ────────────────────────────────────────────────────────────────────
const mockGetServerSession = vi.hoisted(() => vi.fn());
const mockAuthorizeDashboardOrApiKey = vi.hoisted(() => vi.fn());
const mockUnauthorizedResponse = vi.hoisted(
  () => () =>
    new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 }),
);
const mockRequireFullAccessForApiKeyCaller = vi.hoisted(() => vi.fn());
const mockListForUser = vi.hoisted(() => vi.fn());
const mockCountForUser = vi.hoisted(() => vi.fn());
const mockCreate = vi.hoisted(() => vi.fn());
const mockFindByIdForUser = vi.hoisted(() => vi.fn());
const mockUpdateForUser = vi.hoisted(() => vi.fn());
const mockFindBySubscription = vi.hoisted(() => vi.fn());
const mockFindByPlanId = vi.hoisted(() => vi.fn());
const mockDeleteDedicatedIpPool = vi.hoisted(() => vi.fn());
const mockResolveBillingEntitlement = vi.hoisted(() => vi.fn());

vi.mock("@/lib/api-auth", () => ({
  authorizeDashboardOrApiKey: mockAuthorizeDashboardOrApiKey,
  getServerSession: mockGetServerSession,
  unauthorizedResponse: mockUnauthorizedResponse,
}));

vi.mock("@/lib/api-key-permissions", () => ({
  requireFullAccessForApiKeyCaller: mockRequireFullAccessForApiKeyCaller,
}));

vi.mock("@/lib/db", () => ({
  db: {
    query: {
      subscriptions: { findFirst: mockFindBySubscription },
      plans: { findFirst: mockFindByPlanId },
    },
  },
}));

vi.mock("@/lib/db/schema", () => ({
  plans: {},
  subscriptions: {},
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn(),
}));

vi.mock("@opensend/core", () => ({
  dedicatedIpPoolRepo: {
    listForUser: mockListForUser,
    countForUser: mockCountForUser,
    create: mockCreate,
    findByIdForUser: mockFindByIdForUser,
    updateForUser: mockUpdateForUser,
  },
  configurationSetService: {
    deleteDedicatedIpPool: mockDeleteDedicatedIpPool,
  },
  resolveBillingEntitlement: mockResolveBillingEntitlement,
}));

vi.mock("zod", async (importOriginal) => {
  return await importOriginal();
});

import { DELETE, PATCH } from "@/app/api/dedicated-ips/[id]/route";
import { GET, POST } from "@/app/api/dedicated-ips/route";

const SESSION = { user: { id: "user-1", email: "test@example.com" } };

describe("GET /api/dedicated-ips", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireFullAccessForApiKeyCaller.mockReturnValue(null);
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuthorizeDashboardOrApiKey.mockResolvedValueOnce(null);
    const req = new Request("http://localhost/api/dedicated-ips");
    const res = await GET(req);
    expect(res.status).toBe(401);
  });

  it("returns empty list when no pools", async () => {
    mockAuthorizeDashboardOrApiKey.mockResolvedValueOnce({ dashboard: true });
    mockGetServerSession.mockResolvedValueOnce(SESSION);
    mockListForUser.mockResolvedValueOnce([]);

    const req = new Request("http://localhost/api/dedicated-ips");
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual([]);
    expect(body.object).toBe("list");
  });
});

describe("POST /api/dedicated-ips — plan gating", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireFullAccessForApiKeyCaller.mockReturnValue(null);
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuthorizeDashboardOrApiKey.mockResolvedValueOnce(null);
    const req = new Request("http://localhost/api/dedicated-ips", {
      method: "POST",
      body: JSON.stringify({ name: "Pool", ses_pool_name: "ses-pool" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it("rejects sending-only API keys before creating lifecycle records", async () => {
    mockAuthorizeDashboardOrApiKey.mockResolvedValueOnce({
      apiKeyId: "key-send",
      permission: "sending_access",
      domain: null,
      userId: "user-1",
    });
    mockRequireFullAccessForApiKeyCaller.mockReturnValueOnce(
      Response.json(
        {
          error:
            "This API key does not have permission to access this resource.",
        },
        { status: 403 },
      ),
    );

    const req = new Request("http://localhost/api/dedicated-ips", {
      method: "POST",
      body: JSON.stringify({ name: "Pool", ses_pool_name: "ses-pool" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(403);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("allows self-host deployments with unlimited dedicated IP pools", async () => {
    mockAuthorizeDashboardOrApiKey.mockResolvedValueOnce({ dashboard: true });
    mockGetServerSession.mockResolvedValueOnce(SESSION);
    mockResolveBillingEntitlement.mockResolvedValueOnce({ mode: "self_host" });
    mockCountForUser.mockResolvedValueOnce(1_000_000);
    mockCreate.mockResolvedValueOnce({
      id: "pool-1",
      userId: "user-1",
      name: "Pool",
      sesPoolName: "ses-pool",
      scalingMode: "MANAGED",
      status: "requested",
      provider: "manual",
      operatorNotes: null,
      provisionedAt: null,
      warmingStartedAt: null,
      retiredAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const req = new Request("http://localhost/api/dedicated-ips", {
      method: "POST",
      body: JSON.stringify({ name: "Pool", ses_pool_name: "ses-pool" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(201);
    expect(mockResolveBillingEntitlement).toHaveBeenCalledWith("user-1");
    expect(mockCreate).toHaveBeenCalled();
  });

  it("returns 402 when hosted billing has no active paid subscription", async () => {
    mockAuthorizeDashboardOrApiKey.mockResolvedValueOnce({ dashboard: true });
    mockGetServerSession.mockResolvedValueOnce(SESSION);
    mockResolveBillingEntitlement.mockResolvedValueOnce({
      mode: "blocked",
      reason: "no_subscription",
    });

    const req = new Request("http://localhost/api/dedicated-ips", {
      method: "POST",
      body: JSON.stringify({ name: "Pool", ses_pool_name: "ses-pool" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(402);
    const body = await res.json();
    expect(body.code).toBe("payment_required");
    expect(body.reason).toBe("no_subscription");
    expect(mockCountForUser).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("returns 402 when a non-active subscription is blocked by the resolver", async () => {
    mockAuthorizeDashboardOrApiKey.mockResolvedValueOnce({ dashboard: true });
    mockGetServerSession.mockResolvedValueOnce(SESSION);
    mockResolveBillingEntitlement.mockResolvedValueOnce({
      mode: "blocked",
      reason: "past_due",
    });

    const req = new Request("http://localhost/api/dedicated-ips", {
      method: "POST",
      body: JSON.stringify({ name: "Pool", ses_pool_name: "ses-pool" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(402);
    const body = await res.json();
    expect(body.code).toBe("payment_required");
    expect(body.reason).toBe("past_due");
    expect(mockCountForUser).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("returns 403 when an active paid plan has dedicatedIpsEnabled=false", async () => {
    mockAuthorizeDashboardOrApiKey.mockResolvedValueOnce({ dashboard: true });
    mockGetServerSession.mockResolvedValueOnce(SESSION);
    mockResolveBillingEntitlement.mockResolvedValueOnce({
      mode: "active",
      plan: {
        dedicatedIpsEnabled: false,
        maxDedicatedIps: 0,
      },
      periodStart: new Date(),
      periodEnd: new Date(),
    });

    const req = new Request("http://localhost/api/dedicated-ips", {
      method: "POST",
      body: JSON.stringify({ name: "Pool", ses_pool_name: "ses-pool" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe("plan_feature_unavailable");
  });

  it("returns 402 when active paid plan's pool limit is reached", async () => {
    mockAuthorizeDashboardOrApiKey.mockResolvedValueOnce({ dashboard: true });
    mockGetServerSession.mockResolvedValueOnce(SESSION);
    mockResolveBillingEntitlement.mockResolvedValueOnce({
      mode: "active",
      plan: {
        dedicatedIpsEnabled: true,
        maxDedicatedIps: 1,
      },
      periodStart: new Date(),
      periodEnd: new Date(),
    });
    mockCountForUser.mockResolvedValueOnce(1); // already at limit

    const req = new Request("http://localhost/api/dedicated-ips", {
      method: "POST",
      body: JSON.stringify({ name: "Pool", ses_pool_name: "ses-pool" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(402);
    const body = await res.json();
    expect(body.code).toBe("quota_exceeded");
  });

  it("creates pool and returns 201 when active paid plan allows it", async () => {
    mockAuthorizeDashboardOrApiKey.mockResolvedValueOnce({ dashboard: true });
    mockGetServerSession.mockResolvedValueOnce(SESSION);
    mockResolveBillingEntitlement.mockResolvedValueOnce({
      mode: "active",
      plan: {
        dedicatedIpsEnabled: true,
        maxDedicatedIps: 5,
      },
      periodStart: new Date(),
      periodEnd: new Date(),
    });
    mockCountForUser.mockResolvedValueOnce(0);
    mockCreate.mockResolvedValueOnce({
      id: "pool-1",
      userId: "user-1",
      name: "Pool",
      sesPoolName: "ses-pool",
      scalingMode: "MANAGED",
      status: "requested",
      provider: "manual",
      operatorNotes: null,
      provisionedAt: null,
      warmingStartedAt: null,
      retiredAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const req = new Request("http://localhost/api/dedicated-ips", {
      method: "POST",
      body: JSON.stringify({ name: "Pool", ses_pool_name: "ses-pool" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.object).toBe("dedicated_ip_pool");
    expect(body.status).toBe("requested");
    expect(body.provider_pool_name).toBe("ses-pool");
  });
});

const POOL_FIXTURE = {
  id: "pool-1",
  userId: "user-1",
  name: "Pool",
  sesPoolName: "opensend-abcd1234-abcd1234",
  scalingMode: "MANAGED",
  status: "active",
  provider: "ses",
  operatorNotes: null,
  awsRegion: "us-east-1",
  ipCount: 1,
  lastSyncedAt: null,
  provisionedAt: new Date(),
  warmingStartedAt: null,
  retiredAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe("DELETE /api/dedicated-ips/[id] — SES pool release", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireFullAccessForApiKeyCaller.mockReturnValue(null);
    mockDeleteDedicatedIpPool.mockResolvedValue(undefined);
  });

  it("calls deleteDedicatedIpPool when provider===ses before retiring", async () => {
    mockAuthorizeDashboardOrApiKey.mockResolvedValueOnce({ dashboard: true });
    mockGetServerSession.mockResolvedValueOnce(SESSION);
    mockFindByIdForUser.mockResolvedValueOnce(POOL_FIXTURE);
    mockUpdateForUser.mockResolvedValueOnce({
      ...POOL_FIXTURE,
      status: "retired",
      retiredAt: new Date(),
    });

    const req = new Request("http://localhost/api/dedicated-ips/pool-1", {
      method: "DELETE",
    });
    const res = await DELETE(req, {
      params: Promise.resolve({ id: "pool-1" }),
    });
    expect(res.status).toBe(200);
    expect(mockDeleteDedicatedIpPool).toHaveBeenCalledWith({
      poolName: POOL_FIXTURE.sesPoolName,
      region: POOL_FIXTURE.awsRegion,
    });
  });

  it("leaves SES-backed pools retryable when provider deletion fails", async () => {
    mockAuthorizeDashboardOrApiKey.mockResolvedValueOnce({ dashboard: true });
    mockGetServerSession.mockResolvedValueOnce(SESSION);
    mockFindByIdForUser.mockResolvedValueOnce(POOL_FIXTURE);
    mockDeleteDedicatedIpPool.mockRejectedValueOnce(
      new Error("ses unavailable"),
    );

    const req = new Request("http://localhost/api/dedicated-ips/pool-1", {
      method: "DELETE",
    });
    const res = await DELETE(req, {
      params: Promise.resolve({ id: "pool-1" }),
    });
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.code).toBe("ses_pool_delete_failed");
    expect(mockUpdateForUser).not.toHaveBeenCalled();
  });

  it("does not call deleteDedicatedIpPool for manual provider", async () => {
    mockAuthorizeDashboardOrApiKey.mockResolvedValueOnce({ dashboard: true });
    mockGetServerSession.mockResolvedValueOnce(SESSION);
    mockFindByIdForUser.mockResolvedValueOnce({
      ...POOL_FIXTURE,
      provider: "manual",
    });
    mockUpdateForUser.mockResolvedValueOnce({
      ...POOL_FIXTURE,
      provider: "manual",
      status: "retired",
    });

    const req = new Request("http://localhost/api/dedicated-ips/pool-1", {
      method: "DELETE",
    });
    const res = await DELETE(req, {
      params: Promise.resolve({ id: "pool-1" }),
    });
    expect(res.status).toBe(200);
    expect(mockDeleteDedicatedIpPool).not.toHaveBeenCalled();
  });
});

describe("PATCH /api/dedicated-ips/[id] — SES pool release on retire", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireFullAccessForApiKeyCaller.mockReturnValue(null);
    mockDeleteDedicatedIpPool.mockResolvedValue(undefined);
  });

  it("calls deleteDedicatedIpPool when PATCH sets status=retired and provider===ses", async () => {
    mockAuthorizeDashboardOrApiKey.mockResolvedValueOnce({ dashboard: true });
    mockGetServerSession.mockResolvedValueOnce(SESSION);
    mockFindByIdForUser.mockResolvedValueOnce(POOL_FIXTURE);
    mockUpdateForUser.mockResolvedValueOnce({
      ...POOL_FIXTURE,
      status: "retired",
      retiredAt: new Date(),
    });

    const req = new Request("http://localhost/api/dedicated-ips/pool-1", {
      method: "PATCH",
      body: JSON.stringify({ status: "retired" }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ id: "pool-1" }) });
    expect(res.status).toBe(200);
    expect(mockDeleteDedicatedIpPool).toHaveBeenCalledWith({
      poolName: POOL_FIXTURE.sesPoolName,
      region: POOL_FIXTURE.awsRegion,
    });
  });

  it("leaves SES-backed pools retryable when PATCH retire provider deletion fails", async () => {
    mockAuthorizeDashboardOrApiKey.mockResolvedValueOnce({ dashboard: true });
    mockGetServerSession.mockResolvedValueOnce(SESSION);
    mockFindByIdForUser.mockResolvedValueOnce(POOL_FIXTURE);
    mockDeleteDedicatedIpPool.mockRejectedValueOnce(
      new Error("ses unavailable"),
    );

    const req = new Request("http://localhost/api/dedicated-ips/pool-1", {
      method: "PATCH",
      body: JSON.stringify({ status: "retired" }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ id: "pool-1" }) });
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.code).toBe("ses_pool_delete_failed");
    expect(mockUpdateForUser).not.toHaveBeenCalled();
  });

  it("does not call deleteDedicatedIpPool when PATCH status is not retired", async () => {
    mockAuthorizeDashboardOrApiKey.mockResolvedValueOnce({ dashboard: true });
    mockGetServerSession.mockResolvedValueOnce(SESSION);
    mockUpdateForUser.mockResolvedValueOnce({
      ...POOL_FIXTURE,
      status: "active",
    });

    const req = new Request("http://localhost/api/dedicated-ips/pool-1", {
      method: "PATCH",
      body: JSON.stringify({ status: "active" }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ id: "pool-1" }) });
    expect(res.status).toBe(200);
    expect(mockDeleteDedicatedIpPool).not.toHaveBeenCalled();
  });

  it("rejects provider pool name changes after SES provisioning", async () => {
    mockAuthorizeDashboardOrApiKey.mockResolvedValueOnce({ dashboard: true });
    mockGetServerSession.mockResolvedValueOnce(SESSION);
    mockFindByIdForUser.mockResolvedValueOnce(POOL_FIXTURE);

    const req = new Request("http://localhost/api/dedicated-ips/pool-1", {
      method: "PATCH",
      body: JSON.stringify({ provider_pool_name: "attacker-existing-pool" }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ id: "pool-1" }) });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe("provider_pool_name_locked");
    expect(mockUpdateForUser).not.toHaveBeenCalled();
    expect(mockDeleteDedicatedIpPool).not.toHaveBeenCalled();
  });
});
