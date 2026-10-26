type AuthErrorLike = {
  name?: unknown;
  data?: { code?: unknown } | null;
};

function errorName(error: unknown): string {
  return error && typeof error === "object" && typeof (error as AuthErrorLike).name === "string"
    ? (error as AuthErrorLike).name as string
    : "";
}

function errorCode(error: unknown): string {
  const data = error && typeof error === "object" ? (error as AuthErrorLike).data : null;
  return data && typeof data.code === "string" ? data.code : "";
}

/** User-safe diagnostics; never display access tokens or raw server messages. */
export function describeAuthFailure(error: unknown): string {
  const name = errorName(error);
  if (name === "PowerHubSessionTokenUnavailableError") {
    return "المرحلة: لم يتمكن المتصفح من استخراج Access Token صالح من جلسة Supabase؛ لم يُرسل طلب API المحمي.";
  }
  if (name === "PowerHubDeviceIdentityUnavailableError") {
    return "المرحلة: تعذر إنشاء معرّف الجهاز أو التحقق من صيغته؛ لم يُرسل طلب API المحمي.";
  }

  switch (errorCode(error)) {
    case "UNAUTHORIZED":
      return "المرحلة: وصل الطلب إلى الخادم، لكن الجلسة أو رمز الدخول لم يُقبل.";
    case "FORBIDDEN":
      return "المرحلة: رفض الخادم التحقق من جهاز الدخول أو صلاحية الحساب.";
    case "INTERNAL_SERVER_ERROR":
      return "المرحلة: وصل الطلب إلى الخادم، لكن تعذر التحقق من الجلسة أو ملف المستخدم أو خدمة البيانات.";
    default:
      return "المرحلة: تعذر إكمال طلب التحقق بسبب خطأ عميل أو اتصال. أعد المحاولة؛ لم تُمسح بيانات العمل.";
  }
}
