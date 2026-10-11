import { describe, expect, it } from "vitest";
import { prepareBulkReadings } from "./bulk-reading-import";

describe("prepareBulkReadings", () => {
  const subscribers = [{ id: 5, subscriberNo: "PH-01", fullName: "أحمد" }];
  const readings = [{ reading: { subscriberId: 5, readingValue: "120", readingAt: new Date("2026-08-01"), status: "approved" } }];
  it("يربط الصف الصحيح بالمشترك ويحسب الاستهلاك", () => {
    expect(prepareBulkReadings([{ reference: "PH-01", readingValue: "140", readingDate: "2026-08-05" }], subscribers, readings)[0]).toMatchObject({ status: "ready", subscriberId: 5, consumption: 20 });
  });
  it("يقبل حتى منزلتين عشريتين ويرفض ثلاث منازل قبل إرسال الطلب للخادم", () => {
    // The approved previous reading is 120, so keep these precision cases above that baseline.
    const rows = ["121", "121.5", "121.52", "121.523"].map((readingValue) => ({
      reference: "PH-01", readingValue, readingDate: "2026-08-05",
    }));
    expect(rows.slice(0, 3).map((row) => prepareBulkReadings([row], subscribers, readings)[0].status))
      .toEqual(["ready", "ready", "ready"]);
    expect(prepareBulkReadings([rows[3]], subscribers, readings)[0]).toMatchObject({
      status: "error",
      error: expect.stringContaining("منزلتين عشريتين"),
    });
  });

  it("يمنع المرجع غير المعروف أو القراءة الأقل من السابقة", () => {
    expect(prepareBulkReadings([{ reference: "X", readingValue: "140", readingDate: "2026-08-05" }, { reference: "PH-01", readingValue: "100", readingDate: "2026-08-05" }], subscribers, readings).map((row) => row.status)).toEqual(["error", "error"]);
  });
});
