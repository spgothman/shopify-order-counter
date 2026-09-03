"use client";

import dynamic from "next/dynamic";
import { useEffect, useMemo, useState } from "react";

type SalesReportView = "hourly" | "daily" | "monthly";
type CustomerType = "both" | "new" | "returning";
type ChannelMode = "dtc" | "retail";

const VIEW_OPTIONS: Array<{ id: SalesReportView; label: string }> = [
  { id: "hourly", label: "Hourly" },
  { id: "daily", label: "Daily" },
  { id: "monthly", label: "Monthly" },
];

const CUSTOMER_TYPE_OPTIONS: Array<{ id: CustomerType; label: string }> = [
  { id: "both", label: "Both" },
  { id: "new", label: "New" },
  { id: "returning", label: "Returning" },
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
  warning?: string;
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
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
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

function formatYoyChange(pct: number | null | undefined): string {
  if (pct === null || pct === undefined) return "n/a";
  const sign = pct > 0 ? "+" : "";
  return `${sign}${pct.toFixed(1)}%`;
}

export function SalesReport() {
  const now = useMemo(() => new Date(), []);
  const [view, setView] = useState<SalesReportView>("hourly");
  const [compare, setCompare] = useState(false);
  const [channelMode, setChannelMode] = useState<ChannelMode>("dtc");
  const [customerType, setCustomerType] = useState<CustomerType>("both");
  const [date, setDate] = useState(todayIso);
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [year, setYear] = useState(now.getFullYear());
  const [title, setTitle] = useState("");
  const [total, setTotal] = useState(0);
  const [priorTotal, setPriorTotal] = useState(0);
  const [yoyChangePct, setYoyChangePct] = useState<number | null>(null);
  const [currentYear, setCurrentYear] = useState<number | undefined>();
  const [priorYear, setPriorYear] = useState<number | undefined>();
  const [buckets, setBuckets] = useState<Array<{ label: string; sales: number; priorSales?: number }>>([]);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);

  const query = useMemo(() => {
    const params = new URLSearchParams({ view });
    if (view === "hourly") params.set("date", date);
    if (view === "daily") {
      params.set("year", String(year));
      params.set("month", String(month));
    }
    if (view === "monthly") params.set("year", String(year));
    if (compare) params.set("compare", "1");
    if (customerType !== "both") params.set("customerType", customerType);
    if (channelMode !== "dtc") params.set("channelMode", channelMode);
    return params.toString();
  }, [view, date, month, year, compare, customerType, channelMode]);

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
          setWarning(null);
          setLoadedQuery(query);
          return;
        }
        if (data.error || !data.buckets) {
          setError(data.error ?? "Unable to load sales report");
          setBuckets([]);
          setWarning(null);
          setLoadedQuery(query);
          return;
        }
        setError(null);
        setBuckets(data.buckets);
        setTotal(data.total ?? 0);
        setPriorTotal(data.priorTotal ?? 0);
        setTitle(data.title ?? "");
        setYoyChangePct(data.yoyChangePct ?? null);
        setCurrentYear(data.currentYear);
        setPriorYear(data.priorYear);
        setWarning(data.warning ?? null);
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
                    setPriorTotal(0);
                    setYoyChangePct(null);
                    setError(null);
                    setWarning(null);
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
              <button
                type="button"
                className={`report-compare-btn${compare ? " report-compare-btn-active" : ""}`}
                aria-pressed={compare}
                onClick={() => setCompare((on) => !on)}
              >
                Compare YoY
              </button>

              <div className="report-channel-toggle" role="radiogroup" aria-label="Channel mode">
                <button
                  type="button"
                  role="radio"
                  aria-checked={channelMode === "dtc"}
                  className={`report-channel-btn${channelMode === "dtc" ? " report-channel-btn-active" : ""}`}
                  onClick={() => setChannelMode("dtc")}
                >
                  DTC
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={channelMode === "retail"}
                  className={`report-channel-btn${channelMode === "retail" ? " report-channel-btn-active" : ""}`}
                  onClick={() => setChannelMode("retail")}
                >
                  Retail
                </button>
              </div>

              <div className="report-pill-toggle" role="radiogroup" aria-label="Customer type">
                <span
                  className="report-pill-slider"
                  style={{
                    transform: `translateX(${CUSTOMER_TYPE_OPTIONS.findIndex((o) => o.id === customerType) * 100}%)`,
                  }}
                />
                {CUSTOMER_TYPE_OPTIONS.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    role="radio"
                    aria-checked={customerType === option.id}
                    className={`report-pill-option${customerType === option.id ? " report-pill-option-active" : ""}`}
                    onClick={() => setCustomerType(option.id)}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="report-heading">
            <p className="report-kicker">{title || "Sales"}</p>
            <div className="report-total-row">
              {loading ? (
                <p className="report-total">Loading…</p>
              ) : (
                <>
                  <p className="report-total">
                    {usd.format(total)}
                    {compare && currentYear != null && (
                      <span className="report-year-tag">{currentYear}</span>
                    )}
                  </p>
                  {compare && (
                    <>
                      <p className="report-total report-total-prior">
                        {usd.format(priorTotal)}
                        {priorYear != null && <span className="report-year-tag">{priorYear}</span>}
                      </p>
                      <p className={`report-yoy-change ${yoyClass}`}>
                        {formatYoyChange(yoyChangePct)}
                      </p>
                    </>
                  )}
                </>
              )}
            </div>
          </div>

          <div
            className={`report-chart-wrap${loading ? " report-chart-loading" : ""}`}
            aria-busy={loading}
          >
            {buckets.length > 0 && (
              <SalesChart
                data={buckets}
                loading={loading}
                yoy={compare}
                currentYear={currentYear ?? year}
                priorYear={priorYear ?? year - 1}
              />
            )}
            {!loading && buckets.length === 0 && !error && (
              <p className="report-empty">No sales in this period.</p>
            )}
            {loading && (
              <div className="report-loading-overlay" role="status" aria-live="polite">
                <div className="report-spinner" aria-hidden="true" />
                <p className="report-loading-copy">Loading sales…</p>
                <p className="report-loading-hint">
                  {compare ? "Fetching this year and last year…" : "Fetching orders for this period…"}
                </p>
              </div>
            )}
          </div>

          {warning && compare && !loading && (
            <p className="report-warning">{warning}</p>
          )}
          {error && (
            <p className="counter-status counter-status-error">{error}</p>
          )}
        </div>
      </div>
    </div>
  );
}
