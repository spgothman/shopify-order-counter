"use client";

import { useState, useEffect, type ReactNode } from "react";

const PASSWORD = "goonemore";
const STORAGE_KEY = "order-counter-auth";

export function PasswordGate({ children }: { children: ReactNode }) {
  const [authed, setAuthed] = useState(false);
  const [checked, setChecked] = useState(false);
  const [input, setInput] = useState("");
  const [error, setError] = useState(false);

  useEffect(() => {
    if (localStorage.getItem(STORAGE_KEY) === "1") {
      setAuthed(true);
    }
    setChecked(true);
  }, []);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (input === PASSWORD) {
      localStorage.setItem(STORAGE_KEY, "1");
      setAuthed(true);
      setError(false);
    } else {
      setError(true);
      setInput("");
    }
  }

  if (!checked) return null;
  if (authed) return <>{children}</>;

  return (
    <main className="counter-page">
      <div className="counter-shell">
        <div className="counter-frame">
          <div className="counter-panel pw-panel">
            <p className="pw-label">Enter password to continue</p>
            <form onSubmit={handleSubmit} className="pw-form">
              <input
                className="pw-input"
                type="password"
                value={input}
                onChange={(e) => {
                  setInput(e.target.value);
                  setError(false);
                }}
                placeholder="••••••••••"
                autoFocus
                autoComplete="current-password"
              />
              <button type="submit" className="pw-btn">
                Enter
              </button>
            </form>
            {error && (
              <p className="pw-error">Incorrect password — try again.</p>
            )}
          </div>
        </div>
      </div>
    </main>
  );
}
