import { createHash, timingSafeEqual } from "node:crypto";

export const FINANCIAL_OPENING_MAX_DOCUMENT_BYTES = 5 * 1024 * 1024;
export const FINANCIAL_OPENING_MIME_EXTENSIONS = {
  "application/pdf": "pdf",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
} as const;
export type FinancialOpeningMime = keyof typeof FINANCIAL_OPENING_MIME_EXTENSIONS;

export function isFinancialOpeningMime(value: string): value is FinancialOpeningMime {
  return Object.prototype.hasOwnProperty.call(FINANCIAL_OPENING_MIME_EXTENSIONS, value);
}

export class InvalidFinancialOpeningDocument extends Error {}

export function openingDocumentDetails(bytes: Buffer, mime: string) {
  if (!isFinancialOpeningMime(mime) || bytes.length === 0 ||
    bytes.length > FINANCIAL_OPENING_MAX_DOCUMENT_BYTES) {
    throw new InvalidFinancialOpeningDocument("OPENING_DOCUMENT_TYPE_OR_SIZE_INVALID");
  }
  const valid = mime === "application/pdf"
    ? bytes.subarray(0, 5).toString("ascii") === "%PDF-"
    : mime === "image/jpeg"
      ? bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
      : mime === "image/png"
        ? bytes.length >= 8 && bytes.subarray(0, 8).equals(
          Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
        : bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF"
          && bytes.toString("ascii", 8, 12) === "WEBP";
  if (!valid) {
    throw new InvalidFinancialOpeningDocument("OPENING_DOCUMENT_CONTENT_INVALID");
  }
  return { byteSize: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex") };
}

export function parseOpeningDocumentBase64(value: string, mime: string) {
  if (typeof value !== "string" || value.length > 7_000_000 ||
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new InvalidFinancialOpeningDocument("OPENING_DOCUMENT_BASE64_INVALID");
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) {
    throw new InvalidFinancialOpeningDocument("OPENING_DOCUMENT_BASE64_INVALID");
  }
  return { bytes, ...openingDocumentDetails(bytes, mime) };
}

export function openingDocumentHashMatches(expected: string, actual: string) {
  return /^[0-9a-f]{64}$/.test(expected) &&
    /^[0-9a-f]{64}$/.test(actual) &&
    timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(actual, "hex"));
}
