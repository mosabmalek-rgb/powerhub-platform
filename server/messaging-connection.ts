export type MessagingConnectionInput = {
  channel: "whatsapp" | "sms";
  provider: string;
  credential: string;
  phoneNumberId?: string;
};

export type ConnectionProbeResult = { ok: boolean; mode: "live" | "configuration"; message: string };

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

function providerError(response: Response, body: unknown) {
  if (body && typeof body === "object" && "error" in body) {
    const message = (body as { error?: { message?: string } }).error?.message;
    if (message) return message;
  }
  return `رفض المزود طلب الاختبار (${response.status}).`;
}

export async function probeMessagingConnection(input: MessagingConnectionInput, fetcher: FetchLike = fetch): Promise<ConnectionProbeResult> {
  if (input.channel === "whatsapp") {
    if (input.provider !== "meta_whatsapp_cloud") return { ok: false, mode: "configuration", message: "اختبار WhatsApp الحي متاح حالياً لمزود Meta WhatsApp Cloud فقط." };
    if (!input.phoneNumberId) return { ok: false, mode: "configuration", message: "أدخل Phone Number ID لاختبار اتصال WhatsApp." };
    const response = await fetcher(`https://graph.facebook.com/v22.0/${encodeURIComponent(input.phoneNumberId)}?fields=id,display_phone_number`, {
      headers: { Authorization: `Bearer ${input.credential}` }, signal: AbortSignal.timeout(10_000),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) return { ok: false, mode: "live", message: providerError(response, body) };
    return { ok: true, mode: "live", message: "تم التحقق من Access Token وPhone Number ID لدى Meta بنجاح." };
  }

  if (input.provider === "tweetsms") {
    return { ok: false, mode: "configuration", message: "يتطلب TweetSMS مسار فحص الرصيد أو وثائق API الرسمية لتشغيل اختبار حي. لا تُرسل أي رسالة أثناء فحص الجاهزية." };
  }

  if (input.provider !== "twilio") return { ok: false, mode: "configuration", message: "اختبار SMS الحي متاح حالياً لمزود Twilio. اختر Twilio وأدخل Account SID في حقل المعرّف، أو احفظ الإعداد لحين إضافة موفر SMS آخر." };
  if (!input.phoneNumberId) return { ok: false, mode: "configuration", message: "أدخل Account SID لاختبار اتصال Twilio." };
  const basic = Buffer.from(`${input.phoneNumberId}:${input.credential}`).toString("base64");
  const response = await fetcher(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(input.phoneNumberId)}.json`, {
    headers: { Authorization: `Basic ${basic}` }, signal: AbortSignal.timeout(10_000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) return { ok: false, mode: "live", message: providerError(response, body) };
  return { ok: true, mode: "live", message: "تم التحقق من بيانات Twilio بنجاح." };
}
