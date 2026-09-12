import { describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  getDb: vi.fn(async () => { throw new Error("MySQL must not be called"); }),
}));

vi.mock("./db", () => ({ getDb: state.getDb, syncSupabaseUser: vi.fn() }));

import { adminRouter } from "./admin";

const adminCaller = adminRouter.createCaller({
  user: { id: 1, role: "admin", platformRole: "platform_admin" } as never,
  req: {} as never,
  res: {} as never,
});

describe("حراس الكتابات الإدارية الموروثة", () => {
  it("يوقف المسارات التي ما زالت موروثة قبل أي وصول MySQL", async () => {
    const guardedWrites: Array<Promise<unknown>> = [
      adminCaller.createGeneratorOwner({
        tenantName: "مولدات الاختبار",
        slug: "test-generator",
        ownerName: "مالك الاختبار",
        ownerPhone: "0590000000",
        siteName: "الفرع الرئيسي",
        siteCode: "HQ",
        generatorName: "مولد الاختبار",
        generatorCode: "GEN-1",
        generatorCapacityKw: 100,
      }),
      adminCaller.createGeneratorOwnerWithTemporaryPassword({
        tenantName: "مولدات الاختبار",
        slug: "test-generator",
        ownerName: "مالك الاختبار",
        ownerPhone: "0590000000",
        ownerWhatsapp: "0590000000",
        ownerEmail: "owner@example.test",
        identityNumber: "123456789",
        generatorName: "مولد الاختبار",
        generatorCode: "GEN-1",
        generatorCapacityKw: 100,
        temporaryPassword: "Temporary-1234",
        siteName: "الفرع الرئيسي",
        siteCode: "HQ",
      }),
      adminCaller.updateComplaint({
        id: 1,
        status: "resolved",
        response: "تمت المعالجة",
      }),
    ];

    for (const operation of guardedWrites) {
      await expect(operation).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    }

    expect(state.getDb).not.toHaveBeenCalled();
  });
});
