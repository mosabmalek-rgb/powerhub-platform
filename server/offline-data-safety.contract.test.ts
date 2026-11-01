import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const read = (file: string) => fs.readFileSync(path.resolve(process.cwd(), file), "utf8");

describe("offline data and financial truth boundaries", () => {
  it("never substitutes the unfiltered latest-100 fuel feed for a filtered historical result", () => {
    const fuel = read("client/src/components/InventoryFuelConsumptionPanel.tsx");
    expect(fuel).toContain("const hasFilteredEventQuery = Boolean(fromDate || toDate || activeReportGeneratorId)");
    expect(fuel).toContain(": !hasFilteredEventQuery ? recentEvents.data ?? [] : []");
    expect(fuel).toContain("const hasFilteredReadingQuery = Boolean(activeReportGeneratorId)");
    expect(fuel).toContain(": !hasFilteredReadingQuery ? recentReadings.data ?? [] : []");
    expect(fuel).toContain("أحدث 100 نتيجة مطابقة للفلاتر الحالية فقط");
    expect(fuel).toContain("آخر 100 تعبئة للفرع دون فلاتر؛ لا تمثل كامل التاريخ");
    expect(fuel).toContain("أحدث 100 قراءة مطابقة للمولد المحدد فقط");
    expect(fuel).toContain("آخر 100 قراءة للفرع دون فلتر مولد؛ لا تمثل كامل التاريخ");
    expect(fuel).toContain("const recentEvents = trpc.powerhub.inventory.listFuelEvents.useQuery");
    expect(fuel).toContain("const recentReadings = trpc.powerhub.inventory.listFuelReadings.useQuery");
    ���q�^