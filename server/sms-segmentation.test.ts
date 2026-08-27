import { describe, expect, it } from "vitest";
import { ARABIC_SMS_CONCATENATED_SEGMENT_LIMIT, ARABIC_SMS_SINGLE_SEGMENT_LIMIT, segmentArabicSms } from "./sms-segmentation";

describe("تجزئة الرسائل العربية", () => {
  it("لا يحتسب نصاً فارغاً كرسالة", () => {
    expect(segmentArabicSms("")).toEqual({ characterCount: 0, segmentCount: 0, segments: [], isConcatenated: false });
  });

  it("يحتسب حتى 70 حرفاً كرسالة واحدة", () => {
    const result = segmentArabicSms("أ".repeat(ARABIC_SMS_SINGLE_SEGMENT_LIMIT));
    expect(result.characterCount).toBe(70);
    expect(result.segmentCount).toBe(1);
    expect(result.segments).toEqual(["أ".repeat(70)]);
  });

  it("يجزئ النص العربي الأطول إلى أجزاء متسلسلة من 67 حرفاً", () => {
    const text = "ب".repeat(ARABIC_SMS_SINGLE_SEGMENT_LIMIT + 1);
    const result = segmentArabicSms(text);
    expect(result).toMatchObject({ characterCount: 71, segmentCount: 2, isConcatenated: true });
    expect(result.segments[0]).toHaveLength(ARABIC_SMS_CONCATENATED_SEGMENT_LIMIT);
    expect(result.segments.join("")).toBe(text);
  });

  it("لا يكسر رمز Unicode المركب إلى نصفين أثناء العد", () => {
    const text = "⚡".repeat(71);
    const result = segmentArabicSms(text);
    expect(result.characterCount).toBe(71);
    expect(result.segments.join("")).toBe(text);
  });
});
