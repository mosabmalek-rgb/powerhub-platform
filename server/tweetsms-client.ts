export type TweetSmsCredentials = {
  apiKey: string;
  apiSecret?: string;
};

export type TweetSmsResult = {
  ok: boolean;
  code: number | null;
  message: string;
  providerMessageId?: string;
  balance?: number;
  deliveryUncertain?: boolean;
};

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const statusMessages: Record<number, string> = {
  999: "تم تنفيذ طلب TweetSMS بنجاح.",
  [-100]: "يرفض TweetSMS الطلب لوجود بيانات مطلوبة ناقصة.",
  [-110]: "مفتاح TweetSMS غير صحيح.",
  [-111]: "حساب TweetSMS غير مفعّل.",
  [-112]: "حساب TweetSMS محظور.",
  [-114]: "الإرسال موقوف من حساب TweetSMS.",
  [-115]: "اسم المرسل غير صالح لدى TweetSMS.",
  [-116]: "اسم المرسل غير موجود لدى TweetSMS.",
  [-117]: "اسم المرسل غير نشط لدى TweetSMS.",
  [-118]: "اسم المرسل مرفوض لدى TweetSMS.",
  [-120]: "لم يجد TweetSMS أرقاماً صالحة للإرسال.",
  [-124]: "رصيد TweetSMS غير كافٍ للإرسال.",
  [-126]: "تعذر الإرسال من TweetSMS حالياً؛ أعد المحاولة لاحقاً.",
};

function apiBase(endpoint?: string) {
  const cleaned = (endpoint?.trim() || "https://tweetsms.ps/api.php/maan").replace(/\/+$/, "");
  if (cleaned.endsWith("/sendsms")) return cleaned.slice(0, -"/sendsms".length);
  return cleaned.endsWith("/api.php/maan") ? cleaned : `${cleaned}/api.php/maan`;
}

function readCode(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) return Number(value.trim());
  return null;
}

function extractResult(text: string, body: unknown): { code: number | null; detail: string; providerMessageId?: string; balance?: number } {
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const record = body as Record<string, unknown>;
    const code = readCode(record.code) ?? readCode(record.status) ?? readCode(record.result) ?? readCode(record.response_code);
    const detailValue = record.message ?? record.msg ?? record.error ?? record.description;
    const idValue = record.message_id ?? record.messageId ?? record.id ?? record.transaction_id;
    const balanceValue = record.balance ?? record.credit ?? record.current_balance;
    return {
      code,
      detail: typeof detailValue === "string" ? detailValue : text,
      providerMessageId: typeof idValue === "string" || typeof idValue === "number" ? String(idValue) : undefined,
      balance: typeof balanceValue === "number" ? balanceValue : typeof balanceValue === "string" && !Number.isNaN(Number(balanceValue)) ? Number(balanceValue) : undefined,
    };
  }
  const match = text.match(/(?:^|[^\d-])(-?\d{3})(?:[^\d]|$)/);
  return { code: match ? Number(match[1]) : null, detail: text };
}

async function request(endpoint: string | undefined, path: string, credentials: TweetSmsCredentials, fields: Record<string, string | undefined>, fetcher: FetchLike = fetch, deliveryUncertainOnError = false): Promise<TweetSmsResult> {
  const form = new URLSearchParams({ api_key: credentials.apiKey });
  for (const [key, value] of Object.entries(fields)) if (value) form.set(key, value);
  if (credentials.apiSecret && path === "chk_balance") form.set("token", credentials.apiSecret);
  const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded" };
  if (credentials.apiSecret && path === "chk_balance") headers["X-Auth-Token"] = credentials.apiSecret;
  let response: Response;
  try {
    response = await fetcher(`${apiBase(endpoint)}/${path}`, { method: "POST", headers, body: form.toString(), signal: AbortSignal.timeout(15_000) });
  } catch (error) {
    return {
      ok: false,
      code: null,
      message: error instanceof Error ? error.message.slice(0, 1000) : "تعذر تحديد نتيجة الإرسال من مزود TweetSMS.",
      ...(deliveryUncertainOnError ? { deliveryUncertain: true } : {}),
    };
  }
  const text = await response.text();
  let body: unknown = null;
  try { body = text ? JSON.parse(text) : null; } catch { /* TweetSMS may return plain status text. */ }
  const parsed = extractResult(text, body);
  if (!response.ok) return {
    ok: false,
    code: parsed.code,
    message: parsed.detail || `رفض TweetSMS الطلب (${response.status}).`,
    providerMessageId: parsed.providerMessageId,
    balance: parsed.balance,
    ...(deliveryUncertainOnError && response.status >= 500 ? { deliveryUncertain: true } : {}),
  };
  const ok = parsed.code === 999;
  return {
    ok,
    code: parsed.code,
    message: parsed.detail && parsed.detail !== String(parsed.code) ? parsed.detail : parsed.code === null ? "لم يُرجع TweetSMS رمز حالة مفهومًا." : statusMessages[parsed.code] ?? `أعاد TweetSMS الرمز ${parsed.code}.`,
    providerMessageId: parsed.providerMessageId,
    balance: parsed.balance,
  };
}

export async function checkTweetSmsAccount(input: { endpoint?: string; credentials: TweetSmsCredentials }, fetcher?: FetchLike) {
  return request(input.endpoint, "chk_user", input.credentials, {}, fetcher);
}

export async function checkTweetSmsBalance(input: { endpoint?: string; credentials: TweetSmsCredentials }, fetcher?: FetchLike) {
  return request(input.endpoint, "chk_balance", input.credentials, {}, fetcher);
}

export async function checkTweetSmsSender(input: { endpoint?: string; credentials: TweetSmsCredentials; sender: string }, fetcher?: FetchLike) {
  return request(input.endpoint, "senderstatus", input.credentials, { sendertext: input.sender }, fetcher);
}

export async function sendTweetSms(input: { endpoint?: string; credentials: TweetSmsCredentials; sender: string; message: string; recipient: string }, fetcher?: FetchLike) {
  const recipient = input.recipient.replace(/\s+/g, "").replace(/^\+/, "");
  return request(input.endpoint, "sendsms", input.credentials, { sender: input.sender, message: input.message, to: recipient }, fetcher);
}
