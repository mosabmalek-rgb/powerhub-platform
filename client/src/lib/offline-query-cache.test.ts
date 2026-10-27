import { describe, expect, it } from "vitest";
import {
  isOfflineCacheableQueryKey,
  isDeltaSyncBackedQueryKey,
  isOfflineQueryRecordUsable,
  offlineQueryCacheKey,
} from "./offline-query-cache";

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


describe("Delta-backed local snapshots", () => {
  it("only marks supported whole-list procedures as Delta-backed", () => {
    expect(isDeltaSyncBackedQueryKey(["powerhub", "sites", "list"])).toBe(true);
    expect(isDeltaSyncBackedQueryKey(["powerhub", "subscribers", "list", { siteId: 7 }])).toBe(true);
    expect(isDeltaSyncBackedQueryKey(["powerhub", "readings", "list", { siteId: 7 }])).toBe(true);
    expect(isDeltaSyncBackedQueryKey(["powerhub.tariffs.list", { input: { siteId: 7 }, type: "query" }])).toBe(true);
    expect(isDeltaSyncBackedQueryKey(["powerhub", "schedules", "list", { siteId: 7 }])).toBe(false);
    expect(isDeltaSyncBackedQueryKey(["powerhub", "payments", "list", { siteId: 7 }])).toBe(false);
    expect(isDeltaSyncBackedQueryKey(["powerhub", "subscribers", "getById", { siteId: 7, id: 1 }])).toBe(false);
  });
});
