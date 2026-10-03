import { describe, expect, it } from "vitest";
import { evaluateAiPolicy, isSensitiveMutationRequest, selectSafeArticles, shouldLoadAccountContext } from "./ai-support-policy";

describe("PowerHub AI policy", () => {
  it("detects sensitive mutations before the model", () => {
    expect(isSensitiveMutationRequest("أريد اعتماد الدفع")).toBe(true);
    expect(isSensitiveMutationRequest("كيف أضيف مشتركًا؟")).toBe(false);
  });

  it("filters low-confidence retrieval results", () => {
    const articles = [{ id: 1, score: 0.2 }, { id: 2, score: 0.03 }];
    expect(selectSafeArticles(articles, 0.05)).toEqual([{ id: 1, score: 0.2 }]);
  });

  it("hands off instead of guessing when knowledge is insufficient", () => {
    const result = evaluateAiPolicy("ما هي ميزة غير موجودة؟", [], 0.05);
    expect(result.decision).toBe("handoff");
    expect(result.reason).toContain("مصادر موثوقة");
  });

  it("hands off sensitive mutations without invoking AI", () => {
    const result = evaluateAiPolicy("غيّر صلاحيات المستخدم", [{ id: 1, score: 0.9 }], 0.05);
    expect(result.decision).toBe("handoff");
  });

  it("only loads account context when the question needs it", () => {
    expect(shouldLoadAccountContext("ما هي PowerHub؟", [{ related_operation: "general" }])).toBe(false);
    expect(shouldLoadAccountContext("متى ينتهي اشتراكي؟", [])).toBe(true);
  });
});
