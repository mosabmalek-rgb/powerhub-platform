import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const clientRoot = path.resolve(import.meta.dirname, "../client/src");

const retiredClientProcedures = [
  "trpc.powerhub.messaging.saveConfiguration.useMutation",
  "trpc.powerhub.messaging.testConnection.useMutation",
  "trpc.powerhub.messaging.configureInvoiceAutoSend.useMutation",
  "trpc.powerhub.notifications.retry.useMutation",
  "trpc.powerhub.notifications.retryFailedInvoiceNotification.useMutation",
  "trpc.powerhub.notifications.retryFailedInvoiceNotifications.useMutation",
  "trpc.powerhub.notifications.retryPaymentReceipt.useMutation",
  "trpc.powerhub.notifications.sendDeferredInvoices.useMutation",
  "trpc.powerhub.notifications.sendBulkInvoiceSms.useMutation",
  "trpc.powerhub.notifications.sendPaymentReminder.useMutation",
  "trpc.powerhub.notifications.sendPaymentReceipt.useMutation",
  "trpc.admin.createGeneratorOwnerWithTemporaryPassword.useMutation",
  "trpc.admin.savePlatformSmsFallbackProvider.useMutation",
] as const;

function listRuntimeSourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...listRuntimeSourceFiles(fullPath));
      continue;
    }
    if (!entry.isFile() || !/\.(ts|tsx)$/.test(entry.name) || /\.(test|spec)\.(ts|tsx)$/.test(entry.name)) continue;
    files.push(fullPath);
  }
  return files;
}

describe("client visible procedure contracts", () => {
  it("does not ship retired server procedures in runtime UI code", () => {
    const violations: string[] = [];

    for (const file of listRuntimeSourceFiles(clientRoot)) {
      const source = fs.readFileSync(file, "utf8");
      for (const procedure of retiredClientProcedures) {
        if (source.includes(procedure)) {
          violations.push(`${path.relative(process.cwd(), file)} -> ${procedure}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
