import { describe, expect, it } from "vitest";
import { segmentAt } from "./Dartboard.tsx";

/** A point `r` mm from the bull, `deg` clockwise from the top (SVG y points down). */
const at = (deg: number, r: number) => {
  const a = ((deg - 90) * Math.PI) / 180;
  return segmentAt(r * Math.cos(a), r * Math.sin(a)).segment;
};

describe("segmentAt: which field a finger is on", () => {
  it("finds the rings of the 20", () => {
    expect(at(0, 60)).toEqual({ number: 20, multiplier: 1 });
    expect(at(0, 103)).toEqual({ number: 20, multiplier: 3 });
    expect(at(0, 130)).toEqual({ number: 20, multiplier: 1 });
    expect(at(0, 166)).toEqual({ number: 20, multiplier: 2 });
  });

  it("goes round clockwise: 1 right of the 20, 6 at three o'clock, 3 at the bottom, 11 at nine", () => {
    expect(at(18, 60).number).toBe(1);
    expect(at(90, 60).number).toBe(6);
    expect(at(180, 60).number).toBe(3);
    expect(at(270, 60).number).toBe(11);
    expect(at(198, 103)).toEqual({ number: 19, multiplier: 3 });
  });

  it("knows the bulls and a miss", () => {
    expect(at(0, 3)).toEqual({ number: 25, multiplier: 2 });
    expect(at(45, 12)).toEqual({ number: 25, multiplier: 1 });
    expect(at(0, 190)).toEqual({ number: 0, multiplier: 0 });
  });

  it("splits wedges halfway between numbers", () => {
    expect(at(8.5, 60).number).toBe(20);
    expect(at(9.5, 60).number).toBe(1);
  });
});
