import { useAuth } from "@/_core/hooks/useAuth";
import { getPowerHubDeviceId } from "@/lib/offline-auth";
import { getSupabaseAccessToken } from "@/lib/supabase";
import { validateC5HttpResponse } from "@/lib/c5-close-readiness-proof";
import { useState } from "react";

// Browser-session acceptance probes. Only status, error code and PASS/FAIL are retained.
// The foreign site is an existing isolated Staging fixture, never a production ID.
const HOME = { tenantId: 1, siteId: 1, period: "2026-11" } as const;
const FOREIGN = { tenantId: 9000000000001, siteId: 9000000000011 } as const;
type Outcome = { id: string; path: string; expected: string; status: number | null;
  code: string; result: "PASS" | "FAIL" | "BLOCKED" };

function query(path: string, input: Record<string, unknown>) {
  return `/api/trpc/${path}?input=${encodeURIComponent(JSON.stringify({ json: input }))}`;
}

function errorCode(raw: string): string {
  try {
    const parsed = JSON.parse(raw);
    const code = parsed?.error?.data?.code;
    return typeof code === "string" && /^[A-Z_]{3,40}$/.test(code) ? code : "UNVERIFIED_ERROR";
  } catch { return "INVALID_RESPONSE"; }
}

export default function D9HttpAcceptancePage() {
  const { user, isAuthenticated, loading } = useAuth();
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<Outcome[]>([]);
  const [message, setMessage] = useState("لم يبدأ اختبار D9");
  const allowed = !loading && isAuthenticated
    && user?.email === "owner.e2e@powerhub-staging.example.com"
    && /^powerhub-platform-[a-z0-9]+-mosabmalek-rgb\.vercel\.app$/.test(location.hostname);

  async function run() {
    if (!allowed || running) return;
    setRunning(true); setResults([]); setMessage("التحقق من الجاهزية والجهاز");
    try {
      const ready = await fetch("/api/ready", { cache: "no-store", signal: AbortSignal.timeout(8000) });
      const health = await ready.json();
      if (ready.status !== 200 || health?.status !== "ok"
        || health?.checks?.supabaseConnectivity !== true) throw new Error("PREVIEW_NOT_READY");
      const token = await getSupabaseAccessToken();
      const device = await getPowerHubDeviceId();
      if (!token || !device) throw new Error("SESSION_OR_DEVICE_UNAVAILABLE");
      const headers = { authorization: `Bearer ${token}`, "x-powerhub-device-id": device,
        accept: "application/json", "cache-control": "no-store" };
      const endpoint = "powerhub.reports.accrualCloseReadiness";
      const baseline = { siteId: HOME.siteId, period: HOME.period };
      const probes: Array<{ id: string; path: string; expected: string; url: string;
        method?: "POST"; body?: string; authenticated?: boolean }> = [
        { id: "T01", path: endpoint, expected: "200, tenant 1/site 1/BLOCKED", url: query(endpoint, baseline) },
        { id: "T03", path: endpoint, expected: "403 foreign tenant site", url: query(endpoint,
          { siteId: FOREIGN.siteId, period: HOME.period }) },
        { id: "T04", path: endpoint, expected: "400 forged tenantId rejected", url: query(endpoint,
          { ...baseline, tenantId: FOREIGN.tenantId }) },
        { id: "T05", path: endpoint, expected: "403 altered siteId", url: query(endpoint,
          { siteId: FOREIGN.siteId, period: HOME.period }) },
        { id: "T06", path: endpoint, expected: "401 no bearer/device", url: query(endpoint, baseline),
          authenticated: false },
        { id: "T19", path: "powerhub.reports.financialGLMonthlyComparison",
          expected: "403 foreign financial report",
          url: query("powerhub.reports.financialGLMonthlyComparison",
            { siteId: FOREIGN.siteId, currentPeriod: HOME.period, previousPeriod: "2026-10" }) },
        { id: "T20", path: "powerhub.reports.financialGLMonthlyComparisonExport",
          expected: "403 foreign export", url: "/api/trpc/powerhub.reports.financialGLMonthlyComparisonExport",
          method: "POST", body: JSON.stringify({ json: { siteId: FOREIGN.siteId,
            currentPeriod: HOME.period, previousPeriod: "2026-10",
            expectedFingerprint: "00000000000000000000000000000000" } }) },
        { id: "T22", path: endpoint, expected: "403 direct API bypass",
          url: query(endpoint, { siteId: FOREIGN.siteId, period: HOME.period }) },
      ];
      const completed: Outcome[] = [];
      for (const probe of probes) {
        setMessage(`تنفيذ ${probe.id}`);
        try {
          const response = await fetch(probe.url, { method: probe.method ?? "GET",
            headers: probe.authenticated === false ? { accept: "application/json" } :
              probe.method === "POST" ? { ...headers, "content-type": "application/json" } : headers,
            body: probe.body, cache: "no-store", redirect: "manual", signal: AbortSignal.timeout(8000) });
          const raw = await response.text();
          const code = response.status === 200 ? "SUCCESS" : errorCode(raw);
          let passed = false;
          if (probe.id === "T01") {
            try { validateC5HttpResponse(response.status, raw, HOME, "BLOCKED"); passed = true; }
            catch { passed = false; }
          } else {
            passed = probe.id === "T04" ? response.status === 400
              : probe.id === "T06" ? response.status === 401
                : response.status === 403;
          }
          completed.push({ id: probe.id, path: probe.path, expected: probe.expected,
            status: response.status, code, result: passed ? "PASS" : "FAIL" });
        } catch {
          completed.push({ id: probe.id, path: probe.path, expected: probe.expected,
            status: null, code: "TIMEOUT_OR_TRANSPORT", result: "BLOCKED" });
        }
        setResults([...completed]);
      }
      setMessage(completed.every(x => x.result === "PASS") ? "اكتملت اختبارات القراءة والرفض" :
        "توجد اختبارات فاشلة أو ممنوعة؛ لا يُقبل D9");
    } catch (error) {
      setMessage(error instanceof Error ? error.message.slice(0,60) : "PRECHECK_FAILED");
    } finally { setRunning(false); }
  }

  if (!allowed) return <main dir="rtl" className="p-8">الحساب الاختباري المصادق فقط.</main>;
  return <main dir="rtl" className="min-h-screen bg-[#0D1117] p-6 text-white">
    <h1 className="text-xl font-bold">D9 — اختبار عزل HTTPS محدود</h1>
    <p>طلبات قراءة ورفض فقط على Staging. هذا الاختبار لا ينفذ Maker–Checker ولا يغيّر بيانات مالية.</p>
    <button disabled={running} onClick={() => void run()} className="my-4 rounded bg-amber-400 px-4 py-2 text-black disabled:opacity-50">
      تشغيل فحوص العزل</button>
    <p role="status">{message}</p>
    <table className="mt-4 border-collapse" dir="ltr"><thead><tr>
      {["Case", "API", "Expected", "HTTP", "Code", "Result"].map(x =>
        <th key={x} className="border p-2">{x}</th>)}
    </tr></thead><tbody>{results.map(x => <tr key={x.id}>
      {[x.id, x.path, x.expected, x.status ?? "—", x.code, x.result].map((v,i) =>
        <td key={i} className="border p-2">{v}</td>)}
    </tr>)}</tbody></table>
  </main>;
}
