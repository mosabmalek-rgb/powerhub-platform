export type BulkReadingDraft = { reference: string; readingValue: string; readingDate: string; notes?: string };
export type BulkReadingPrepared = BulkReadingDraft & { meterId?: number; subscriberName?: string; previousValue?: number; consumption?: number; status: "ready" | "error"; error?: string };

type MeterDirectory = { meter: { id: number }; subscriber: { subscriberNo: string; fullName: string } };
type ReadingHistory = { reading: { meterId: number; readingValue: string; readingAt: Date; status: string } };

export function prepareBulkReadings(rows: BulkReadingDraft[], meters: MeterDirectory[], readings: ReadingHistory[]): BulkReadingPrepared[] {
  const latestByMeter = new Map<number, number>();
  readings.filter((row) => row.reading.status === "approved").sort((a, b) => +new Date(b.reading.readingAt) - +new Date(a.reading.readingAt)).forEach((row) => {
    if (!latestByMeter.has(row.reading.meterId)) latestByMeter.set(row.reading.meterId, Number(row.reading.readingValue));
  });
  return rows.map((row) => {
    const reference = row.reference.trim();
    const meter = meters.find((entry) => entry.subscriber.subscriberNo.toLowerCase() === reference.toLowerCase());
    if (!meter) return { ...row, status: "error", error: "الرقم المرجعي غير موجود ضمن الفرع الحالي." };
    if (!/^\d+(\.\d{1,3})?$/.test(row.readingValue.trim())) return { ...row, status: "error", error: "القراءة الحالية غير صالحة." };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(row.readingDate)) return { ...row, status: "error", error: "استخدم تاريخاً بصيغة سنة-شهر-يوم." };
    const previousValue = latestByMeter.get(meter.meter.id) ?? 0;
    const currentValue = Number(row.readingValue);
    if (currentValue < previousValue) return { ...row, meterId: meter.meter.id, subscriberName: meter.subscriber.fullName, previousValue, status: "error", error: "القراءة أقل من القراءة السابقة؛ سجّلها فردياً كاستبدال عداد." };
    return { ...row, meterId: meter.meter.id, subscriberName: meter.subscriber.fullName, previousValue, consumption: currentValue - previousValue, status: "ready" };
  });
}
