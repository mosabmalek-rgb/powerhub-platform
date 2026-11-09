import { CloudOff, X } from "lucide-react";
import { useState } from "react";
import { usePowerHubConnectivity } from "@/lib/offline-connectivity";

export function OfflineStatusBanner() {
  const { isOnline } = usePowerHubConnectivity();
  const [expanded, setExpanded] = useState(false);
  if (isOnline) return null;

  return (
    <aside className="pointer-events-none fixed bottom-[calc(env(safe-area-inset-bottom)+5rem)] right-3 z-40 flex max-w-[calc(100vw-1.5rem)] flex-col items-end gap-2 sm:bottom-4 sm:right-4" aria-label="حالة الاتصال بالخادم">
      {expanded ? (
        <div role="status" className="pointer-events-auto relative w-64 max-w-[calc(100vw-1.5rem)] rounded-xl border border-amber-300/30 bg-[#111823] p-3 pr-9 text-xs leading-5 text-amber-100 shadow-xl">
          <button type="button" aria-label="إغلاق تفاصيل الاتصال" className="absolute right-2 top-2 rounded p-1 hover:bg-white/10" onClick={() => setExpanded(false)}><X className="h-4 w-4" /></button>
          <p className="font-bold">تعذر الوصول إلى خادم PowerHub</p>
          <p className="mt-1 text-slate-200">نحاول إعادة الاتصال تلقائياً. تبقى البيانات المحفوظة متاحة للقراءة حسب نطاقها وصلاحية الكاش.</p>
          <a href="/offline-sync" className="mt-2 inline-block font-semibold text-amber-200 underline underline-offset-2">مركز المزامنة</a>
        </div>
      ) : null}
      <button type="button" aria-label="تعذر الوصول إلى الخادم؛ عرض تفاصيل الاتصال" title="غير متصل بخادم PowerHub" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)} className="pointer-events-auto flex h-10 w-10 items-center justify-center rounded-full border border-amber-300/40 bg-[#111823] text-amber-200 shadow-lg transition hover:bg-[#253244] focus-visible:outline focus-visible:outline-2 focus-visible:outline-amber-300">
        <CloudOff className="h-5 w-5" aria-hidden="true" />
      </button>
    </aside>
  );
}
