export type OwnerSubscriptionRenewalInput = {
  status: string;
  endsAt: string | Date | null;
};

export type SubscriptionRenewalUrgency = "normal" | "notice" | "warning" | "urgent" | "expired" | "blocked";

export type SubscriptionRenewalState = {
  statusLabel: string;
  daysRemaining: number | null;
  urgency: SubscriptionRenewalUrgency;
  notice: string | null;
};

function parseDate(value: string | Date | null | undefined): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatDays(days: number): string {
  if (days === 1) return "يوم واحد";
  if (days === 2) return "يومان";
  if (days >= 3 && days <= 10) return `${days} أيام`;
  return `${days} يومًا`;
}

const statusLabels: Record<string, string> = {
  trial: "فترة تجريبية",
  active: "فعّال",
  overdue: "متأخر",
  suspended: "معلّق",
  cancelled: "ملغي",
  expired: "منتهي",
};

export function getSubscriptionRenewalState(
  subscription: OwnerSubscriptionRenewalInput,
  now = new Date(),
): SubscriptionRenewalState {
  const endsAt = parseDate(subscription.endsAt);
  const isTimedSubscription = subscription.status === "active" || subscription.status === "trial";

  if (subscription.status === "cancelled") {
    return {
      statusLabel: "ملغي",
      daysRemaining: endsAt ? Math.ceil((endsAt.getTime() - now.getTime()) / 86_400_000) : null,
      urgency: "blocked",
      notice: "الاشتراك ملغي. تواصل مع إدارة PowerHub لمعرفة خيارات الاستعادة أو الاشتراك من جديد.",
    };
  }

  if (subscription.status === "suspended") {
    return {
      statusLabel: "معلّق",
      daysRemaining: endsAt ? Math.max(0, Math.ceil((endsAt.getTime() - now.getTime()) / 86_400_000)) : null,
      urgency: "blocked",
      notice: "الاشتراك معلّق. تواصل مع إدارة PowerHub لمعرفة المطلوب لاستعادة الخدمة.",
    };
  }

  if (subscription.status === "overdue") {
    return {
      statusLabel: "متأخر",
      daysRemaining: endsAt ? Math.max(0, Math.ceil((endsAt.getTime() - now.getTime()) / 86_400_000)) : null,
      urgency: "urgent",
      notice: "حالة الاشتراك متأخرة. يرجى التواصل مع إدارة PowerHub لتأكيد حالة التجديد.",
    };
  }

  if (!endsAt) {
    return {
      statusLabel: statusLabels[subscription.status] ?? subscription.status,
      daysRemaining: null,
      urgency: "warning",
      notice: "لا يتوفر تاريخ انتهاء موثوق للاشتراك. تواصل مع إدارة PowerHub لتأكيد الموعد.",
    };
  }

  const diff = endsAt.getTime() - now.getTime();
  if (isTimedSubscription && diff <= 0) {
    return {
      statusLabel: "منتهي",
      daysRemaining: 0,
      urgency: "expired",
      notice: "انتهى اشتراكك. تواصل مع إدارة PowerHub لطلب التجديد واستعادة إتاحة العمليات.",
    };
  }

  const daysRemaining = Math.max(0, Math.ceil(diff / 86_400_000));
  if (daysRemaining <= 1) {
    return { statusLabel: statusLabels[subscription.status] ?? subscription.status, daysRemaining, urgency: "urgent", notice: "تنبيه: ينتهي اشتراكك خلال يوم واحد. تواصل لطلب التجديد قبل انتهاء المدة." };
  }
  if (daysRemaining <= 3) {
    return { statusLabel: statusLabels[subscription.status] ?? subscription.status, daysRemaining, urgency: "urgent", notice: `تنبيه: بقي على انتهاء اشتراكك ${formatDays(daysRemaining)}. نوصي ببدء إجراءات التجديد الآن.` };
  }
  if (daysRemaining <= 7) {
    return { statusLabel: statusLabels[subscription.status] ?? subscription.status, daysRemaining, urgency: "warning", notice: `اقترب موعد انتهاء اشتراكك؛ بقي ${formatDays(daysRemaining)}. تواصل مع الإدارة لتجنب انقطاع الخدمة.` };
  }
  if (daysRemaining <= 14) {
    return { statusLabel: statusLabels[subscription.status] ?? subscription.status, daysRemaining, urgency: "notice", notice: `تذكير: بقي على انتهاء اشتراكك ${formatDays(daysRemaining)}. يمكنك ترتيب التجديد من الآن.` };
  }
  return { statusLabel: statusLabels[subscription.status] ?? subscription.status, daysRemaining, urgency: "normal", notice: null };
}
