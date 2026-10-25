import { Cloud, CloudOff } from "lucide-react";
import { usePowerHubConnectivity } from "@/lib/offline-connectivity";

export function OfflineStatusBanner() {
  const { isOnline } = usePowerHubConnectivity();

  if (isOnline) return null;

  return (
    <div className="fixed inset-x-0 top-0 z-[100] flex items-center justify-center border-b border-amber-300/20 bg-amber-500/10 px-4 py-2 text-xs font-semibold text-amber-100 backdrop-blur">
      <CloudOff className="ml-2 h-4 w-4 shrink-0" />
      تعذّر الوصول إلى خادم PowerHub مؤقتًا. نحاول إعادة الاتصال تلقائيًا؛ لا يعني ذلك بالضرورة انقطاع الإنترنت عن جهازك.
      <a href="/offline-sync" className="mr-2 inline-flex items-center gap-1 rounded-lg px-2 py-1 text-amber-200 underline underline-offset-2 hover:bg-amber-200/10">
        مركز المزامنة
      </a>
      <Cloud className="mr-1 h-3.5 w-3.5 opacity-60" aria-hidden="true" />
    </div>
  );
}
