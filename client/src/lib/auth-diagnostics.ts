type AuthErrorLike = {
  name?: unknown;
  message?: unknown;
  data?: { code?: unknown } | null;
  cause?: unknown;
};

function findAuthError(error: unknown): AuthErrorLike | null {
  const seen = new Set<unknown>();
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current && typeof current === "object" && !seen.has(current); depth += 1) {
    seen.add(current);
    const candidate = current as AuthErrorLike;
    if (candidate.name === "PowerHubSessionTokenUnavailableError" ||
        candidate.name === "PowerHubSessionReadFailedError" ||
        candidate.name === "PowerHubSupabaseRateLimitError" ||
        candidate.name === "PowerHubSessionReadTimeoutError" ||
        candidate.name === "PowerHubSessionRefreshTimeoutError" ||
        candidate.name === "PowerHubSessionRefreshFailedError" ||
        candidate.name === "PowerHubSessionIdentityChangedError" ||
        candidate.name === "PowerHubAuthProfileCheckTimeoutError" ||
        candidate.name === "PowerHubSessionRecoveryTimeoutError" ||
        candidate.name === "PowerHubSessionRecoveryFailedError" ||
        candidate.name === "PowerHubDeviceIdentityUnavailableError" ||
        (candidate.data && typeof candidate.data.code === "string")) return candidate;
    current = candidate.cause;
  }
  return error && typeof error === "object" ? error as AuthErrorLike : null;
};

function errorName(error: unknown): string {
  const candidate = findAuthError(error);
  return typeof candidate?.name === "string" ? candidate.name : "";
}

function errorCode(error: unknown): string {
  const data = findAuthError(error)?.data;
  return data && typeof data.code === "string" ? data.code : "";
}

/**
 * Search the complete RPC error cause chain for a known server-message pattern.
 * tRPC wrappers may expose a top-level FORBIDDEN code while the actionable
 * server message sits on a nested cause.
 */
function hasServerMessage(error: unknown, pattern: RegExp): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current && typeof current === "object" && !seen.has(current); depth += 1) {
    seen.add(current);
    const message = (current as AuthErrorLike).message;
    if (typeof message === "string" && pattern.test(message)) return true;
    current = (current as AuthErrorLike).cause;
  }
  return false;
}

/** User-safe diagnostics; never display access tokens or raw server messages. */
export function describeAuthFailure(error: unknown): string {
  const name = errorName(error);
  if (name === "PowerHubDeviceClockSkewError") {
    return "ساعة جهازك تختلف بوضوح عن وقت خادم PowerHub. فعّل ضبط الوقت والتاريخ تلقائيًا، وتأكد من المنطقة الزمنية، ثم أعد تحميل الصفحة والمحاولة. لا يعني هذا تسجيل خروج، ولم تُمسح البيانات المحلية أو العمليات المعلقة.";
  }
  if (name === "PowerHubSupabaseRateLimitError") {
    return "المرحلة: حدّ Supabase مؤقتًا من تجديد الجلسة بسبب كثرة الطلبات؛ أوقف التطبيق التكرار ويمكن فتح تسجيل الدخول لإعادة التحقق دون مسح البيانات المحلية.";
  }
  if (name === "PowerHubSessionReadFailedError") {
    return "المرحلة: فشلت قراءة جلسة Supabase أو استعادتها من التخزين/تحديث الرمز؛ لم يُرسل طلب API المحمي. أعد المحاولة، وإذا استمر العطل افتح تسجيل الدخول.";
  }
  if (name === "PowerHubSessionTokenUnavailableError") {
    return "المرحلة: لم يتمكن المتصفح من استخراج Access Token صالح من جلسة Supabase؛ لم يُرسل طلب API المحمي.";
  }
  if (name === "PowerHubSessionReadTimeoutError") {
    return "المرحلة: انتهت مهلة قراءة جلسة Supabase قبل استخراج الرمز؛ قد يكون تخزين الجلسة أو قفل التبويبات عالقًا. أُوقفت المحاولة ويمكن إعادة المحاولة.";
  }
  if (name === "PowerHubSessionRefreshTimeoutError") {
    return "المرحلة: انتظر المتصفح تجديد جلسة Supabase حتى نهاية المهلة، لكن التجديد لم يكتمل؛ لم يُرسل الطلب المحمي برمز منتهي الصلاحية.";
  }
  if (name === "PowerHubSessionRefreshFailedError") {
    return "المرحلة: فشل تجديد جلسة Supabase قبل إرسال الطلب المحمي. لم تُمسح بيانات العمل؛ أعد المحاولة بعد استقرار الاتصال.";
  }
  if (name === "PowerHubSessionIdentityChangedError") {
    return "المرحلة: تغيّرت هوية حساب Supabase أثناء تجهيز الطلب؛ أوقفنا الإرسال لمنع استخدام رمز حساب آخر. أعد المحاولة بعد استقرار الجلسة.";
  }
  if (name === "PowerHubAuthProfileCheckTimeoutError") {
    return "المرحلة: استُخرجت الجلسة، لكن طلب auth.me لم يكتمل خلال المهلة؛ يلزم فحص اتصال API وسجلات الخادم.";
  }
  if (name === "PowerHubSessionRecoveryFailedError") {
    return "المرحلة: اكتملت قراءة جلسة Supabase دون العثور على جلسة صالحة؛ لم يُنفذ تسجيل خروج تلقائي. أعد المحاولة أو افتح تسجيل الدخول.";
  }
  if (name === "PowerHubSessionRecoveryTimeoutError") {
    return "المرحلة: لم تصل جلسة صالحة بعد محاولة استعادة Supabase؛ لم يُنفذ تسجيل خروج تلقائي. أعد المحاولة أو افتح تسجيل الدخول.";
  }
  if (name === "PowerHubDeviceIdentityUnavailableError") {
    return "المرحلة: تعذر إنشاء معرّف الجهاز أو التحقق من صيغته؛ لم يُرسل طلب API المحمي.";
  }

  // A device-lock denial is a specific, actionable server decision. Do not
  // infer it from FORBIDDEN alone: that code also covers ordinary RBAC denial.
  if (hasServerMessage(error, /هذا الحساب مستخدم حاليًا على جهاز آخر|يجب استخدام جهاز PowerHub المسجل لهذا الحساب/)) {
    return "المرحلة: الحساب مقيد بجهاز آخر حاليًا. إذا كنت تستخدم الجهاز نفسه، أعد المحاولة بعد استقرار الاتصال؛ وإذا أردت الانتقال إلى جهاز جديد، سجّل الخروج صراحةً من الجهاز السابق أولًا. لن نمسح الكاش أو العمليات المحلية المعلقة تلقائيًا.";
  }
  if (hasServerMessage(error, /تعذر التحقق من جهاز الدخول|تعذر تثبيت جهاز الدخول|تعذر التحقق من جلسة الجهاز/)) {
    return "المرحلة: تعذر التحقق من هوية جهاز الدخول. لم نعتبر ذلك تسجيل خروج ولم نمسح بيانات العمل؛ أعد المحاولة، وإذا استمر الرفض فافحص إعدادات الجهاز والخادم.";
  }

  switch (errorCode(error)) {
    case "UNAUTHORIZED":
      return "المرحلة: وصل الطلب إلى الخادم، لكن الجلسة أو رمز الدخول لم يُقبل.";
    case "FORBIDDEN":
      return "المرحلة: رفض الخادم صلاحية الحساب أو العملية المطلوبة. هذا ليس دليلًا وحده على وجود قفل جهاز؛ راجع الدور/الفرع أو اطلب من المسؤول التحقق من الصلاحية.";
    case "INTERNAL_SERVER_ERROR":
      return "المرحلة: وصل الطلب إلى الخادم، لكن تعذر التحقق من الجلسة أو ملف المستخدم أو خدمة البيانات.";
    default:
      return "المرحلة: تعذر إكمال طلب التحقق بسبب خطأ عميل أو اتصال. أعد المحاولة؛ لم تُمسح بيانات العمل.";
  }
}
