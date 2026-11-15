import { useAuth } from "@/_core/hooks/useAuth";
import { getPowerHubDeviceId } from "@/lib/offline-auth";
import { getSupabaseAccessToken } from "@/lib/supabase";
import { useState } from "react";

// Browser-local acceptance: credentials and response bodies never enter the evidence table.
const SCOPE = { tenantId: 1, siteId: 1, foreignSiteId: 9000000000011, period: "2026-11" } as const;
const ROUTES = ["accrualCloseReadiness", "financialGLTrialBalance", "financialGLSiteStatements"] as const;
type RouteName = typeof ROUTES[number];
type Result = { caseId: string; route: string; http: number | null; code: string; result: "PASS" | "FAIL" | "BLOCKED" };

function apiUrl(route: RouteName, siteId: number, forgedTenant = false): string {
  const input = { siteId, period: SCOPE.period, ...(forgedTenant ? { tenantId: 9000000000001 } : {}) };
  return `/api/trpc/powerhub.reports.${route}?input=${encodeURIComponent(JSON.stringify({ json: input }))}`;
}
function parsed(raw: string): Record<string, any> | null {
  try { const value = JSON.parse(raw); return value && typeof value === "object" ? value : null; }
  catch { return null; }
}
function validOwn(route: RouteName, status: number, raw: string): boolean {
  if (status !== 200) return false;
  const data = parsed(raw)?.result?.data?.json;
  if (!data || data.tenantId !== SCOPE.tenantId || data.siteId !== SCOPE.siteId
    || data.accountingCertification !== "NOT_CERTIFIED") return false;
  if (route === "accrualCloseReadiness") return data.period === SCOPE.period
    && data.isFinalFinancialStatement === false && data.canAutomaticallyLock === false
    && data.needsIndependentReviewer === true && Array.isArray(data.blockers);
  if (route === "financialGLTrialBalance") return data.throughPeriod === SCOPE.period
    && data.isFinalBalanceSheet === false && data.isMathematicallyBalanced === true
    && Number(data.difference) === 0 && Array.isArray(data.accounts) && !!data.sourceCoverage;
  return data.period === SCOPE.period && data.siteScope === "SITE_ONLY"
    && data.isFinalBalanceSheet === false && data.isFinalProfit === false
    && data.isCompleteAccrualStatement === false && data.isMathematicallyBalanced === true
    && Array.isArray(data.accounts);
}
function validDenial(status: number, raw: string): boolean {
  if (status !== 403 && status !== 404) return false;
  const body = parsed(raw);
  return ["FORBIDDEN", "NOT_FOUND"].includes(body?.error?.json?.data?.code)
    && !body?.result && !raw.includes('"accounts"') && !raw.includes('"incomeStatement"');
}
function codeOf(status: number, raw: string): string {
  if (status === 200) return "SUCCESS";
  const code = parsed(raw)?.error?.json?.data?.code;
  return typeof code === "string" && /^[A-Z_]{3,40}$/.test(code) ? code : "INVALID_RESPONSE";
}

export default function D36HttpAcceptancePage() {
  const { user, isAuthenticated, loading } = useAuth();
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<Result[]>([]);
  const [message, setMessage] = useState("لم يبدأ الاختبار");
  const allowed = !loading && isAuthenticated && user?.email === "owner.e2e@powerhub-staging.example.com"
    && /^powerhub-platform-[a-z0-9]+-mosabmalek-rgb\.vercel\.app$/.test(location.hostname);
  async function run() {
    if (!allowed || running) return;
    setRunning(true); setResults([]); setMessage("التحقق من جاهزية المعاينة والجهاز");
    try {
      const ready = await fetch("/api/ready", { cache: "no-store", signal: AbortSignal.timeout(8000) });
      const health = await ready.json();
      if (ready.status !== 200 || health?.status !== "ok" || health?.checks?.supabaseConnectivity !== true
        || health?.checks?.supabaseConfig !== true || health?.checks?.application !== true)
        throw Error("D36_PREVIEW_NOT_READY");
      const token = await getSupabaseAccessToken();
      const device = await getPowerHubDeviceId();
      if (!token || !device) throw Error("D36_SESSION_OR_DEVICE_UNAVAILABLE");
      const headers = { authorization: `Bearer ${token}`, "x-powerhub-device-id": device,
        accept: "application/json", "cache-control": "no-store" };
      const probes = ROUTES.flatMap((route, index) => [
        { caseId: `OWN_${index+1}`, route, siteId: SCOPE.siteId, authenticated: true, kind: "own" },
        { caseId: `FOREIGN_${index+1}`, route, siteId: SCOPE.foreignSiteId, authenticated: true, kind: "foreign" },
      ]);
      const cases = [ ...probes,
        { caseId: "ANONYMOUS", route: ROUTES[0], siteId: SCOPE.siteId, authenticated: false, kind: "anonymous" },
        { caseId: "FORGED_TENANT", route: ROUTES[0], siteId: SCOPE.siteId, authenticated: true, kind: "forged" },
      ];
      const completed: Result[] = [];
      for (const test of cases) {
        setMessage(`تنفيذ ${test.caseId}`);
        try {
          const response = await fetch(apiUrl(test.route, test.siteId, test.kind === "forged"), {
            method: "GET", headers: test.authenticated ? headers : { accept: "application/json" },
            cache: "no-store", redirect: "manual", signal: AbortSignal.timeout(8000),
          });
          const raw = await response.text();
          const passed = test.kind === "own" ? validOwn(test.route, response.status, raw)
            : test.kind === "foreign" ? validDenial(response.status, raw)
              : test.kind === "anonymous" ? response.status === 401 && codeOf(response.status, raw) === "UNAUTHORIZED"
                : response.status === 400 && codeOf(response.status, raw) === "BAD_REQUEST";
          completed.push({ caseId: test.caseId, route: test.route, http: response.status,
            code: codeOf(response.status, raw), result: passed ? "PASS" : "FAIL" });
        } catch {
          completed.push({ caseId: test.caseId, route: test.route, http: null,
            code: "TIMEOUT_OR_TRANSPORT", result: "BLOCKED" });
        }
        setResults([...completed]);
      }
      setMessage(completed.every(x => x.result === "PASS")
        ? "اجتازت جلسة المالك فحوصها الثمانية؛ حساب المستأجر الثاني والأدوار المقيدة لم تُختبر"
        : "فشل أو تعذّر فحص؛ D36 غير مقبولة");
    } catch (e) { setMessage(e instanceof Error ? e.message.slice(0,60) : "D36_PRECHECK_FAILED"); }
    finally { setRunning(false); }
  }
  if (!allowed) return <main dir="rtl" className="p-8">الاختبار متاح لحساب Staging المخصص على المعاينة فقط.</main>;
  return <main dir="rtl" className="min-h-screen bg-[#0D1117] p-6 text-white">
    <h1 className="text-xl font-bold">D36 — فحص HTTPS المصادق المحدود</h1>
    <p>ثلاثة تقارير مسموحة وثلاثة طلبات فرع أجنبي وطلب مجهول ومستأجر مزوّر. لا كتابة مالية؛ لا قبول كامل دون حساب مستقل للمستأجر الآخر.</p>
    <button disabled={running} onClick={() => void run()} className="my-4 rounded bg-amber-400 px-4 py-2 text-black disabled:opacity-50">تشغيل فحوص D36</button>
    <p role="status">{message}</p>
    <table className="mt-4 border-collapse" dir="ltr"><thead><tr>{["Case", "API", "HTTP", "Code", "Result"].map(x =>
      <th key={x} className="border p-2">{x}</th>)}</tr></thead><tbody>{results.map(x =>
      <tr key={x.caseId}>{[x.caseId,x.route,x.http ?? "—",x.code,x.result].map((v,i) =>
        <td key={i} className="border p-2">{v}</td>)}</tr>)}</tbody></table>
  </main>;
}
