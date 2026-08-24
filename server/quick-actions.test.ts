import { describe, expect, it } from "vitest";
import { quickActionCapabilityById, quickActionIds } from "./powerhub";

describe("اختصارات الإجراءات السريعة", () => {
  it("يحصر معرفات الاختصارات في الإجراءات المعتمدة ويحدد الصلاحية المطلوبة لكل منها", () => {
    expect(quickActionIds).toEqual(["add_subscriber", "record_reading", "create_invoice", "collect_payment", "record_expense", "send_notification"]);
    expect(quickActionCapabilityById.collect_payment).toBe("collectPayments");
    expect(quickActionCapabilityById.send_notification).toBe("manageMessaging");
  });
});
