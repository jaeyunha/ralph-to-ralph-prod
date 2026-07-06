import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Mocks ────────────────────────────────────────────────────────────────────
const mockFindById = vi.hoisted(() => vi.fn());
const mockUpdateById = vi.hoisted(() => vi.fn());
const mockUpdateSyncMetadata = vi.hoisted(() => vi.fn());
const mockCreateDedicatedIpPool = vi.hoisted(() => vi.fn());
const mockGetDedicatedIps = vi.hoisted(() => vi.fn());

vi.mock("../packages/core/src/db/repositories/dedicatedIpPoolRepo", () => ({
  dedicatedIpPoolRepo: {
    findById: mockFindById,
    updateById: mockUpdateById,
    updateSyncMetadata: mockUpdateSyncMetadata,
  },
}));

vi.mock("../packages/core/src/services/configurationSet", () => ({
  configurationSetService: {
    createDedicatedIpPool: mockCreateDedicatedIpPool,
    getDedicatedIps: mockGetDedicatedIps,
  },
}));

// Mock db client for volume check
const mockSelect = vi.hoisted(() => vi.fn().mockReturnThis());
const mockFrom = vi.hoisted(() => vi.fn().mockReturnThis());
const mockWhere = vi.hoisted(() => vi.fn().mockReturnThis());
const mockOrderBy = vi.hoisted(() => vi.fn().mockReturnThis());
const mockLimit = vi.hoisted(() => vi.fn());

vi.mock("../packages/core/src/db/client", () => ({
  db: {
    select: mockSelect,
  },
}));

vi.mock("../packages/core/src/db/schema", () => ({
  usagePeriods: { userId: "userId", periodStart: "periodStart" },
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((col: unknown, val: unknown) => ({ col, val })),
  desc: vi.fn((col: unknown) => ({ desc: col })),
}));

import {
  DEDICATED_IP_MIN_MONTHLY_VOLUME,
  approveAndProvisionPool,
  reconcileProvisionedPool,
} from "../packages/core/src/services/dedicatedIpPoolService";

const BASE_POOL = {
  id: "pool-uuid-1234",
  userId: "user-abcdefgh",
  name: "My Pool",
  sesPoolName: "manual-some-uuid",
  scalingMode: "MANAGED",
  status: "requested" as const,
  provider: "manual",
  operatorNotes: null,
  awsRegion: null,
  ipCount: null,
  lastSyncedAt: null,
  provisionedAt: null,
  warmingStartedAt: null,
  retiredAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe("approveAndProvisionPool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: volume check returns no data (volume = 0)
    mockSelect.mockReturnValue({
      from: mockFrom.mockReturnValue({
        where: mockWhere.mockReturnValue({
          orderBy: mockOrderBy.mockReturnValue({
            limit: mockLimit.mockResolvedValue([]),
          }),
        }),
      }),
    });
    mockCreateDedicatedIpPool.mockResolvedValue(undefined);
    mockUpdateById.mockResolvedValue({
      ...BASE_POOL,
      status: "provisioned",
      provider: "ses",
    });
  });

  it("returns not_found when pool does not exist", async () => {
    mockFindById.mockResolvedValueOnce(undefined);
    const result = await approveAndProvisionPool("nonexistent-id");
    expect(result).toEqual({ ok: false, code: "not_found" });
    expect(mockCreateDedicatedIpPool).not.toHaveBeenCalled();
  });

  it("returns invalid_status when pool is not in requested state", async () => {
    mockFindById.mockResolvedValueOnce({ ...BASE_POOL, status: "provisioned" });
    const result = await approveAndProvisionPool(BASE_POOL.id);
    expect(result).toEqual({
      ok: false,
      code: "invalid_status",
      current: "provisioned",
    });
    expect(mockCreateDedicatedIpPool).not.toHaveBeenCalled();
  });

  it("happy path: calls createDedicatedIpPool with collision-proof name and marks provisioned", async () => {
    mockFindById.mockResolvedValueOnce(BASE_POOL);
    const updatedPool = {
      ...BASE_POOL,
      status: "provisioned",
      provider: "ses",
      awsRegion: "us-east-1",
      sesPoolName: "opensend-userabcd-pooluuid",
    };
    mockUpdateById.mockResolvedValue(updatedPool);

    const result = await approveAndProvisionPool(BASE_POOL.id, {
      awsRegion: "us-east-1",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Verifies SES pool was called
    expect(mockCreateDedicatedIpPool).toHaveBeenCalledOnce();
    const callArgs = mockCreateDedicatedIpPool.mock.calls[0][0];
    // Should NOT be the original manual- name
    expect(callArgs.poolName).not.toContain("manual-");
    expect(callArgs.poolName).toMatch(/^opensend-/);
    expect(callArgs.scalingMode).toBe("MANAGED");
    expect(callArgs.region).toBe("us-east-1");
    // Verifies DB was updated
    expect(mockUpdateById).toHaveBeenCalledWith(
      BASE_POOL.id,
      expect.objectContaining({
        status: "provisioned",
        provider: "ses",
        awsRegion: "us-east-1",
      }),
    );
  });

  it("is idempotent: swallows AlreadyExistsException from SES", async () => {
    mockFindById.mockResolvedValueOnce(BASE_POOL);
    const alreadyExists = new Error("already exists");
    (alreadyExists as Error & { name: string }).name = "AlreadyExistsException";
    mockCreateDedicatedIpPool.mockRejectedValueOnce(alreadyExists);

    const result = await approveAndProvisionPool(BASE_POOL.id);
    // Should succeed even with AlreadyExistsException
    expect(result.ok).toBe(true);
    expect(mockUpdateById).toHaveBeenCalled();
  });

  it("sets volumeWarning=true when emailsSent < threshold", async () => {
    mockFindById.mockResolvedValueOnce(BASE_POOL);
    mockSelect.mockReturnValue({
      from: mockFrom.mockReturnValue({
        where: mockWhere.mockReturnValue({
          orderBy: mockOrderBy.mockReturnValue({
            limit: mockLimit.mockResolvedValue([{ emailsSent: 1000 }]),
          }),
        }),
      }),
    });

    const result = await approveAndProvisionPool(BASE_POOL.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.volumeWarning).toBe(true);
    expect(result.emailsSent).toBe(1000);
  });

  it("sets volumeWarning=false when emailsSent >= threshold", async () => {
    mockFindById.mockResolvedValueOnce(BASE_POOL);
    mockSelect.mockReturnValue({
      from: mockFrom.mockReturnValue({
        where: mockWhere.mockReturnValue({
          orderBy: mockOrderBy.mockReturnValue({
            limit: mockLimit.mockResolvedValue([
              { emailsSent: DEDICATED_IP_MIN_MONTHLY_VOLUME },
            ]),
          }),
        }),
      }),
    });

    const result = await approveAndProvisionPool(BASE_POOL.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.volumeWarning).toBe(false);
  });

  it("ignores tenant-supplied SES pool names during approval", async () => {
    const poolWithTenantSuppliedName = {
      ...BASE_POOL,
      sesPoolName: "attacker-chosen-existing-pool",
    };
    mockFindById.mockResolvedValueOnce(poolWithTenantSuppliedName);

    await approveAndProvisionPool(BASE_POOL.id);

    const callArgs = mockCreateDedicatedIpPool.mock.calls[0][0];
    expect(callArgs.poolName).toBe("opensend-userabcd-pooluuid");
  });
});

describe("reconcileProvisionedPool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const PROVISIONED_POOL = {
    ...BASE_POOL,
    status: "provisioned" as const,
    provider: "ses",
    sesPoolName: "opensend-userabcd-pooluuid",
    awsRegion: "us-east-1",
    lastSyncedAt: null,
  };

  it("returns ok:false when pool does not exist", async () => {
    mockFindById.mockResolvedValueOnce(undefined);
    const result = await reconcileProvisionedPool("nonexistent");
    expect(result).toEqual({ ok: false });
  });

  it("skips reconcile when lastSyncedAt < 5 minutes ago", async () => {
    const recentSync = new Date(Date.now() - 60_000); // 1 minute ago
    mockFindById.mockResolvedValueOnce({
      ...PROVISIONED_POOL,
      lastSyncedAt: recentSync,
      ipCount: 2,
    });
    const result = await reconcileProvisionedPool(PROVISIONED_POOL.id);
    expect(result).toEqual({ ok: true, ipCount: 2, graduated: false });
    expect(mockGetDedicatedIps).not.toHaveBeenCalled();
  });

  it("calls getDedicatedIps and updateSyncMetadata", async () => {
    mockFindById.mockResolvedValueOnce(PROVISIONED_POOL);
    mockGetDedicatedIps.mockResolvedValueOnce([]);
    mockUpdateSyncMetadata.mockResolvedValueOnce(PROVISIONED_POOL);

    await reconcileProvisionedPool(PROVISIONED_POOL.id);

    expect(mockGetDedicatedIps).toHaveBeenCalledWith({
      poolName: PROVISIONED_POOL.sesPoolName,
      region: PROVISIONED_POOL.awsRegion,
    });
    expect(mockUpdateSyncMetadata).toHaveBeenCalledWith(
      PROVISIONED_POOL.id,
      expect.objectContaining({ ipCount: 0 }),
    );
  });

  it("graduates provisioned→warming for STANDARD pool when IPs appear", async () => {
    mockFindById.mockResolvedValueOnce({
      ...PROVISIONED_POOL,
      scalingMode: "STANDARD",
    });
    mockGetDedicatedIps.mockResolvedValueOnce([
      { ip: "1.2.3.4", warmupStatus: "IN_PROGRESS" },
    ]);
    mockUpdateSyncMetadata.mockResolvedValueOnce({});
    mockUpdateById.mockResolvedValueOnce({});

    const result = await reconcileProvisionedPool(PROVISIONED_POOL.id);
    expect(result.graduated).toBe(true);
    expect(result.newStatus).toBe("warming");
    expect(mockUpdateById).toHaveBeenCalledWith(
      PROVISIONED_POOL.id,
      expect.objectContaining({ status: "warming" }),
    );
  });

  it("graduates provisioned→active for MANAGED pool when IPs not IN_PROGRESS", async () => {
    mockFindById.mockResolvedValueOnce(PROVISIONED_POOL);
    mockGetDedicatedIps.mockResolvedValueOnce([
      { ip: "1.2.3.4", warmupStatus: "NOT_APPLICABLE" },
    ]);
    mockUpdateSyncMetadata.mockResolvedValueOnce({});
    mockUpdateById.mockResolvedValueOnce({});

    const result = await reconcileProvisionedPool(PROVISIONED_POOL.id);
    expect(result.graduated).toBe(true);
    expect(result.newStatus).toBe("active");
    expect(mockUpdateById).toHaveBeenCalledWith(
      PROVISIONED_POOL.id,
      expect.objectContaining({ status: "active" }),
    );
  });

  it("graduates warming→active when all IPs not IN_PROGRESS", async () => {
    mockFindById.mockResolvedValueOnce({
      ...PROVISIONED_POOL,
      status: "warming",
      scalingMode: "STANDARD",
    });
    mockGetDedicatedIps.mockResolvedValueOnce([
      { ip: "1.2.3.4", warmupStatus: "DONE" },
      { ip: "5.6.7.8", warmupStatus: "DONE" },
    ]);
    mockUpdateSyncMetadata.mockResolvedValueOnce({});
    mockUpdateById.mockResolvedValueOnce({});

    const result = await reconcileProvisionedPool(PROVISIONED_POOL.id);
    expect(result.graduated).toBe(true);
    expect(result.newStatus).toBe("active");
  });

  it("does not graduate when some IPs still IN_PROGRESS", async () => {
    mockFindById.mockResolvedValueOnce({
      ...PROVISIONED_POOL,
      status: "warming",
    });
    mockGetDedicatedIps.mockResolvedValueOnce([
      { ip: "1.2.3.4", warmupStatus: "IN_PROGRESS" },
      { ip: "5.6.7.8", warmupStatus: "DONE" },
    ]);
    mockUpdateSyncMetadata.mockResolvedValueOnce({});

    const result = await reconcileProvisionedPool(PROVISIONED_POOL.id);
    expect(result.graduated).toBe(false);
    expect(mockUpdateById).not.toHaveBeenCalled();
  });
});
