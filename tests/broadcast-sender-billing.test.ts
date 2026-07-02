import { beforeEach, describe, expect, it, vi } from "vitest";

const mockDb = vi.hoisted(() => {
  // biome-ignore lint/suspicious/noExplicitAny: test double for drizzle db
  const db: any = {
    select: vi.fn(),
    update: vi.fn(),
    insert: vi.fn(),
    query: {
      topics: { findFirst: vi.fn() },
    },
  };
  db.transaction = vi.fn(async (cb: (tx: unknown) => unknown) => cb(db));
  return db;
});

const mockReserveEmailQuota = vi.hoisted(() => vi.fn());
const mockReleaseEmailQuota = vi.hoisted(() => vi.fn());

vi.mock("@/lib/db", () => ({
  db: mockDb,
}));

vi.mock("@/lib/billing/quota", () => ({
  reserveEmailQuota: mockReserveEmailQuota,
  releaseEmailQuota: mockReleaseEmailQuota,
}));

import { processScheduledBroadcasts } from "@/lib/workers/broadcast-sender";

type Contact = {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  topicSubscriptions: null;
};

type Broadcast = {
  id: string;
  name: string;
  status: "queued" | "scheduled";
  audienceId: string | null;
  topicId: string | null;
  subject: string;
  html: string;
  text: string;
  from: string;
  userId: string;
};

function broadcast(overrides: Partial<Broadcast> = {}): Broadcast {
  return {
    id: "broadcast-1",
    name: "Launch",
    status: "queued",
    audienceId: null,
    topicId: null,
    subject: "Hello {{FIRST_NAME}}",
    html: "<p>Hello {{EMAIL}}</p>",
    text: "Hello {{EMAIL}}",
    from: "sender@example.test",
    userId: "user-1",
    ...overrides,
  };
}

function contact(overrides: Partial<Contact> = {}): Contact {
  return {
    id: "contact-1",
    email: "one@example.test",
    firstName: "Ada",
    lastName: null,
    topicSubscriptions: null,
    ...overrides,
  };
}

function mockSelectResults(...results: unknown[][]) {
  const queuedResults = [...results];
  mockDb.select.mockImplementation(() => ({
    from: vi.fn(() => {
      const result = queuedResults.shift() ?? [];
      const chain = {
        where: vi.fn(() => chain),
        limit: vi.fn(() => result),
        // biome-ignore lint/suspicious/noThenProperty: mock drizzle query chain must be awaitable
        then: (resolve: (value: unknown[]) => unknown) =>
          Promise.resolve(result).then(resolve),
      };
      return chain;
    }),
  }));
}

function mockUpdateChain() {
  const where = vi.fn().mockResolvedValue(undefined);
  const set = vi.fn(() => ({ where }));
  mockDb.update.mockReturnValue({ set });
  return { set, where };
}

function mockInsertChain() {
  const values = vi.fn().mockResolvedValue(undefined);
  mockDb.insert.mockReturnValue({ values });
  return { values };
}

function updateSetMock() {
  const updateResult = mockDb.update.mock.results.at(-1)?.value as
    | { set?: ReturnType<typeof vi.fn> }
    | undefined;
  return updateResult?.set;
}

describe("broadcast sender billing gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.query.topics.findFirst.mockResolvedValue(null);
    mockUpdateChain();
    mockInsertChain();
  });

  it("marks unpaid hosted broadcasts billing-blocked, creates zero email rows, and continues", async () => {
    const blocked = broadcast({
      id: "broadcast-blocked",
      userId: "blocked-user",
    });
    const allowed = broadcast({ id: "broadcast-allowed", userId: "paid-user" });
    const blockedContacts = [
      contact({ id: "blocked-contact-1", email: "blocked-1@example.test" }),
      contact({ id: "blocked-contact-2", email: "blocked-2@example.test" }),
    ];
    const allowedContacts = [
      contact({ id: "allowed-contact-1", email: "allowed@example.test" }),
    ];
    mockSelectResults([blocked, allowed], blockedContacts, allowedContacts);
    mockReserveEmailQuota
      .mockResolvedValueOnce({ ok: false, reason: "no_active_subscription" })
      .mockResolvedValueOnce({ ok: true, bypassed: false });

    await expect(processScheduledBroadcasts()).resolves.toEqual({
      processed: 2,
      emailsCreated: 1,
    });

    expect(mockReserveEmailQuota).toHaveBeenNthCalledWith(
      1,
      "blocked-user",
      blockedContacts.length,
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
    expect(mockReserveEmailQuota).toHaveBeenNthCalledWith(
      2,
      "paid-user",
      allowedContacts.length,
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
    expect(mockDb.insert).toHaveBeenCalledTimes(1);
    expect(updateSetMock()).toHaveBeenCalledWith({
      status: "blocked_billing",
    });
    expect(mockReleaseEmailQuota).not.toHaveBeenCalled();
  });

  it("reserves quota before creating any email rows", async () => {
    const pending = broadcast({ id: "broadcast-paid", userId: "paid-user" });
    mockSelectResults([pending], [contact()]);
    mockReserveEmailQuota.mockResolvedValue({ ok: true, bypassed: false });

    await expect(processScheduledBroadcasts()).resolves.toEqual({
      processed: 1,
      emailsCreated: 1,
    });

    expect(mockReserveEmailQuota).toHaveBeenCalledWith(
      "paid-user",
      1,
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
    expect(mockDb.insert).toHaveBeenCalledTimes(1);
    expect(mockReserveEmailQuota.mock.invocationCallOrder[0]).toBeLessThan(
      mockDb.insert.mock.invocationCallOrder[0],
    );
  });

  it("fans out without consuming quota when reservation is self-host bypassed", async () => {
    const pending = broadcast({
      id: "broadcast-self-host",
      userId: "self-host-user",
    });
    const targets = [
      contact({ id: "self-host-contact-1", email: "self-host-1@example.test" }),
      contact({ id: "self-host-contact-2", email: "self-host-2@example.test" }),
    ];
    mockSelectResults([pending], targets);
    mockReserveEmailQuota.mockResolvedValue({ ok: true, bypassed: true });

    await expect(processScheduledBroadcasts()).resolves.toEqual({
      processed: 1,
      emailsCreated: 2,
    });

    expect(mockReserveEmailQuota).toHaveBeenCalledWith(
      "self-host-user",
      targets.length,
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
    expect(mockDb.insert).toHaveBeenCalledTimes(targets.length);
    expect(mockReleaseEmailQuota).not.toHaveBeenCalled();
  });

  it("fans out after reserving quota for active paid users", async () => {
    const pending = broadcast({
      id: "broadcast-active-paid",
      userId: "paid-user",
    });
    const targets = [
      contact({ id: "paid-contact-1", email: "paid-1@example.test" }),
      contact({ id: "paid-contact-2", email: "paid-2@example.test" }),
    ];
    mockSelectResults([pending], targets);
    mockReserveEmailQuota.mockResolvedValue({ ok: true, bypassed: false });

    await expect(processScheduledBroadcasts()).resolves.toEqual({
      processed: 1,
      emailsCreated: 2,
    });

    expect(mockReserveEmailQuota).toHaveBeenCalledWith(
      "paid-user",
      targets.length,
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
    expect(mockDb.insert).toHaveBeenCalledTimes(targets.length);
  });
});
