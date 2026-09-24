export type NotificationChannel = "sms" | "whatsapp";
export type NotificationStatus = "pending" | "processing" | "submitted" | "delivered" | "read" | "failed" | string;

export function notificationStatusLabel(status: NotificationStatus, channel: NotificationChannel): string {
  if (status === "pending") return "بانتظار المعالجة";
  if (status === "processing") return "قيد المعالجة";
  if (channel === "sms") {
    if (["submitted", "delivered", "read"].includes(status)) return "مرسلة";
    if (status === "failed") return "غير مرسلة";
  } else {
    if (status === "submitted") return "مرسلة";
    if (status === "delivered") return "تم التسليم";
    if (status === "read") return "مقروءة";
    if (status === "failed") return "فاشلة";
  }
  return status;
}

export function notificationStatusTone(status: NotificationStatus, channel: NotificationChannel): string {
  if (status === "failed") return "bg-rose-400/10 text-rose-300";
  if (channel === "sms" && ["submitted", "delivered", "read"].includes(status)) return "bg-emerald-400/10 text-emerald-300";
  if (channel === "whatsapp" && ["delivered", "read"].includes(status)) return "bg-emerald-400/10 text-emerald-300";
  if (status === "submitted") return "bg-[#F5B800]/10 text-[#F5B800]";
  return "bg-white/5 text-slate-300";
}
