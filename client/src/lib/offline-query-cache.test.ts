import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isOfflineCacheableQueryKey,
  isDeltaSyncBackedQueryKey,
  isOfflineQueryRecordUsable,
  offlineQueryCacheKey,
  persistOfflineQuery,
  persistOfflineQueryForDeltaSync,
  sanitizeOfflineQueryData,
} from "./offline-query-cache";
import { getOfflineQueryDeltaEntity, getOfflineQueryStaleTime } from "./offline-query-policy";

describe("offline query cache policy", () => {
  it("caches tenant-scoped operational PowerHub queries", () => {
    expect(isOfflineCacheableQueryKey(["powerhub", "subscribers", "list", { siteId: 7 }])).toBe(true);
    expect(isOfflineCacheableQueryKey(["powerhub", "readings", "list", { siteId: 7 }])).toBe(true);
    expect(isOfflineCacheableQueryKey(["powerhub", "sites", "list"])).toBe(true);
    expect(isOfflineCacheableQueryKey(["powerhub", "generators", "list", { siteId: 7 }])).toBe(true);
    expect(isOfflineCacheableQueryKey(["powerhub.tariffs.list", { input: { siteId: 7 }, type: "query" }])).toBe(true);
  });

  it("does not cache financial, dashboard, admin, audit, or auth queries", () => {
    expect(isOfflineCacheableQueryKey(["powerhub", "payments", "list", { siteId: 7 }])).toBe(false);
    expect(isOfflineCacheableQueryKey(["powerhub", "dashboard", "summary", { siteId: 7 }])).toBe(false);
    expect(isOfflineCacheableQueryKey(["powerhub", "admin", "tenants"])).toBe(false);
    expect(isOfflineCacheableQueryKey(["auth", "me"])).toBe(false);
    expect(isOfflineCacheableQueryKey(["powerhub", "audit", "list", { siteId: 7 }])).toBe(false);
  });

  it("persists bounded history pages and maps supported pages to their Delta feeds", () => {
    const readingPage = ["powerhub.readings.page", {
      input: { siteId: 7, limit: 200 }, type: "query",
    }];
    const invoicePage = ["powerhub.invoices.page", {
      input: { siteId: 7, limit: 100 }, type: "query",
    }];
    const paymentPage = ["powerhub.payments.page", {
      input: { siteId: 7, limit: 100, cursor: "next-page-token" }, type: "query",
    }];
    const expensePage = ["powerhub.expenses.page", {
      input: { siteId: 7, limit: 100, startDate: "2026-10-01", endDate: "2026-10-27", companyAccountId: 12 },
      type: "query",
    }];

    for (const key of [readingPage, invoicePage, paymentPage, expensePage]) {
      expect(isOfflineCacheableQueryKey(key)).toBe(true);
    }

    // Every page marked Delta-backed here has a corresponding scoped server feed and runtime projection.
    expect(isDeltaSyncBackedQueryKey(readingPage)).toBe(true);
    expect(isDeltaSyncBackedQueryKey(invoicePage)).toBe(true);
    expect(isDeltaSyncBackedQueryKey(paymentPage)).toBe(true);
    expect(isDeltaSyncBackedQueryKey(expensePage)).toBe(true);
    expect(getOfflineQueryDeltaEntity(expensePage)).toBe("expenses");
    expect(getOfflineQueryStaleTime(paymentPage)).toBe(Number.POSITIVE_INFINITY);

    expect(isOfflineCacheableQueryKey(["powerhub.readings.page", {
      input: { siteId: 0, limit: 100 }, type: "query",
    }])).toBe(false);
    expect(isOfflineCacheableQueryKey(["powerhub.invoices.page", {
      input: { siteId: 7, limit: 201 }, type: "query",
    }])).toBe(false);
    expect(isOfflineCacheableQueryKey(["powerhub.payments.page", {
      input: { siteId: 7, limit: 100, includeOtherSites: true }, type: "query",
    }])).toBe(false);
    expect(isOfflineCacheableQueryKey(["powerhub.expenses.page", {
      input: { siteId: 7, limit: 100, cursor: "next-page-token" }, type: "query",
    }])).toBe(true);
    expect(isDeltaSyncBackedQueryKey(["powerhub.expenses.page", {
      input: { siteId: 7, limit: 100, cursor: "next-page-token" }, type: "query",
    }])).toBe(true);
    expect(isOfflineCacheableQueryKey(["powerhub.expenses.page", {
      input: { siteId: 7, limit: 100, cursor: "" }, type: "query",
    }])).toBe(false);
    expect(isOfflineCacheableQueryKey(["powerhub.expenses.page", {
      input: { siteId: 7, limit: 100, cursor: "x".repeat(501) }, type: "query",
    }])).toBe(false);
    expect(isOfflineCacheableQueryKey(["powerhub.expenses.page", {
      input: { siteId: 7, limit: 100, startDate: "2026-10-28" }, type: "query",
    }])).toBe(false);
    expect(isOfflineCacheableQueryKey(["powerhub.payments.list", {
      input: { siteId: 7 }, type: "query",
    }])).toBe(false);
    expect(isOfflineCacheableQueryKey(["powerhub.expenses.page", {
      input: { siteId: 7, limit: 100, companyAccountId: 0 }, type: "query",
    }])).toBe(false);
  });

  it("persists only bounded, unfiltered subscriber directory pages for a valid site", () => {
    const pageOne = ["powerhub.subscribers.directoryPage", {
      input: { siteId: 7, page: 1, pageSize: 20, search: "" },
      type: "query",
    }];
    const pageTwo = ["powerhub.subscribers.directoryPage", {
      input: { siteId: 7, page: 2, pageSize: 20, search: "" },
      type: "query",
    }];

    expect(isOfflineCacheableQueryKey(pageOne)).toBe(true);
    expect(isOfflineCacheableQueryKey(pageTwo)).toBe(true);
    expect(isOfflineCacheableQueryKey([["powerhub", "subscribers", "directoryPage"], {
      input: { siteId: 7, page: 1, pageSize: 20, search: "" }, type: "query",
    }])).toBe(true);
    expect(isOfflineCacheableQueryKey(["powerhub.subscribers.directoryPage", {
      input: { siteId: 7, page: 1, pageSize: 20, search: "أحمد" }, type: "query",
    }])).toBe(false);
    expect(isOfflineCacheableQueryKey(["powerhub.subscribers.directoryPage", {
      input: { siteId: 7, page: 1, pageSize: 20, search: "", subscriptionType: "commercial" }, type: "query",
    }])).toBe(false);
    expect(isOfflineCacheableQueryKey(["powerhub.subscribers.directoryPage", {
      input: { siteId: 7, page: 1, pageSize: 200, search: "" }, type: "query",
    }])).toBe(false);
    expect(isOfflineCacheableQueryKey(["powerhub.subscribers.directoryPage", {
      input: { siteId: 7, page: 0, pageSize: 20, search: "" }, type: "query",
    }])).toBe(false);
    expect(isOfflineCacheableQueryKey(["powerhub.subscribers.directoryPage", {
      input: { siteId: 0, page: 1, pageSize: 20, search: "" }, type: "query",
    }])).toBe(false);
    expect(isOfflineCacheableQueryKey(["powerhub.subscribers.directoryPage", {
      input: { siteId: 7, page: 1, pageSize: 20, search: "", includeFinancial: true }, type: "query",
    }])).toBe(false);
  });

  it("rejects unrelated namespaces and similarly named nested data", () => {
    expect(isOfflineCacheableQueryKey(["users", "list"])).toBe(false);
    expect(isOfflineCacheableQueryKey(["settings", "get"])).toBe(false);
    expect(isOfflineCacheableQueryKey(["powerhub", "subscriberQuota", "get", { label: "subscribers" }])).toBe(false);
    expect(isOfflineCacheableQueryKey(["powerhub", "subscribers", "getById", { siteId: 7, id: 12 }])).toBe(false);
    expect(isOfflineCacheableQueryKey(["powerhub.subscribers.directoryPage", { input: { siteId: 7 }, type: "query" }])).toBe(false);
    expect(isOfflineCacheableQueryKey([["powerhub", "subscribers", "list"], { input: { siteId: 7 } }])).toBe(true);
    expect(isOfflineCacheableQueryKey([["powerhub", "payments", "list"], { input: { siteId: 7 } }])).toBe(false);
  });

  it("keeps site-scoped query keys distinct after serialization", () => {
    const site7 = ["powerhub", "subscribers", "list", { siteId: 7 }];
    const site8 = ["powerhub", "subscribers", "list", { siteId: 8 }];
    expect(offlineQueryCacheKey(site7)).not.toBe(offlineQueryCacheKey(site8));
  });

  it("accepts only current-user, unexpired, cacheable records", () => {
    const key = ["powerhub", "subscribers", "list", { siteId: 7 }];
    const baseRecord = {
      userId: "user-1",
      serializedQueryKey: offlineQueryCacheKey(key),
      expiresAt: 2_000,
    };

    expect(isOfflineQueryRecordUsable(baseRecord, "user-1", 1_000)).toBe(true);
    expect(isOfflineQueryRecordUsable(baseRecord, "user-2", 1_000)).toBe(false);
    expect(isOfflineQueryRecordUsable(baseRecord, "user-1", 2_000)).toBe(false);
    expect(
      isOfflineQueryRecordUsable(
        { ...baseRecord, serializedQueryKey: offlineQueryCacheKey(["powerhub", "payments", "list"]) },
        "user-1",
        1_000,
      ),
    ).toBe(false);
  });

  it("retains allowed operational snapshots across days when no explicit expiry is set", () => {
    const key = ["powerhub", "subscribers", "list", { siteId: 7 }];
    const persistentRecord = {
      userId: "user-1",
      serializedQueryKey: offlineQueryCacheKey(key),
      expiresAt: null,
    };

    expect(isOfflineQueryRecordUsable(persistentRecord, "user-1", Date.parse("2030-01-01T00:00:00.000Z"))).toBe(true);
    expect(isOfflineQueryRecordUsable({ ...persistentRecord, expiresAt: 2_000 }, "user-1", 2_000)).toBe(false);
  });

  it("rejects malformed serialized query keys", () => {
    expect(
      isOfflineQueryRecordUsable(
        {
          userId: "user-1",
          serializedQueryKey: "not-valid-superjson",
          expiresAt: 2_000,
        },
        "user-1",
        1_000,
      ),
    ).toBe(false);
  });
});


describe("offline cache privacy sanitization", () => {
  it("strips current and legacy receipt URLs, private keys, and hashes before persistence/hydration", () => {
    const queryKey = ["powerhub.payments.page", {
      input: { siteId: 7, limit: 100 }, type: "query",
    }];
    const raw = {
      items: [{
        payment: {
          id: 4, hasReceiptImage: false,
          receiptImageUrl: "https://signed.example/temporary?token=secret",
          receiptImageKey: "private/payment-receipts/4.png",
          receiptImageHash: "private-hash",
          receipt_image_url: "https://signed.example/legacy?token=legacy",
          receipt_image_key: "private/legacy.png",
          receipt_image_hash: "legacy-hash",
        },
        subscriber: { id: 9, fullName: "Subscriber" },
      }],
      hasNext: false, nextCursor: null,
    };
    const safe = sanitizeOfflineQueryData(queryKey, raw) as typeof raw;
    expect(safe.items[0].payment.hasReceiptImage).toBe(true);
    for (const key of [
      "receiptImageUrl", "receiptImageKey", "receiptImageHash",
      "receipt_image_url", "receipt_image_key", "receipt_image_hash",
    ]) expect(safe.items[0].payment).not.toHaveProperty(key);
    expect(safe.items[0].subscriber.fullName).toBe("Subscriber");
  });

  it("does not alter unrelated query payloads", () => {
    const data = { items: [{ receipt_image_url: "preserve-other-domain" }] };
    expect(sanitizeOfflineQueryData(["powerhub.subscribers.list", { siteId: 7 }], data)).toEqual(data);
  });
});

describe("offline query freshness policy", () => {
  it("prevents full-query refetches for Delta-backed snapshots after reload", () => {
    expect(getOfflineQueryStaleTime(["powerhub", "sites", "list"])).toBe(Number.POSITIVE_INFINITY);
    expect(getOfflineQueryStaleTime(["powerhub", "subscribers", "list", { siteId: 7 }])).toBe(Number.POSITIVE_INFINITY);
    expect(getOfflineQueryStaleTime(["powerhub.invoices.page", {
      input: { siteId: 7, limit: 100 }, type: "query",
    }])).toBe(Number.POSITIVE_INFINITY);
  });

  it("keeps Delta-backed pages fresh while unsupported lists retain bounded freshness", () => {
    expect(getOfflineQueryStaleTime(["powerhub.readings.page", {
      input: { siteId: 7, limit: 200 }, type: "query",
    }])).toBe(Number.POSITIVE_INFINITY);
    expect(getOfflineQueryStaleTime(["powerhub.expenses.page", {
      input: { siteId: 7, limit: 100 }, type: "query",
    }])).toBe(Number.POSITIVE_INFINITY);
    expect(getOfflineQueryStaleTime(["powerhub.payments.page", {
      input: { siteId: 7, limit: 100 }, type: "query",
    }])).toBe(Number.POSITIVE_INFINITY);
    expect(getOfflineQueryStaleTime(["powerhub.schedules.list", {
      input: { siteId: 7 }, type: "query",
    }])).toBe(30_000);
  });
});

describe("Delta-backed local snapshots", () => {
  it("only marks supported whole-list procedures as Delta-backed", () => {
    expect(isDeltaSyncBackedQueryKey(["powerhub", "sites", "list"])).toBe(true);
    expect(isDeltaSyncBackedQueryKey(["powerhub", "subscribers", "list", { siteId: 7 }])).toBe(true);
    expect(isOfflineCacheableQueryKey(["powerhub", "companyAccounts", "list", { siteId: 7, branchId: 7 }])).toBe(true);
    expect(isDeltaSyncBackedQueryKey(["powerhub", "companyAccounts", "list", { siteId: 7, branchId: 7 }])).toBe(true);
    expect(getOfflineQueryDeltaEntity(["powerhub", "companyAccounts", "list", { siteId: 7, branchId: 7 }])).toBe("company_accounts");
    expect(getOfflineQueryDeltaEntity(["powerhub.companyAccounts.list", {
      input: { siteId: 7, branchId: 8 }, type: "query",
    }])).toBe("company_accounts");
    expect(getOfflineQueryDeltaEntity(["powerhub", "companyAccounts", "list", { siteId: 7 }])).toBe(null);
    expect(isOfflineCacheableQueryKey(["powerhub", "companyAccounts", "list", { siteId: 7 }])).toBe(false);
    expect(isOfflineCacheableQueryKey(["powerhub", "companyAccounts", "list", { siteId: 7, fromDate: "2026-10-01" }])).toBe(false);
    expect(isOfflineCacheableQueryKey(["powerhub", "companyAccounts", "list", { siteId: 7, branchId: 7, toDate: "2026-10-27" }])).toBe(false);
    expect(isDeltaSyncBackedQueryKey(["powerhub", "readings", "list", { siteId: 7 }])).toBe(true);
    expect(isDeltaSyncBackedQueryKey(["powerhub.tariffs.list", { input: { siteId: 7 }, type: "query" }])).toBe(true);
    expect(isDeltaSyncBackedQueryKey(["powerhub.invoices.page", {
      input: { siteId: 7, limit: 100 }, type: "query",
    }])).toBe(true);
    expect(isDeltaSyncBackedQueryKey(["powerhub.payments.page", {
      input: { siteId: 7, limit: 100 }, type: "query",
    }])).toBe(true);
    expect(isDeltaSyncBackedQueryKey(["powerhub.expenses.page", {
      input: { siteId: 7, limit: 100 }, type: "query",
    }])).toBe(true);
    expect(isDeltaSyncBackedQueryKey(["powerhub", "schedules", "list", { siteId: 7 }])).toBe(false);
    expect(isDeltaSyncBackedQueryKey(["powerhub", "payments", "list", { siteId: 7 }])).toBe(false);
    expect(isDeltaSyncBackedQueryKey(["powerhub", "subscribers", "getById", { siteId: 7, id: 1 }])).toBe(false);
  });
});


describe("offline query cache persistence failure policy", () => {
  let transactionOutcome: "commit" | "abort" = "commit";
  let putCount = 0;

  afterEach(() => {
    vi.unstubAllGlobals();
    transactionOutcome = "commit";
    putCount = 0;
  });

  function installIndexedDbMock() {
    const database = {
      objectStoreNames: { contains: (_name: string) => false },
      createObjectStore: vi.fn(),
      close: vi.fn(),
      transaction: vi.fn((_storeName: string, _mode: IDBTransactionMode) => {
        const transaction: Record<string, unknown> = {
          objectStore: () => ({
            put: vi.fn(() => {
              putCount += 1;
              const request: Record<string, unknown> = {};
              queueMicrotask(() => {
                (request.onsuccess as (() => void) | undefined)?.();
                // Simulate the subtle IndexedDB case where the request succeeds,
                // but the enclosing transaction later aborts.
                queueMicrotask(() => {
                  if (transactionOutcome === "commit") {
                    (transaction.oncomplete as (() => void) | undefined)?.();
                  } else {
                    (transaction.onabort as (() => void) | undefined)?.();
                  }
                });
              });
              return request;
            }),
          }),
        };
        return transaction;
      }),
    };

    const indexedDb = {
      open: vi.fn(() => {
        const request: Record<string, unknown> = { result: database };
        queueMicrotask(() => {
          (request.onupgradeneeded as (() => void) | undefined)?.();
          (request.onsuccess as (() => void) | undefined)?.();
        });
        return request;
      }),
    };
    vi.stubGlobal("indexedDB", indexedDb as unknown as IDBFactory);
  }

  const successfulQuery = {
    queryKey: ["powerhub", "subscribers", "list", { siteId: 7 }],
    state: {
      status: "success",
      data: [{ id: 11, tenantId: 1, siteId: 7, name: "Subscriber" }],
      dataUpdatedAt: 1_000,
    },
  };

  it("keeps ordinary query-cache persistence best-effort after an IndexedDB transaction abort", async () => {
    installIndexedDbMock();
    transactionOutcome = "abort";

    await expect(persistOfflineQuery(successfulQuery as never, "user-1", 1_000)).resolves.toBeUndefined();
    expect(putCount).toBe(1);
  });

  it("requires the transaction to commit before treating a Delta snapshot as durable", async () => {
    installIndexedDbMock();
    transactionOutcome = "abort";

    await expect(persistOfflineQueryForDeltaSync(successfulQuery as never, "user-1", 1_000))
      .rejects.toThrow(/حفظ نسخة الكاش المطلوبة قبل تثبيت مؤشر Delta/);
    expect(putCount).toBe(1);
  });

  it("resolves required Delta persistence only after IndexedDB transaction completion", async () => {
    installIndexedDbMock();
    transactionOutcome = "commit";

    await expect(persistOfflineQueryForDeltaSync(successfulQuery as never, "user-1", 1_000)).resolves.toBeUndefined();
    expect(putCount).toBe(1);
  });
});
