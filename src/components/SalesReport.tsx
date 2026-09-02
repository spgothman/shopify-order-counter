"use client";

import dynamic from "next/dynamic";
import { useEffect, useMemo, useState } from "react";

type SalesReportView = "hourly" | "daily" | "monthly";

const SalesChart = dynamic(
  () => import("./SalesChart").then((mod) => mod.SalesChart),
  { ssr: false },
);

interface ReportResponse {
  view?: SalesReportView;
  title?: string;
  buckets: Array<{ label: string; sales: number }> | null;
  total?: number;
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

export function SalesReport() {
  const now = useMemo(() => new Date(), []);
  const [view, setView] = useState<SalesReportView>("hourly");
  const [date, setDate] = useState(todayIso);
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [year, setYear] = useState(now.getFullYear());
  const [title, setTitle] = useState("");
  const [total, setTotal] = useState(0);
  const [buckets, setBuckets] = useState<Array<{ label: string; sales: number }>>([]);
  const [error, setError] = useState<string | null>(null);

  const query = useMemo(() => {
    const params = new URLSearchParams({ view });
    if (view === "hourly") params.set("date", date);
    if (view === "daily") {
      params.set("year", String(year));
      params.set("month", String(month));
    }
    if (view === "monthly") params.set("year", String(year));
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

  return (
    <div className="counter-shell report-shell">
      <div className="counter-frame">
        <div className="counter-panel report-panel">
          <div className="report-toolbar">
            <div className="counter-filter report-view-toggle" role="tablist" aria-label="Report view">
              {(["hourly", "daily", "monthly"] as const).map((option) => (
                <button
                  key={option}
                  type="button"
                  role="tab"
                  aria-selected={view === option}
                  className={`counter-filter-btn${view === option ? " counter-filter-btn-active" : ""}`}
                  onClick={() => {
                    setView(option);
                    setBuckets([]);
                    setTitle("");
                    setTotal(0);
                    setError(null);
                    setLoadedQuery(null);
                  }}
                >
                  {option[0].toUpperCase() + option.slice(1)}
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
              {(view === "daily" || view === "monthly") && (
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
            <p className="report-total">{loading ? "Loading…" : usd.format(total)}</p>
            {loading && view === "monthly" && (
              <p className="report-kicker">This can take a minute for a full year.</p>
            )}
          </div>

          <div className={`report-chart-wrap${loading ? " report-chart-loading" : ""}`}>
            {buckets.length > 0 && <SalesChart data={buckets} loading={loading} />}
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
