import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const read = (file: string) => fs.readFileSync(path.resolve(process.cwd(), file), "utf8");

describe("collection and entry form reset contracts", () => {
  it("keeps collection collapsed by default and searches the already-loaded subscriber list", () => {
    const operations = read("client/src/pages/OperationsPage.tsx");
    expect(operations).toContain('collapsed={!collectionFormOpen}');
    expect(operations).toContain('setCollectionFormOpen((open) => !open)');
    expect(operations).toContain('normalizeSubscriberSearch(subscriberSearch)');
    expect(operations).toContain('subscriber.fullName, subscriber.phone, subscriber.subscriberNo');
    expect(operations).toContain('placeholder="الاسم أو رقم الجوال أو الرقم المرجعي"');
    expect(operations).toContain('onToggleCollapse={() => setCollectionFormOpen((open) => !open)}');
  });

  it("prefills selected invoice balances and only resets collection data after successful completion", () => {
    const operations = read("client/src/pages/OperationsPage.tsx");
    expect(operations).toContain('setCollectionAmount(selectedInvoiceIds.length ? selectedInvoicesDue.toFixed(2) : "")');
    expect(operations).toContain('onClick={() => resetCollectionForm()}');
    expect(operations).toContain('await addPayment.mutateAsync(completePayload)');
    expect(operations).toContain('resetCollectionForm(formElement)');
    expect(operations).toContain('بقيت الفواتير غير المكتملة محددة');
    expect(operations).toContain('لم يُمسح النموذج');
  });

  it("resets the subscriber creation form only after a successful create and offers manual clearing", () => {
    const directory = read("client/src/pages/NetworkDirectoryPage.tsx");
    expect(directory).toContain('setSubscriberFormResetKey((key) => key + 1)');
    expect(directory).toContain('key={`${editing?.id ?? "new"}-${subscriberFormResetKey}`}');
    expect(directory).toContain('onClick={(event) => event.currentTarget.form?.reset()}');
    expect(directory).toContain('إفراغ الحقول');
  });

  it("refreshes invoice pages only after successful invoice creation/sync and scopes cache updates to the active site", () => {
    const operations = read("client/src/pages/OperationsPage.tsx");
    expect(operations).toContain('utils.powerhub.invoices.page.invalidate({ siteId: siteId ?? 0, limit: 100 })');
    expect(operations).toContain('utils.powerhub.invoices.page.invalidate({ siteId: siteId ?? 0, limit: 200 })');

    const meterReadings = read("client/src/pages/MeterReadingsPage.tsx");
    expect(meterReadings).toContain('utils.powerhub.invoices.page.invalidate({ siteId: refreshSiteId, limit: 100 })');
    expect(meterReadings).toContain('utils.powerhub.invoices.page.invalidate({ siteId: refreshSiteId, limit: 200 })');

    const offlineSync = read("client/src/components/OfflineWorkSyncPanel.tsx");
    expect(offlineSync).toContain('const refresh = async (results: readonly { item: QueuedOfflineWork; outcome: string }[]) =>');
    expect(offlineSync).toContain('const successful = results.filter((result) =>');
    expect(offlineSync).toContain('result.outcome === "applied" || result.outcome === "already_applied"');
    expect(offlineSync).toContain('if (kinds.has("invoice_issue"))');
    expect(offlineSync).toContain('utils.powerhub.invoices.page.invalidate({ siteId, limit: 100 })');
    expect(offlineSync).toContain('utils.powerhub.invoices.page.invalidate({ siteId, limit: 200 })');
  });

  it("preserves the two-decimal reading validation and clears the reading form after success", () => {
    const readings = read("client/src/components/ReadingWorkflowPanel.tsx");
    expect(readings).toContain('/^\\d+(\\.\\d{1,2})?$/');
    expect(readings).toContain('const resetReadingForm = () =>');
    expect(readings).toContain('resetReadingForm();');
    expect(readings).toContain('إفراغ الحقول');
  });
});
