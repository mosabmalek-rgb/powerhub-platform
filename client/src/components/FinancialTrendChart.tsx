import { Card, CardContent } from "@/components/ui/card";
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

export type FinancialTrendPoint = {
  date: string;
  invoiced: number;
  collected: number;
  expenses: number;
  netCash: number;
};

const money = (value: number) =>
  new Intl.NumberFormat("ar-PS", { maximumFractionDigits: 2 }).format(value);

const seriesLabels: Record<string, string> = {
  invoiced: "الفوترة",
  collected: "التحصيل",
  expenses: "المصروفات",
  netCash: "صافي النقد",
};

function TrendLoading() {
  return (
    <Card className="border-white/8 bg-[#111823] shadow-panel">
      <CardContent className="space-y-5 p-5 sm:p-6" aria-label="جارٍ تحميل الاتجاه المالي">
        <div className="h-5 w-44 animate-pulse rounded bg-white/10" />
        <div className="h-64 animate-pulse rounded-xl bg-white/[.03]" />
        <div className="flex flex-wrap gap-3">
          <div className="h-3 w-20 animate-pulse rounded bg-white/10" />
          <div className="h-3 w-20 animate-pulse rounded bg-white/10" />
          <div className="h-3 w-20 animate-pulse rounded bg-white/10" />
        </div>
      </CardContent>
    </Card>
  );
}

export function FinancialTrendChart({
  data,
  loading = false,
}: {
  data: FinancialTrendPoint[];
  loading?: boolean;
}) {
  if (loading) return <TrendLoading />;

  return (
    <Card className="border-white/8 bg-[#111823] shadow-panel">
      <CardContent className="p-4 sm:p-6">
        <div className="mb-5 flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h2 className="text-base font-bold text-white sm:text-lg">الاتجاه المالي</h2>
            <p className="mt-1 text-sm leading-6 text-slate-400">
              مقارنة الفوترة والتحصيل والمصروفات وصافي النقد يوميًا ضمن الفترة المختارة.
            </p>
          </div>
          <p className="text-xs text-slate-500">{money(data.length)} يومًا ببيانات معروضة</p>
        </div>

        {data.length === 0 ? (
          <div className="grid min-h-56 place-items-center rounded-xl border border-dashed border-white/10 px-4 text-center">
            <div>
              <p className="font-semibold text-slate-300">لا توجد بيانات مالية لهذه الفترة</p>
              <p className="mt-2 text-sm text-slate-500">
                جرّب فترة أخرى عند توفر بيانات فوترة أو تحصيل.
              </p>
            </div>
          </div>
        ) : (
          <>
            <div className="h-[300px] w-full sm:h-[340px]" dir="ltr">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart
                  data={data}
                  margin={{ top: 12, right: 8, left: 0, bottom: 4 }}
                >
                  <CartesianGrid stroke="#263241" strokeDasharray="3 5" vertical={false} />
                  <XAxis
                    dataKey="date"
                    tickFormatter={(value) => String(value).slice(5)}
                    tick={{ fill: "#94a3b8", fontSize: 11 }}
                    tickLine={false}
                    axisLine={{ stroke: "#334155" }}
                    minTickGap={24}
                    interval="preserveStartEnd"
                  />
                  <YAxis
                    tickFormatter={(value) => money(Number(value))}
                    tick={{ fill: "#94a3b8", fontSize: 10 }}
                    tickLine={false}
                    axisLine={false}
                    width={72}
                    tickCount={5}
                    domain={["auto", "auto"]}
                  />
                  <Tooltip
                    contentStyle={{
                      background: "#0b1220",
                      border: "1px solid #334155",
                      borderRadius: 12,
                      color: "#f8fafc",
                      direction: "rtl",
                      fontSize: 12,
                    }}
                    labelStyle={{ color: "#cbd5e1", marginBottom: 6, fontWeight: 700 }}
                    formatter={(value: number | string, name: string) => [
                      money(Number(value)),
                      seriesLabels[name] ?? name,
                    ]}
                    labelFormatter={(label) => `التاريخ: ${label}`}
                  />
                  <Legend
                    verticalAlign="bottom"
                    height={38}
                    iconType="circle"
                    iconSize={8}
                    wrapperStyle={{ fontSize: 12, color: "#cbd5e1", paddingTop: 12 }}
                    formatter={(value) => seriesLabels[value] ?? value}
                  />
                  <Bar
                    dataKey="invoiced"
                    name="invoiced"
                    fill="#60a5fa"
                    radius={[4, 4, 0, 0]}
                    maxBarSize={18}
                  />
                  <Bar
                    dataKey="collected"
                    name="collected"
                    fill="#34d399"
                    radius={[4, 4, 0, 0]}
                    maxBarSize={18}
                  />
                  <Bar
                    dataKey="expenses"
                    name="expenses"
                    fill="#fbbf24"
                    radius={[4, 4, 0, 0]}
                    maxBarSize={18}
                  />
                  <Line
                    type="monotone"
                    dataKey="netCash"
                    name="netCash"
                    stroke="#c084fc"
                    strokeWidth={2.5}
                    dot={false}
                    activeDot={{ r: 4, strokeWidth: 0 }}
                    connectNulls={false}
                  />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
            <p className="mt-2 text-xs leading-5 text-slate-500">
              مرّر المؤشر فوق الرسم لمراجعة القيم الدقيقة لكل يوم. جميع المبالغ معروضة كما وردت من البيانات المالية.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
