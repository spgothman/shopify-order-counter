"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

interface ChartRow {
  label: string;
  sales: number;
  priorSales?: number;
}

interface SalesChartProps {
  data: ChartRow[];
  loading?: boolean;
  yoy?: boolean;
  currentYear?: number;
  priorYear?: number;
}

const usd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});

function formatAxis(value: number): string {
  if (Math.abs(value) >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
  if (Math.abs(value) >= 10_000) return `$${(value / 1000).toFixed(0)}k`;
  if (Math.abs(value) >= 1000) return `$${(value / 1000).toFixed(1)}k`;
  return `$${Math.round(value)}`;
}

function yoyChangePct(current: number, prior: number): number | null {
  if (prior === 0) return current === 0 ? 0 : null;
  return ((current - prior) / prior) * 100;
}

function formatYoyChange(pct: number | null): string {
  if (pct === null) return "n/a";
  const sign = pct > 0 ? "+" : "";
  return `${sign}${pct.toFixed(1)}%`;
}

function ChartTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: Array<{
    name?: string;
    value?: number;
    color?: string;
    dataKey?: string;
    payload?: ChartRow;
  }>;
  label?: string;
}) {
  if (!active || !payload?.length) return null;

  const current = payload.find((item) => item.dataKey === "sales")?.value ?? 0;
  const priorItem = payload.find((item) => item.dataKey === "priorSales");
  const showYoy = priorItem != null;
  const pct = showYoy ? yoyChangePct(current, priorItem.value ?? 0) : null;
  const yoyClass =
    pct === null || pct === 0
      ? "report-tooltip-yoy-flat"
      : pct > 0
        ? "report-tooltip-yoy-up"
        : "report-tooltip-yoy-down";

  return (
    <div className="report-tooltip">
      <span className="report-tooltip-label">{label}</span>
      {payload.map((item) => (
        <span key={item.name} className="report-tooltip-value">
          <span className="report-tooltip-swatch" style={{ background: item.color }} />
          {item.name}: {usd.format(item.value ?? 0)}
        </span>
      ))}
      {showYoy && (
        <span className={`report-tooltip-yoy ${yoyClass}`}>
          YoY: {formatYoyChange(pct)}
        </span>
      )}
    </div>
  );
}

export function SalesChart({
  data,
  loading = false,
  yoy = false,
  currentYear,
  priorYear,
}: SalesChartProps) {
  const chartData = yoy
    ? data.map((row) => ({
        label: row.label,
        priorSales: row.priorSales ?? 0,
        sales: row.sales,
      }))
    : data;

  return (
    <div className="report-chart">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart
          key={yoy ? "yoy" : "single"}
          data={chartData}
          margin={{ top: 12, right: 8, left: 4, bottom: yoy ? 8 : 4 }}
        >
          <CartesianGrid stroke="rgba(0, 0, 0, 0.08)" vertical={false} />
          <XAxis
            dataKey="label"
            tick={{ fill: "rgba(0, 0, 0, 0.55)", fontSize: 11, fontWeight: 600 }}
            axisLine={{ stroke: "rgba(0, 0, 0, 0.15)" }}
            tickLine={false}
            interval={data.length > 16 ? 1 : 0}
          />
          <YAxis
            tickFormatter={formatAxis}
            tick={{ fill: "rgba(0, 0, 0, 0.45)", fontSize: 11, fontWeight: 600 }}
            axisLine={false}
            tickLine={false}
            width={56}
          />
          <Tooltip cursor={{ fill: "rgba(0, 0, 0, 0.06)" }} content={<ChartTooltip />} />
          {yoy && (
            <Legend
              wrapperStyle={{ fontSize: 12, fontWeight: 700, color: "rgba(0, 0, 0, 0.65)" }}
            />
          )}
          {yoy && (
            <Bar
              id="prior-year"
              dataKey="priorSales"
              name={String(priorYear ?? "Prior year")}
              fill="#b08968"
              radius={[5, 5, 0, 0]}
              maxBarSize={28}
              isAnimationActive={!loading}
            />
          )}
          <Bar
            id="current-year"
            dataKey="sales"
            name={yoy ? String(currentYear ?? "This year") : "Sales"}
            fill="#1a1a1a"
            radius={[5, 5, 0, 0]}
            maxBarSize={yoy ? 28 : 42}
            isAnimationActive={!loading}
          />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
