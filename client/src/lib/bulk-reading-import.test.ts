import { describe, expect, it } from "vitest";
import { prepareBulkReadings } from "./bulk-reading-import";

describe("prepareBulkReadings", () => {
  const meters = [{ meter: { id: 5 }, subscriber: { subscriberNo: "PH-01", fullName: "أحمد" } }];
  const readings = [{ reading: { meterId: 5, readingValue: "120", readingAt: new Date("2026-08-01"), status: "approved" } }];
  it("يربط الصف الصحيح بالمشترك ويحسب الاستهلاك", () => {
    expect(prepareBulkReadings([{ reference: "PH-01", readingValue: "140", readingDate: "2026-08-05" }], meters, readings)[0]).toMatchObject({ status: "ready", meterId: 5, consumption: 20 });
  });
  it("يمنع المرجع غير المعروف أو القراءة الأقل من السابقة", () => {
    expect(prepareBulkReadings([{ reference: "X", readingValue: "140", readingDate: "2026-08-05" }, { reference: "PH-01", readingValue: "100", readingDate: "2026-08-05" }], meters, readings).map((row) => row.status)).toEqual(["error", "error"]);
  });
});
