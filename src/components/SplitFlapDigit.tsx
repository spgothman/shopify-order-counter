"use client";

import { useCallback, useEffect, useRef, useState } from "react";

interface SplitFlapDigitProps {
  digit: string;
  spinDelay?: number;
}

const FLIP_MS = 520;
const SPIN_MS = 90;
const TIMER_BUFFER_MS = 25;

function isNumeric(d: string): boolean {
  return d >= "0" && d <= "9";
}

function buildSpinSequence(target: string): string[] {
  const n = parseInt(target, 10);
  if (isNaN(n)) return [];
  return Array.from({ length: 10 }, (_, i) => String((n + 1 + i) % 10));
}

export function SplitFlapDigit({ digit, spinDelay = 0 }: SplitFlapDigitProps) {
  // Non-numeric tiles ($ , etc.) start showing immediately
  const [shown, setShown] = useState(() => (isNumeric(digit) ? "0" : digit));
  const [next, setNext] = useState(() => (isNumeric(digit) ? "0" : digit));
  const [flipping, setFlipping] = useState(false);
  const [flipMs, setFlipMs] = useState(FLIP_MS);

  const busyRef = useRef(false);
  const queueRef = useRef<Array<{ d: string; ms: number }>>([]);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastQueuedRef = useRef(isNumeric(digit) ? "0" : digit);

  const flush = useCallback(() => {
    if (busyRef.current || queueRef.current.length === 0) return;
    const item = queueRef.current.shift()!;
    busyRef.current = true;

    if (item.ms < FLIP_MS) {
      setShown(item.d);
      timerRef.current = setTimeout(() => {
        busyRef.current = false;
        flush();
      }, item.ms);
    } else {
      setNext(item.d);
      setFlipMs(item.ms);
      setFlipping(true);
      timerRef.current = setTimeout(() => {
        setShown(item.d);
        setFlipping(false);
        busyRef.current = false;
        flush();
      }, item.ms + TIMER_BUFFER_MS);
    }
  }, []);

  const enqueue = useCallback(
    (items: Array<{ d: string; ms: number }>) => {
      queueRef.current.push(...items);
      flush();
    },
    [flush],
  );

  // Spin-in on mount (numeric digits only)
  useEffect(() => {
    if (!isNumeric(digit)) {
      lastQueuedRef.current = digit;
      return;
    }

    lastQueuedRef.current = digit;
    const seq = buildSpinSequence(digit);
    const delayTimer = setTimeout(() => {
      enqueue(
        seq.map((d, i) => ({
          d,
          ms: i === seq.length - 1 ? FLIP_MS : SPIN_MS,
        })),
      );
    }, spinDelay);
    return () => clearTimeout(delayTimer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Normal flip for subsequent prop changes
  useEffect(() => {
    if (digit === lastQueuedRef.current) return;
    lastQueuedRef.current = digit;
    enqueue([{ d: digit, ms: FLIP_MS }]);
  }, [digit, enqueue]);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  return (
    <div
      className="split-flap-digit"
      aria-label={shown}
      style={{ "--flip-ms": `${flipMs}ms` } as React.CSSProperties}
    >
      <div className="split-flap-static">
        <div className="split-flap-half split-flap-half-top">
          <span>{shown}</span>
        </div>
        <div className="split-flap-half split-flap-half-bottom">
          <span>{shown}</span>
        </div>
        <div className="split-flap-seam" />
      </div>

      {flipping && (
        <>
          <div className="split-flap-half split-flap-half-bottom split-flap-underlay">
            <span>{next}</span>
          </div>
          <div className="split-flap-flip split-flap-flip-top">
            <div className="split-flap-half split-flap-half-top">
              <span>{shown}</span>
            </div>
          </div>
          <div className="split-flap-flip split-flap-flip-bottom">
            <div className="split-flap-half split-flap-half-bottom">
              <span>{next}</span>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
