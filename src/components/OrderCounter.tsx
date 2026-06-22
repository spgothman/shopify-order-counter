"use client";

import Image from "next/image";
import { useCallback, useEffect, useState } from "react";
import { SplitFlapDisplay, countTiles, salesToTiles } from "./SplitFlapDisplay";

const POLL_INTERVAL_MS = 10000;

type Period = "all" | "today";

interface CountResponse {
  count: number | null;
  configured: boolean;
  error?: string;
}

interface SalesResponse {
  sales: number | null;
  configured: boolean;
  error?: string;
}

function getTodayStartISO(): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

export function OrderCounter() {
  const [count, setCount] = useState(0);
  const [sales, setSales] = useState(0);
  const [period, setPeriod] = useState<Period>("today");
  const [configured, setConfigured] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isCountLoading, setIsCountLoading] = useState(true);
  const [isSalesLoading, setIsSalesLoading] = useState(true);

  const periodParams =
    period === "today"
      ? `?period=today&since=${encodeURIComponent(getTodayStartISO())}`
      : "";

  const fetchCount = useCallback(async () => {
    try {
      const response = await fetch(`/api/count${periodParams}`, { cache: "no-store" });
      const data = (await response.json()) as CountResponse;
      setConfigured(data.configured);
      if (!data.configured) {
        setError("Add Shopify credentials to .env.local to connect your store.");
        return;
      }
      if (data.error || data.count === null) {
        setError(data.error ?? "Unable to load order count");
        return;
      }
      setError(null);
      setCount(data.count);
    } catch {
      setError("Unable to reach the order counter API");
    } finally {
      setIsCountLoading(false);
    }
  }, [periodParams]);

  const fetchSales = useCallback(async () => {
    try {
      const response = await fetch(`/api/sales${periodParams}`, { cache: "no-store" });
      const data = (await response.json()) as SalesResponse;
      if (data.sales !== null) setSales(data.sales);
    } catch {
      // Silently fail — sales row stays at last known value
    } finally {
      setIsSalesLoading(false);
    }
  }, [periodParams]);

  useEffect(() => {
    setIsCountLoading(true);
    setIsSalesLoading(true);
    void fetchCount();
    void fetchSales();
    const interval = window.setInterval(() => {
      void fetchCount();
      void fetchSales();
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [fetchCount, fetchSales]);

  return (
    <div className="counter-shell">
      <div className="counter-frame">
        <div className="counter-panel">
          {/* Period toggle — top left */}
          <div className="counter-filter">
            <button
              className={`counter-filter-btn${period === "all" ? " counter-filter-btn-active" : ""}`}
              onClick={() => setPeriod("all")}
            >
              All Time
            </button>
            <button
              className={`counter-filter-btn${period === "today" ? " counter-filter-btn-active" : ""}`}
              onClick={() => setPeriod("today")}
            >
              Today
            </button>
          </div>

          {/* Shopify mark — top right */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/shopify-logo.png" alt="Shopify" className="counter-shopify-mark" />

          <div className="counter-content">
            <div className="counter-brand">
              <Image
                src="/BPN Logo_Black.png"
                alt="Bare Performance Nutrition"
                width={120}
                height={120}
                priority
                className="counter-brand-logo"
              />
            </div>

            <div className="counter-displays">
              <div className="counter-display-wrap">
                <div className="counter-display-group">
                  <span className="counter-display-label">Orders</span>
                  <SplitFlapDisplay
                    tiles={countTiles(count)}
                    commaAfter={[1, 4]}
                    key={`count-${isCountLoading ? "pre" : "live"}-${period}`}
                  />
                </div>
              </div>
              {period === "today" && (
                <div className="counter-display-wrap">
                  <div className="counter-display-group">
                    <span className="counter-display-label">$ Sales</span>
                    <SplitFlapDisplay
                      tiles={salesToTiles(sales)}
                      commaAfter={[1, 4]}
                      key={`sales-${isSalesLoading ? "pre" : "live"}`}
                    />
                  </div>
                </div>
              )}
            </div>
          </div>

          {error && (
            <p className="counter-status counter-status-error">{error}</p>
          )}
        </div>
      </div>
    </div>
  );
}
