import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = (file: string) => readFileSync(resolve(process.cwd(), "client/src/pages", file), "utf8");

describe("subscriber number ownership contract", () => {
  it("keeps OperationsPage free of manual subscriber-number creation fields and payloads", () => {
    const operations = source("OperationsPage.tsx");
    expect(operations).not.toContain('name="no"');
    expect(operations).not.toContain("subscriberNo: String(form.get(\"no\"))");
    expect(operations).not.toContain("p_subscriber_no");
  });

  it("keeps NetworkDirectory create payload free of subscriberNo while retaining server result display", () => {
    const directory = source("NetworkDirectoryPage.tsx");
    expect(directory).not.toContain('name="no"');
    expect(directory).not.toContain("subscriberNo: String(form.get(\"no\"))");
    expect(directory).toContain("created.subscriberNo");
  });

  it("does not put subscriberNo into the offline create draft", () => {
    const queue = readFileSync(resolve(process.cwd(), "client/src/lib/offline-work-queue.ts"), "utf8");
    const syncPanel = readFileSync(resolve(process.cwd(), "client/src/components/OfflineWorkSyncPanel.tsx"), "utf8");
    const draft = queue.slice(queue.indexOf("export type SubscriberCreateDraft"), queue.indexOf("export type SubscriberUpdateDraft"));
    expect(draft).not.toContain("subscriberNo");
    expect(syncPanel).toContain("appliedLabel: result.subscriberNo");
  });
});
