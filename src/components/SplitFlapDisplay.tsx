"use client";

import { SplitFlapDigit } from "./SplitFlapDigit";

const SPIN_STAGGER_MS = 45;

interface SplitFlapDisplayProps {
  tiles: string[];
  /** Tile indices after which to render a visual comma (not a tile) */
  commaAfter?: number[];
  /** Stretch to fill container width, spreading tiles evenly */
  stretch?: boolean;
  /** Pass false to suppress the spin-in animation on mount (used for loading placeholders) */
  animate?: boolean;
}

export function SplitFlapDisplay({ tiles, commaAfter = [], stretch = false, animate = true }: SplitFlapDisplayProps) {
  let numericIndex = 0;

  return (
    <div
      className={`split-flap-display${stretch ? " split-flap-display--stretch" : ""}`}
      aria-live="polite"
      aria-atomic="true"
    >
      {tiles.map((tile, index) => {
        const isNumeric = tile >= "0" && tile <= "9";
        const delay = isNumeric ? numericIndex++ * SPIN_STAGGER_MS : 0;
        return (
          <div key={index} className="split-flap-tile-wrap">
            <SplitFlapDigit digit={tile} spinDelay={delay} animate={animate} />
            {commaAfter.includes(index) && (
              <span className="split-flap-comma" aria-hidden="true">,</span>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Tile formatters ────────────────────────────────────────────────────────────

export function countTiles(count: number): string[] {
  return Math.max(0, count).toString().padStart(8, "0").split("");
}

/**
 * Returns 8 tiles: [$][X][X][X][X][X][X][X]
 * Caller should pass commaAfter={[1, 4]} to get $X,XXX,XXX visually.
 */
export function salesToTiles(amount: number): string[] {
  const n = Math.max(0, Math.round(amount)).toString().padStart(7, "0");
  return ["$", n[0], n[1], n[2], n[3], n[4], n[5], n[6]];
}
