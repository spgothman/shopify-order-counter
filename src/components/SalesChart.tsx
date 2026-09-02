"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

interface SalesChartProps {
  data: Array<{ label: string; sales: number }>;
  loading?: boolean;
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
  payload?: Array<{ value: number }>;
  label?: string;
}) {
  if (!active || !payload?.[0]) return null;
  return (
    <div className="report-tooltip">
      <span className="report-tooltip-label">{label}</span>
      <span className="report-tooltip-value">{usd.format(payload[0].value)}</span>
    </div>
  );
}

export function SalesChart({ data, loading = false }: SalesChartProps) {
  return (
    <div className="report-chart">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 12, right: 8, left: 4, bottom: 4 }}>
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
          <Tooltip
            cursor={{ fill: "rgba(0, 0, 0, 0.06)" }}
            content={<ChartTooltip />}
          />
          <Bar
            dataKey="sales"
            fill="#1a1a1a"
            radius={[5, 5, 0, 0]}
            maxBarSize={42}
            isAnimationActive={!loading}
          />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
