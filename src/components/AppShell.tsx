"use client";

import { useState } from "react";
import { OrderCounter } from "./OrderCounter";
import { SalesReport } from "./SalesReport";

type Tab = "counter" | "report";

export function AppShell() {
  const [tab, setTab] = useState<Tab>("counter");

  return (
    <main className={`app-page${tab === "report" ? " app-page-report" : ""}`}>
      <nav className="app-tabs" aria-label="App sections">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "counter"}
          className={`app-tab${tab === "counter" ? " app-tab-active" : ""}`}
          onClick={() => setTab("counter")}
        >
          Live Counter
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "report"}
          className={`app-tab${tab === "report" ? " app-tab-active" : ""}`}
          onClick={() => setTab("report")}
        >
          Sales Report
        </button>
      </nav>
      <div className="app-content">
        {tab === "counter" ? <OrderCounter /> : <SalesReport />}
      </div>
    </main>
  );
}
