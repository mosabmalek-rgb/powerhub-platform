import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";

// B4.9 — manual, scoped source posting. No automatic cash transfer GL backfill.
const formatMoney = (value: number) =>
  value.toLocaleString("ar", { minimumFractionDigits: 0, maximumFractionDigits: 2 });

export default function FinancialCashTransferPostingWorkspace({
  siteId, period, active,
}: { siteId: number; period: string; active: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const [beforeSourceId, setBeforeSourceId] = useState<number | undefined>();
  const [previousPages, setPreviousPages] = useState<Array<number | undefined>>([]);
  const [acknowledged, setAcknowledged] = useState(false);
  const [confirmedSourceId, setConfirmedSourceId] = useState<number | null>(null);
  const [notice, setNotice] = useState("");
  const enabled = active && expanded && siteId > 0
    && /^\d{4}-(0[1-9]|1[0-2])$/.test(period);
  const utils = trpc.useUtils();
  const candidates = trpc.powerhub.reports.financialGLCashTransferCandidates.useQuery(
    { siteId, period, beforeSourceId },
    { enabled, staleTime: 0, refetchOnWindowFocus: false, refetchOnReconnect: true },
  );
  const post = trpc.powerhub.reports.financialGLPostSource.useMutation({
    onSuccess: async (result) => {
      setConfirmedSourceId(null);
      setAcknowledged(false);
      setNotice(result.alreadyPosted === true
        ? "القيد موجود مسبقًا؛ لم يُنشأ قيد مكرر."
        : "تأكد إنشاء قيد GL. تحقق من مطابقة B4 قبل اعتماد التقرير.");
      await Promise.all([
        utils.powerhub.reports.financialGLCashTransferCandidates.invalidate(),
        utils.powerhub.reports.financialGLSubledgerReconciliation.invalidate(),
      ]);
    },
    onError: () => {
      setNotice("");
    },
  });
  const ready = enabled && !candidates.isLoading && !candidates.isFetching
    && !candidates.isError && candidates.data?.siteId === siteId
    && candidates.data?.period === period
    && candidates.data?.accountingCertification === "NOT_CERTIFIED";
  const rows = ready ? (candidates.data?.items ?? []) : [];

  return <section className="mt-3 rounded-md border border-white/15 p-3 text-sm text-slate-200" dir="rtl">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div>
        <h4 className="font-semibold text-white">B4.9 — ترحيل تحويلات حسابات الشركة</h4>
        <p className="mt-1 text-xs text-slate-400">
          تحويلات الحسابات داخل الفرع فقط. لا يُنشئ الترحيل إيرادًا أو مصروفًا،
          ولا يعتمد القوائم المالية أو التسويات بين الفروع.
        </p>
      </div>
      <Button type="button" size="sm" variant="outline"
        onClick={() => { setExpanded(!expanded); setNotice(""); setConfirmedSourceId(null); setAcknowledged(false); }}>
        {expanded ? "إخفاء التحويلات" : "عرض تحويلات الحسابات"}
      </Button>
    </div>
    {expanded ? <div className="mt-3 space-y-3">
      {candidates.isFetching ? <p role="status">جارٍ التحقق من تحويلات المصدر وقيود GL…</p> : null}
      {candidates.isError ? <p role="alert" className="text-rose-200">
        تعذّر التحقق من التحويلات؛ لا يمكن اعتماد بيانات مؤقتة أو ترحيلها.
      </p> : null}
      {ready && rows.length === 0 ? <p>لا توجد تحويلات حسابات في هذه الصفحة والفترة.</p> : null}
      {ready ? rows.map(item => <div key={item.sourceId}
        className="rounded border border-white/10 p-3">
        <p className="font-medium">
          حركة رقم {item.sourceId} — {formatMoney(item.amount)} شيكل
        </p>
        <p className="mt-1 text-xs text-slate-300">
          {item.sourceAccountName} ← {item.destinationAccountName}
        </p>
        <p className="mt-1 text-xs text-slate-400">
          {item.glEntryId === null ? "بانتظار قيد GL" :
            `قيد GL موجود (#${item.glEntryId}) — يحتاج مطابقة B4`}
        </p>
        {item.glEntryId === null ? <div className="mt-2 space-y-2">
          {confirmedSourceId === item.sourceId ? <>
            <label className="flex items-start gap-2 text-xs">
              <input type="checkbox" checked={acknowledged}
                onChange={e => setAcknowledged(e.target.checked)}
                className="mt-0.5" />
              تحققت من حسابَي التحويل ومبلغه. أفهم أن الإجراء يرحّل قيدًا
              محاسبيًا غير قابل للحذف، وليس اعتمادًا ماليًا نهائيًا.
            </label>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" disabled={!ready || !acknowledged || post.isPending}
                onClick={() => post.mutate({
                  siteId, sourceType: "account_movement", sourceId: item.sourceId,
                })}>{post.isPending ? "جارٍ الترحيل…" : "تأكيد الترحيل إلى GL"}</Button>
              <Button size="sm" variant="outline" disabled={post.isPending}
                onClick={() => { setConfirmedSourceId(null); setAcknowledged(false); }}>
                إلغاء
              </Button>
            </div>
          </> : <Button type="button" variant="outline" size="sm"
            disabled={!ready || post.isPending}
            onClick={() => { setConfirmedSourceId(item.sourceId); setAcknowledged(false); setNotice(""); }}>
            مراجعة وترحيل
          </Button>}
        </div> : null}
      </div>) : null}
      {ready ? <div className="flex flex-wrap gap-2">
        {previousPages.length > 0 ? <Button size="sm" variant="outline"
          disabled={post.isPending} onClick={() => {
            const old = previousPages[previousPages.length - 1];
            setBeforeSourceId(old);
            setPreviousPages(v => v.slice(0, -1));
            setConfirmedSourceId(null); setAcknowledged(false);
          }}>السابق</Button> : null}
        {candidates.data?.hasMore && candidates.data.nextBeforeSourceId != null
          ? <Button size="sm" variant="outline" disabled={post.isPending}
              onClick={() => {
                setPreviousPages(v => [...v, beforeSourceId]);
                setBeforeSourceId(candidates.data?.nextBeforeSourceId ?? undefined);
                setConfirmedSourceId(null); setAcknowledged(false);
              }}>المزيد</Button> : null}
      </div> : null}
      {post.isError ? <p role="alert" className="text-rose-200">
        رفض الخادم الترحيل؛ لم يُؤكد إنشاء قيد. تحقق من المصدر والصلاحيات وحالة الفترة.
      </p> : null}
      {notice ? <p role="status" className="text-slate-200">{notice}</p> : null}
    </div> : null}
  </section>;
}
