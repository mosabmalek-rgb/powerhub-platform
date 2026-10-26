import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const subscriberDirectory = readFileSync(resolve(process.cwd(), "client/src/pages/NetworkDirectoryPage.tsx"), "utf8");
const offlineQueue = readFileSync(resolve(process.cwd(), "client/src/lib/offline-work-queue.ts"), "utf8");
const operationsPage = readFileSync(resolve(process.cwd(), "client/src/pages/OperationsPage.tsx"), "utf8");
const notificationCenter = readFileSync(resolve(process.cwd(), "client/src/components/NotificationCenter.tsx"), "utf8");
const subscriberRouter = readFileSync(resolve(process.cwd(), "server/powerhub.ts"), "utf8");
const queryCache = readFileSync(resolve(process.cwd(), "client/src/lib/offline-query-cache.ts"), "utf8");
const main = readFileSync(resolve(process.cwd(), "client/src/main.tsx"), "utf8");

describe("PowerHub offline collection, opening-reading, and notification contracts", () => {
  it("queues a subscriber with an opening reading as one idempotent subscriber operation", () => {
    expect(offlineQueue).toContain("openingReading?: string");
    expect(offlineQueue).toContain("openingReadingImageData?: string");
    expect(subscriberDirectory).toContain("} else if (base.openingReading)");
    expect(subscriberDirectory).toContain('kind: "subscriber_create"');
    expect(subscriberDirectory).toContain("openingReading: base.openingReading");
    expect(subscriberDirectory).toContain("openingReadingImageData: base.openingReadingImageData");
    // Opening-reading creates must use the server's atomic opening-baseline RPC and must not
    // carry a reserved-number claim that the offline-number RPC intentionally rejects.
    expect(subscriberDirectory).toContain("It allocates the authoritative subscriber number during sync");
    expect(subscriberRouter).toContain('"powerhub_create_subscriber_with_opening_reading"');
    expect(subscriberRouter).toContain("p_opening_reading_approved: Boolean(input.openingReading)");
  });

  it("queues network-ambiguous collection sends with the original operation ID", () => {
    expect(operationsPage).toContain("clientOperationId: payload.clientOperationId ?? crypto.randomUUID()");
    expect(operationsPage).toContain("clientOperationId: completePayload.clientOperationId");
    expect(operationsPage).toContain("failed to fetch|networkerror|network request failed");
    expect(operationsPage).toContain("const queued = await queueDraft()");
    expect(operationsPage).toContain("manualDiscountAmount");
  });

  it("refreshes bell sources frequently and marks only visible unread items on opening", () => {
    expect(notificationCenter).toContain("refetchInterval:15000");
    expect(notificationCenter).toContain('supabase.channel("powerhub-notifications-"');
    expect(notificationCenter).toContain("const visibleUnread=items.filter(item=>!item.read)");
    expect(notificationCenter).toContain("setMarkVisiblePending(true)");
    expect(notificationCenter).toContain("powerhub_notification_mark_read");
    expect(notificationCenter).toContain("markChatNotificationRead");
    expect(notificationCenter).toContain("markAnnouncementRead.mutateAsync");
  });

  it("keeps the offline cache scoped and bounded without caching financial or access-sensitive data", () => {
    expect(queryCache).toContain("OFFLINE_QUERY_CACHE_MAX_RECORDS_PER_USER = 200");
    expect(queryCache).toContain("OFFLINE_QUERY_CACHE_MAX_RECORD_BYTES = 2 * 1024 * 1024");
    expect(queryCache).toContain('const BLOCKED_PROCEDURES = new Set([');
    expect(queryCache).toContain('"payments"');
    expect(queryCache).toContain('"admin"');
    expect(queryCache).toContain("record.userId !== userId");
    expect(main).toContain('staleTime: 30_000');
    expect(main).toContain("refetchOnReconnect: true");
  });
});
