import { describe, expect, it } from "vitest";
import { isOfflineCacheableQueryKey, offlineQueryCacheKey } from "./offline-query-cache";

describe("offline query cache policy", () => {
  it("caches tenant-scoped operational PowerHub queries", () => {
    expect(isOfflineCacheableQueryKey(["powerhub", "subscribers", "list", { siteId: 7 }])).toBe(true);
    expect(isOfflineCacheableQueryKey(["powerhub", "readings", "list", { siteId: 7 }])).toBe(true);
    expect(isOfflineCacheableQueryKey(["powerhub", "sites", "list"])).toBe(true);
  });

  it("does not cache financial, admin, audit, or auth queries", () => {
    expect(isOfflineCacheableQueryKey(["powerhub", "payments", "list", { siteId: 7 }])).toBe(false);
    expect(isOfflineCacheableQueryKey(["powerhub", "admin", "tenants"])).toBe(false);
    expect(isOfflineCacheableQueryKey(["auth", "me"])).toBe(false);
    expect(isOfflineCacheableQueryKey(["powerhub", "audit", "list", { siteId: 7 }])).toBe(false);
  });

  it("serializes equivalent query keys deterministically", () => {
    const key = ["powerhub", "subscribers", "list", { siteId: 7 }];
    expect(offlineQueryCacheKey(key)).toBe(offlineQueryCacheKey(key));
  });
});
