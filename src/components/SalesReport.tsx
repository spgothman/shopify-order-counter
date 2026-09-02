"use client";

import dynamic from "next/dynamic";
import { useEffect, useMemo, useState } from "react";

type SalesReportView = "hourly" | "daily" | "monthly" | "yoy";

const VIEW_OPTIONS: Array<{ id: SalesReportView; label: string }> = [
  { id: "hourly", label: "Hourly" },
  { id: "daily", label: "Daily" },
  { id: "monthly", label: "Monthly" },
  { id: "yoy", label: "YOY" },
];

const SalesChart = dynamic(
  () => import("./SalesChart").then((mod) => mod.SalesChart),
  { ssr: false },
);

interface ReportResponse {
  view?: SalesReportView;
  title?: string;
  buckets: Array<{ label: string; sales: number; priorSales?: number }> | null;
  total?: number;
  priorTotal?: number;
  yoyChangePct?: number | null;
  currentYear?: number;
  priorYear?: number;
  configured: boolean;
  error?: string;
}

const MONTHS = [
  { value: 1, label: "January" },
  { value: 2, label: "February" },
  { value: 3, label: "March" },
  { value: 4, label: "April" },
  { value: 5, label: "May" },
  { value: 6, label: "June" },
  { value: 7, label: "July" },
  { value: 8, label: "August" },
  { value: 9, label: "September" },
  { value: 10, label: "October" },
  { value: 11, label: "November" },
  { value: 12, label: "December" },
];

const usd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});

function pad(n: number) {
  return String(n).padStart(2, "0");
}

function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function yearOptions(): number[] {
  const current = new Date().getFullYear();
  const years: number[] = [];
  for (let y = current; y >= 2018; y--) years.push(y);
  return years;
}

function formatYoyChange(pct: number | null | undefined, priorYear?: number): string {
  const vs = priorYear ? ` vs ${priorYear}` : "";
  if (pct === null || pct === undefined) return `n/a${vs}`;
  const sign = pct > 0 ? "+" : "";
  return `${sign}${pct.toFixed(1)}%${vs}`;
}

export function SalesReport() {
  const now = useMemo(() => new Date(), []);
  const [view, setView] = useState<SalesReportView>("hourly");
  const [date, setDate] = useState(todayIso);
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [year, setYear] = useState(now.getFullYear());
  const [title, setTitle] = useState("");
  const [total, setTotal] = useState(0);
  const [yoyChangePct, setYoyChangePct] = useState<number | null>(null);
  const [currentYear, setCurrentYear] = useState<number | undefined>();
  const [priorYear, setPriorYear] = useState<number | undefined>();
  const [buckets, setBuckets] = useState<Array<{ label: string; sales: number; priorSales?: number }>>([]);
  const [error, setError] = useState<string | null>(null);

  const query = useMemo(() => {
    const params = new URLSearchParams({ view });
    if (view === "hourly") params.set("date", date);
    if (view === "daily") {
      params.set("year", String(year));
      params.set("month", String(month));
    }
    if (view === "monthly" || view === "yoy") params.set("year", String(year));
    return params.toString();
  }, [view, date, month, year]);

  const [loadedQuery, setLoadedQuery] = useState<string | null>(null);
  const loading = loadedQuery !== query;

  useEffect(() => {
    const controller = new AbortController();

    async function load() {
      try {
        const response = await fetch(`/api/sales-report?${query}`, {
          cache: "no-store",
          signal: controller.signal,
        });
        const data = (await response.json()) as ReportResponse;
        if (!data.configured) {
          setError("Add Shopify credentials to .env.local to connect your store.");
          setBuckets([]);
          setLoadedQuery(query);
          return;
        }
        if (data.error || !data.buckets) {
          setError(data.error ?? "Unable to load sales report");
          setBuckets([]);
          setLoadedQuery(query);
          return;
        }
        setError(null);
        setBuckets(data.buckets);
        setTotal(data.total ?? 0);
        setTitle(data.title ?? "");
        setYoyChangePct(data.yoyChangePct ?? null);
        setCurrentYear(data.currentYear);
        setPriorYear(data.priorYear);
        setLoadedQuery(query);
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setError("Unable to reach the sales report API");
        setLoadedQuery(query);
      }
    }

    void load();
    return () => controller.abort();
  }, [query]);

  const years = useMemo(() => yearOptions(), []);
  const yoyClass =
    yoyChangePct === null || yoyChangePct === undefined
      ? "report-yoy-flat"
      : yoyChangePct > 0
        ? "report-yoy-up"
        : yoyChangePct < 0
          ? "report-yoy-down"
          : "report-yoy-flat";

  return (
    <div className="counter-shell report-shell">
      <div className="counter-frame">
        <div className="counter-panel report-panel">
          <div className="report-toolbar">
            <div className="counter-filter report-view-toggle" role="tablist" aria-label="Report view">
              {VIEW_OPTIONS.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  role="tab"
                  aria-selected={view === option.id}
                  className={`counter-filter-btn${view === option.id ? " counter-filter-btn-active" : ""}`}
                  onClick={() => {
                    setView(option.id);
                    setBuckets([]);
                    setTitle("");
                    setTotal(0);
                    setYoyChangePct(null);
                    setError(null);
                    setLoadedQuery(null);
                  }}
                >
                  {option.label}
                </button>
              ))}
            </div>

            <div className="report-pickers">
              {view === "hourly" && (
                <label className="report-picker">
                  <span>Date</span>
                  <input
                    type="date"
                    value={date}
                    max={todayIso()}
                    onChange={(e) => setDate(e.target.value)}
                  />
                </label>
              )}
              {view === "daily" && (
                <label className="report-picker">
                  <span>Month</span>
                  <select value={month} onChange={(e) => setMonth(Number(e.target.value))}>
                    {MONTHS.map((item) => (
                      <option key={item.value} value={item.value}>
                        {item.label}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {(view === "daily" || view === "monthly" || view === "yoy") && (
                <label className="report-picker">
                  <span>Year</span>
                  <select value={year} onChange={(e) => setYear(Number(e.target.value))}>
                    {years.map((item) => (
                      <option key={item} value={item}>
                        {item}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>
          </div>

          <div className="report-heading">
            <p className="report-kicker">{title || "Sales"}</p>
            <div className="report-total-row">
              <p className="report-total">{loading ? "Loading…" : usd.format(total)}</p>
              {!loading && view === "yoy" && (
                <p className={`report-yoy-change ${yoyClass}`}>
                  {formatYoyChange(yoyChangePct, priorYear)}
                </p>
              )}
            </div>
            {loading && (view === "monthly" || view === "yoy") && (
              <p className="report-kicker">This can take a minute on first load.</p>
            )}
          </div>

          <div className={`report-chart-wrap${loading ? " report-chart-loading" : ""}`}>
            {buckets.length > 0 && (
              <SalesChart
                data={buckets}
                loading={loading}
                yoy={view === "yoy"}
                currentYear={currentYear ?? year}
                priorYear={priorYear ?? year - 1}
              />
            )}
            {!loading && buckets.length === 0 && !error && (
              <p className="report-empty">No sales in this period.</p>
            )}
            {loading && <div className="report-spinner" aria-hidden="true" />}
          </div>

          {error && (
            <p className="counter-status counter-status-error">{error}</p>
          )}
        </div>
      </div>
    </div>
  );
}
