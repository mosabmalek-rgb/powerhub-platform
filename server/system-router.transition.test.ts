import { describe, expect, it } from "vitest";

import { systemRouter } from "./_core/systemRouter";

describe("حماية انتقالية لمسارات النظام", () => {
  it("يعطّل إشعار المالك قبل استدعاء أي خدمة إشعارات خارجية", async () => {
    const caller = systemRouter.createCaller({ user: { id: 1, role: "admin" } as never, req: {} as never, res: {} as never });
    await expect(caller.notifyOwner({ title: "تنبيه", content: "اختبار الحماية" })).rejects.toThrow("PRECONDITION_FAILED");
  });
});
