export type BulkReadingDraft = { reference: string; readingValue: string; readingDate: string; notes?: string; clientOperationId?: string };
export type BulkReadingPrepared = BulkReadingDraft & { subscriberId?: number; subscriberName?: string; previousValue?: number; consumption?: number; status: "ready" | "error"; error?: string };

type SubscriberDirectory = { id: number; subscriberNo: string; fullName: string };
type ReadingHistory = { reading: { subscriberId: number; readingValue: string; readingAt: Date; status: string } };

export function prepareBulkReadings(rows: BulkReadingDraft[], subscribers: SubscriberDirectory[], readings: ReadingHistory[]): BulkReadingPrepared[] {
  const latestBySubscriber = new Map<number, number>();
  readings.filter((row) => row.reading.status === "approved").sort((a, b) => +new Date(b.reading.readingAt) - +new Date(a.reading.readingAt)).forEach((row) => {
    if (!latestBySubscriber.has(row.reading.subscriberId)) latestBySubscriber.set(row.reading.subscriberId, Number(row.reading.readingValue));
  });
  return rows.map((row) => {
    const reference = row.reference.trim();
    const subscriber = subscribers.find((entry) => entry.subscriberNo.toLowerCase() === reference.toLowerCase());
    if (!subscriber) return { ...row, status: "error", error: "الرقم المرجعي غير موجود ضمن الفرع الحالي." };
    if (!/^\d+(\.\d{1,3})?$/.test(row.readingValue.trim())) return { ...row, status: "error", error: "القراءة الحالية غير صالحة." };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(row.readingDate)) return { ...row, status: "error", error: "استخدم تاريخاً بصيغة سنة-شهر-يوم." };
    const previousValue = latestBySubscriber.get(subscriber.id) ?? 0;
    const currentValue = Number(row.readingValue);
    if (currentValue < previousValue) return { ...row, subscriberId: subscriber.id, subscriberName: subscriber.fullName, previousValue, status: "error", error: "القراءة أقل من القراءة السابقة؛ سجّلها فردياً كإعادة ضبط لسجل القراءة." };
    return { ...row, subscriberId: subscriber.id, subscriberName: subscriber.fullName, previousValue, consumption: currentValue - previousValue, status: "ready" };
  });
}
