export type AiPolicyDecision = "handoff" | "continue";

export function isSensitiveMutationRequest(question: string): boolean {
  return /(اعتماد|تأكيد|تعديل|حذف|إنشاء|إصدار|تغيير)\s*(الدفع|الفاتورة|الاشتراك|الصلاحيات|المستخدم|الرصيد|الفواتير|الرسائل|sms)|\b(approve|delete|issue|change|update|send\s*sms)\b/i.test(question);
}

export function selectSafeArticles(
  articles: Array<Record<string, unknown>>,
  minScore: number,
) {
  return articles.filter((article) => Number(article.score ?? 0) >= minScore);
}

export function evaluateAiPolicy(
  question: string,
  articles: Array<Record<string, unknown>>,
  minScore: number,
): { decision: AiPolicyDecision; reason: string; articles: Array<Record<string, unknown>> } {
  const eligible = selectSafeArticles(articles, minScore);

  if (isSensitiveMutationRequest(question)) {
    return {
      decision: "handoff",
      reason: "طلب تنفيذ عملية حساسة؛ لا ينفذها المساعد.",
      articles: eligible,
    };
  }

  if (eligible.length === 0) {
    return {
      decision: "handoff",
      reason: "لا توجد مصادر موثوقة كافية للإجابة.",
      articles: eligible,
    };
  }

  return {
    decision: "continue",
    reason: "",
    articles: eligible,
  };
}

export function shouldLoadAccountContext(question: string, articles: Array<Record<string, unknown>>): boolean {
  if (/(اشتراك|باقة|تجديد|ترقية|انتهاء|رصيد|فاتورة|دفع|subscription|renew|upgrade|invoice|payment|balance)/i.test(question)) {
    return true;
  }
  return articles.some((article) =>
    ["subscription_status", "subscription_renewal", "subscription_upgrade", "payment_documentation", "sms_topup"]
      .includes(String(article.related_operation ?? "")),
  );
}
