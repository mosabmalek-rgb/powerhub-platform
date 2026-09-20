export const PAYMENT_RECEIPT_IMAGE_MAX_DIMENSION = 1600;
export const PAYMENT_RECEIPT_IMAGE_QUALITY = 0.78;
export const PAYMENT_RECEIPT_IMAGE_MAX_UPLOAD_BYTES = 7 * 1024 * 1024;

export type PreparedPaymentReceiptImage = {
  data: string;
  mime: "image/webp" | "image/jpeg";
  originalBytes: number;
  preparedBytes: number;
  width: number;
  height: number;
};

function readAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("تعذر قراءة صورة الإيصال."));
    reader.onload = () => resolve(String(reader.result));
    reader.readAsDataURL(file);
  });
}

function loadImage(file: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("تعذر فتح صورة الإيصال."));
    };
    image.src = url;
  });
}

function canvasToBlob(canvas: HTMLCanvasElement, mime: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, mime, quality));
}

export async function preparePaymentReceiptImage(file: File): Promise<PreparedPaymentReceiptImage> {
  if (!file.type.startsWith("image/")) throw new Error("الملف المرفق ليس صورة.");
  if (file.size > PAYMENT_RECEIPT_IMAGE_MAX_UPLOAD_BYTES) {
    throw new Error("يجب ألا تتجاوز صورة الإيصال الأصلية 7 ميغابايت.");
  }

  const image = await loadImage(file);
  const longestSide = Math.max(image.naturalWidth, image.naturalHeight);
  const scale = longestSide > PAYMENT_RECEIPT_IMAGE_MAX_DIMENSION
    ? PAYMENT_RECEIPT_IMAGE_MAX_DIMENSION / longestSide
    : 1;
  const width = Math.max(1, Math.round(image.naturalWidth * scale));
  const height = Math.max(1, Math.round(image.naturalHeight * scale));

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("تعذر تجهيز صورة الإيصال.");
  context.drawImage(image, 0, 0, width, height);

  let blob = await canvasToBlob(canvas, "image/webp", PAYMENT_RECEIPT_IMAGE_QUALITY);
  let mime: PreparedPaymentReceiptImage["mime"] = "image/webp";

  if (!blob) {
    blob = await canvasToBlob(canvas, "image/jpeg", PAYMENT_RECEIPT_IMAGE_QUALITY);
    mime = "image/jpeg";
  }
  if (!blob) throw new Error("تعذر ضغط صورة الإيصال.");

  const dataUrl = await readAsDataUrl(blob);
  const data = dataUrl.split(",")[1] ?? "";
  const preparedBytes = blob.size;

  return { data, mime, originalBytes: file.size, preparedBytes, width, height };
}
