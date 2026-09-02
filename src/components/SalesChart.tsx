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

function ChartTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: Array<{ name?: string; value?: number; color?: string }>;
  label?: string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="report-tooltip">
      <span className="report-tooltip-label">{label}</span>
      {payload.map((item) => (
        <span key={item.name} className="report-tooltip-value">
          <span className="report-tooltip-swatch" style={{ background: item.color }} />
          {item.name}: {usd.format(item.value ?? 0)}
        </span>
      ))}
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
  return (
    <div className="report-chart">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 12, right: 8, left: 4, bottom: yoy ? 8 : 4 }}>
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
          <Bar
            dataKey="sales"
            name={yoy ? String(currentYear ?? "This year") : "Sales"}
            fill="#1a1a1a"
            radius={[5, 5, 0, 0]}
            maxBarSize={yoy ? 28 : 42}
            isAnimationActive={!loading}
          />
          {yoy && (
            <Bar
              dataKey="priorSales"
              name={String(priorYear ?? "Prior year")}
              fill="#b08968"
              radius={[5, 5, 0, 0]}
              maxBarSize={28}
              isAnimationActive={!loading}
            />
          )}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
