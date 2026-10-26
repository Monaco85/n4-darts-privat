import type { Segment } from "@n4/engine";
import { useState } from "react";
import { TouchDartboard } from "./Dartboard.tsx";

const NUMBERS = Array.from({ length: 20 }, (_, i) => i + 1);
const MULTIPLIERS = [
  { value: 1, label: "Single" },
  { value: 2, label: "Double" },
  { value: 3, label: "Triple" },
] as const;

interface Props {
  title: string;
  /** Above the title, e.g. "Ann · Dart 2". */
  context?: string;
  /** The dart's current value, marked in the grid. */
  current?: Segment;
  onPick(segment: Segment): void;
  onCancel(): void;
}

/**
 * Full-screen picker for correcting a dart: touch the field on the board and release to log it,
 * or pick single/double/triple, then the number.
 */
export function SegmentPicker({ title, context, current, onPick, onCancel }: Props) {
  const start = current && current.number !== 25 && current.multiplier > 0 ? current.multiplier : 1;
  const [multiplier, setMultiplier] = useState<1 | 2 | 3>(start as 1 | 2 | 3);
  const isCurrent = (segment: Segment) =>
    current?.number === segment.number && current.multiplier === segment.multiplier;

  return (
    <div className="overlay" role="dialog" aria-label={title}>
      <div className="picker">
        <div className="picker-head">
          <div>
            {context && <span className="picker-context">{context}</span>}
            <h2>{title}</h2>
          </div>
          <button type="button" className="danger" onClick={onCancel}>
            Cancel
          </button>
        </div>
        <div className="picker-body">
          <div className="picker-board">
            <TouchDartboard onPick={onPick} />
            <p className="picker-board-hint">Press the field, slide, release to log it</p>
          </div>
          <div className="picker-fields">
            <div className="segmented">
              {MULTIPLIERS.map((m) => (
                <button
                  type="button"
                  key={m.value}
                  aria-pressed={multiplier === m.value}
                  onClick={() => setMultiplier(m.value)}
                >
                  {m.label}
                </button>
              ))}
            </div>
            <div className="number-grid">
              {NUMBERS.map((n) => (
                <button
                  type="button"
                  key={n}
                  className={isCurrent({ number: n, multiplier }) ? "current" : ""}
                  onClick={() => onPick({ number: n, multiplier })}
                >
                  {n}
                </button>
              ))}
            </div>
            <div className="picker-extra">
              <button
                type="button"
                className={isCurrent({ number: 25, multiplier: 1 }) ? "current" : ""}
                onClick={() => onPick({ number: 25, multiplier: 1 })}
              >
                25
              </button>
              <button
                type="button"
                className={isCurrent({ number: 25, multiplier: 2 }) ? "current" : ""}
                onClick={() => onPick({ number: 25, multiplier: 2 })}
              >
                Bull
              </button>
              <button
                type="button"
                className={isCurrent({ number: 0, multiplier: 0 }) ? "current" : ""}
                onClick={() => onPick({ number: 0, multiplier: 0 })}
              >
                Miss
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
