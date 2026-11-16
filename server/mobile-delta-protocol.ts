import crypto from "node:crypto";

export type MobileDeltaMode = "bootstrap" | "delta";
export type MobileDeltaCursor = {
  v: 1;
  mode: MobileDeltaMode;
  tenantId: number;
  userId: number;
  sessionId: number;
  branchId: number;
  scopeVersion: string;
  highwater: number;
  after: number;
  ceiling: number;
  issuedAt: number;
};

export class MobileCursorError extends Error {
  constructor(public readonly code: "CURSOR_INVALID" | "CURSOR_SCOPE_CHANGED" | "CURSOR_EXPIRED") {
    super(code);
  }
}

const MAX_CURSOR_AGE_MS = 30 * 24 * 3600 * 1000;
const secret = () => {
  const value = process.env.JWT_SECRET;
  if (!value || value.length < 32) throw new Error("Mobile cursor signing is not configured");
  return crypto.createHmac("sha256", value).update("powerhub/mobile/subscribers/delta/v1").digest();
};
const isInt = (value: unknown): value is number => typeof value === "number"
  && Number.isSafeInteger(value) && value >= 0;
const mac = (payload: string) => crypto.createHmac("sha256", secret()).update(payload).digest("base64url");

export function encodeMobileDeltaCursor(input: MobileDeltaCursor): string {
  const payload = Buffer.from(JSON.stringify(input), "utf8").toString("base64url");
  return `${payload}.${mac(payload)}`;
}

export function decodeMobileDeltaCursor(
  value: string,
  scope: Pick<MobileDeltaCursor, "tenantId" | "userId" | "branchId" | "sessionId" | "scopeVersion">,
  now = Date.now(),
): MobileDeltaCursor {
  if (value.length > 2048 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value)) {
    throw new MobileCursorError("CURSOR_INVALID");
  }
  const [encoded, signature] = value.split(".");
  const expected = Buffer.from(mac(encoded), "base64url");
  const actual = Buffer.from(signature, "base64url");
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
    throw new MobileCursorError("CURSOR_INVALID");
  }
  let data: unknown;
  try { data = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")); }
  catch { throw new MobileCursorError("CURSOR_INVALID"); }
  if (!data || typeof data !== "object") throw new MobileCursorError("CURSOR_INVALID");
  const c = data as Record<string, unknown>;
  if (c.v !== 1 || (c.mode !== "delta" && c.mode !== "bootstrap")
    || ![c.tenantId, c.userId, c.branchId, c.sessionId, c.highwater,
      c.after, c.ceiling, c.issuedAt].every(isInt)
    || typeof c.scopeVersion !== "string" || c.scopeVersion.length !== 64
    || (c.mode === "delta" && c.after > c.highwater)
    || (c.mode === "bootstrap" && c.after > c.ceiling)
    || (c.issuedAt as number) > now + 60_000) throw new MobileCursorError("CURSOR_INVALID");
  if (now - (c.issuedAt as number) > MAX_CURSOR_AGE_MS) throw new MobileCursorError("CURSOR_EXPIRED");
  if (c.tenantId !== scope.tenantId || c.userId !== scope.userId
    || c.branchId !== scope.branchId || c.sessionId !== scope.sessionId
    || c.scopeVersion !== scope.scopeVersion) {
    throw new MobileCursorError("CURSOR_SCOPE_CHANGED");
  }
  return c as MobileDeltaCursor;
}

export function mobileDeltaScopeVersion(input: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

export function nextMobileDeltaCursor(
  previous: MobileDeltaCursor,
  newAfter: number,
  hasMore: boolean,
): MobileDeltaCursor {
  if (!isInt(newAfter) || newAfter < previous.after
    || newAfter > (previous.mode === "bootstrap" ? previous.ceiling : previous.highwater)) {
    throw new MobileCursorError("CURSOR_INVALID");
  }
  return {
    ...previous,
    mode: previous.mode === "bootstrap" && !hasMore ? "delta" : previous.mode,
    after: previous.mode === "bootstrap" && !hasMore ? previous.highwater : newAfter,
    ceiling: previous.mode === "bootstrap" && !hasMore ? 0 : previous.ceiling,
  };
}
