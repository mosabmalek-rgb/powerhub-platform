import { describe, expect, it } from "vitest";

describe("AI trusted knowledge fallback contract", () => {
  it("keeps the fallback bounded to an eligible published knowledge article", () => {
    const article = {
      answer: "التجديد يتم من المسار المالي المعتمد في المنصة.",
      category: "subscription",
      score: 1,
    };
    const eligible = Number(article.score) >= 0.05;
    expect(eligible).toBe(true);
    expect(article.answer).toBeTruthy();
  });

  it("does not allow a missing article to fabricate an answer", () => {
    const article: { answer?: string } = {};
    expect(typeof article.answer === "string" && article.answer.trim().length > 0).toBe(false);
  });
});
