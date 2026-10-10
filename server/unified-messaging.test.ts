import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { renderInvoiceMessageTemplate } from "./invoice-message-template";

const messagingRouterSource = fs.readFileSync(new URL("./powerhub-unified-messaging.ts", import.meta.url), "utf8");

const sendType = z.enum(["manual","automatic","scheduled"]);
const scheduleType = z.enum(["none","one_time","weekly","every_10_days","every_15_days","monthly","custom"]);

describe("unified messaging contract", () => {
  it("fails closed when campaign recipient queries fail", () => {
    expect(messagingRouterSource).toContain('if(ids.error) throw new TRPCError');
    expect(messagingRouterSource).toContain('if(rows.error) throw new TRPCError');
    expect(messagingRouterSource).toContain('if(failed.error) throw new TRPCError');
    expect(messagingRouterSource).toContain('if(!finalRow) throw new TRPCError');
  });
  it("accounts for persisted review states and adds only outcomes whose review state failed to persist", () => {
    expect(messagingRouterSource).toContain("effectiveNeedsReviewCount(finalRow?.needs_review, result.results)");
    expect(messagingRouterSource).toContain("effectiveNeedsReviewCount(finalRow.needs_review, result.results)");
    expect(messagingRouterSource).toContain("reviewPersistenceFailed");
  });
  it("restores the non-persisted review count from the audit record when replaying a manual campaign", () => {
    expect(messagingRouterSource).toContain('eq("action", "send_manual").order("created_at", { ascending: false }).limit(1).maybeSingle()');
    expect(messagingRouterSource).toContain("reviewPersistenceFailed,results:[],replayed:true");
  });
  it("distinguishes unknown review persistence from confirmed unpersisted states", () => {
    expect(messagingRouterSource).toContain("effectiveNeedsReviewCount(finalRow?.needs_review, result.results)");
    expect(messagingRouterSource).toContain("effectiveNeedsReviewCount(finalRow.needs_review, result.results)");
    expect(messagingRouterSource).toContain("countUnconfirmedNeedsReviewPersistence(result.results)");
  });
  it("renders subscriber and portal tokens independently", () => {
    const message = renderInvoiceMessageTemplate("{{subscriber_no}} {{portal_link}}", {
      subscriber_name: "أحمد", subscriber_no: "SUB-1", invoice_no: "INV-1", billing_period: "سبتمبر",
      total_amount: "100", due_date: "10 أكتوبر", invoice_link: "https://powerhub.example/i/token",
      portal_link: "https://powerhub.example/portal?g=1",
    });
    expect(message).toBe("SUB-1 https://powerhub.example/portal?g=1");
  });
  it("supports the three delivery modes", () => {
    expect(sendType.options).toEqual(["manual","automatic","scheduled"]);
  });
  it("supports one-time and recurring schedules", () => {
    expect(scheduleType.options).toEqual(["none","one_time","weekly","every_10_days","every_15_days","monthly","custom"]);
  });
  it("does not accept an unsupported delivery mode", () => {
    expect(() => sendType.parse("instant")).toThrow();
  });
  it("renders stable invoice tokens to their final values", () => {
    const message = renderInvoiceMessageTemplate("مرحباً {{subscriber_name}}، فاتورتك {{invoice_no}} بقيمة {{total_amount}}. {{invoice_link}}", {
      subscriber_name: "أحمد", invoice_no: "INV-1", billing_period: "سبتمبر", total_amount: "100", due_date: "10 أكتوبر",
      invoice_link: "https://powerhub.example/i/token", portal_link: "https://powerhub.example/portal?g=1", subscriber_no: "SUB-1",
    });
    expect(message).toContain("أحمد");
    expect(message).toContain("INV-1");
    expect(message).toContain("https://powerhub.example/i/token");
    expect(message).not.toContain("{{subscriber_name}}");
    expect(message).not.toContain("{{invoice_link}}");
  });
});
