import { describe, expect, it } from "vitest";
import { dartSound } from "./sounds.ts";

describe("dartSound", () => {
  it("picks a sound by where the dart landed", () => {
    expect(dartSound({ number: 20, multiplier: 1 })).toBe("dart");
    expect(dartSound({ number: 20, multiplier: 2 })).toBe("double");
    expect(dartSound({ number: 20, multiplier: 3 })).toBe("triple");
    expect(dartSound({ number: 25, multiplier: 1 })).toBe("double");
    expect(dartSound({ number: 25, multiplier: 2 })).toBe("bull");
    expect(dartSound({ number: 0, multiplier: 0 })).toBe("miss");
  });
});
