// Sounds on the station, made with Web Audio (no sound files, works offline): a hit for every
// dart, a chime when the next player is up, a buzz on a bust and a fanfare for game shot.
// Switched on and off per screen; the choice is remembered in this browser.

import type { MatchView } from "@n4/server/api";
import { useCallback, useEffect, useRef, useState } from "react";

const KEY = "n4-sound";

function readSetting(): boolean {
  try {
    return localStorage.getItem(KEY) !== "off";
  } catch {
    return true;
  }
}

function writeSetting(on: boolean) {
  try {
    localStorage.setItem(KEY, on ? "on" : "off");
  } catch {}
}

let context: AudioContext | null = null;

/** The shared AudioContext; browsers only let it play after a tap, so every tap resumes it. */
function audio(): AudioContext | null {
  if (typeof window === "undefined" || !("AudioContext" in window)) return null;
  context ??= new AudioContext();
  if (context.state === "suspended") void context.resume();
  return context;
}

/** One tone with a quick attack and a decay. */
function tone(
  ctx: AudioContext,
  frequency: number,
  start: number,
  length: number,
  options: { type?: OscillatorType; volume?: number; slideTo?: number } = {},
) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = options.type ?? "sine";
  osc.frequency.setValueAtTime(frequency, start);
  if (options.slideTo) osc.frequency.exponentialRampToValueAtTime(options.slideTo, start + length);
  const volume = options.volume ?? 0.3;
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(volume, start + 0.008);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + length);
  osc.connect(gain).connect(ctx.destination);
  osc.start(start);
  osc.stop(start + length + 0.02);
}

/** A short burst of noise: the dart going into the sisal. */
function thud(ctx: AudioContext, start: number, volume = 0.5) {
  const length = 0.09;
  const buffer = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * length), ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++)
    data[i] = (Math.random() * 2 - 1) * (1 - i / data.length) ** 3;
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  const filter = ctx.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.value = 1800;
  const gain = ctx.createGain();
  gain.gain.value = volume;
  source.connect(filter).connect(gain).connect(ctx.destination);
  source.start(start);
  tone(ctx, 140, start, 0.12, { volume: volume * 0.6, slideTo: 70 });
}

export type SoundName = "dart" | "double" | "triple" | "bull" | "miss" | "next" | "bust" | "win";

export function play(name: SoundName) {
  // Announced on the page too, so a test (or a later display) can follow along.
  window.dispatchEvent(new CustomEvent("n4-sound", { detail: name }));
  const ctx = audio();
  if (!ctx) return;
  const t = ctx.currentTime + 0.01;
  switch (name) {
    case "dart":
      thud(ctx, t);
      break;
    case "double":
      thud(ctx, t);
      tone(ctx, 880, t + 0.05, 0.18, { type: "triangle", volume: 0.18 });
      break;
    case "triple":
      thud(ctx, t);
      tone(ctx, 988, t + 0.05, 0.14, { type: "triangle", volume: 0.2 });
      tone(ctx, 1319, t + 0.13, 0.2, { type: "triangle", volume: 0.2 });
      break;
    case "bull":
      thud(ctx, t);
      tone(ctx, 1047, t + 0.05, 0.12, { type: "triangle", volume: 0.2 });
      tone(ctx, 1319, t + 0.12, 0.12, { type: "triangle", volume: 0.2 });
      tone(ctx, 1568, t + 0.19, 0.25, { type: "triangle", volume: 0.2 });
      break;
    case "miss":
      tone(ctx, 220, t, 0.18, { type: "sine", volume: 0.25, slideTo: 110 });
      break;
    case "next":
      tone(ctx, 660, t, 0.16, { volume: 0.28 });
      tone(ctx, 990, t + 0.14, 0.32, { volume: 0.28 });
      break;
    case "bust":
      tone(ctx, 196, t, 0.22, { type: "sawtooth", volume: 0.12 });
      tone(ctx, 147, t + 0.2, 0.35, { type: "sawtooth", volume: 0.12 });
      break;
    case "win":
      [523, 659, 784, 1047].forEach((f, i) => {
        tone(ctx, f, t + i * 0.13, 0.22, { type: "triangle", volume: 0.22 });
      });
      tone(ctx, 1047, t + 0.55, 0.7, { type: "triangle", volume: 0.22 });
      tone(ctx, 1319, t + 0.55, 0.7, { type: "triangle", volume: 0.16 });
      break;
  }
}

/** The sound for one dart, by where it landed. */
export function dartSound(segment: { number: number; multiplier: number }): SoundName {
  if (segment.multiplier === 0) return "miss";
  if (segment.number === 25) return segment.multiplier === 2 ? "bull" : "double";
  if (segment.multiplier === 3) return "triple";
  if (segment.multiplier === 2) return "double";
  return "dart";
}

/** The on/off switch, remembered in this browser. */
export function useSoundSetting() {
  const [on, setOn] = useState(readSetting);
  const toggle = useCallback(() => {
    const now = !on;
    writeSetting(now);
    setOn(now);
    if (now) {
      // The tap that switches it on also unlocks audio; play something so it's clear.
      audio();
      play("next");
    }
  }, [on]);
  // Any tap on the page unlocks audio for later darts (browsers need a gesture first).
  useEffect(() => {
    const unlock = () => {
      if (readSetting()) audio();
    };
    window.addEventListener("pointerdown", unlock);
    return () => window.removeEventListener("pointerdown", unlock);
  }, []);
  return { on, toggle };
}

/**
 * Plays the match's sounds as its view changes: a new dart, the next player's turn, a bust and
 * the win. Nothing plays for what was already there when the page opened.
 */
export function useMatchSounds(match: MatchView | null, on: boolean) {
  const seen = useRef<{
    matchId: string | null;
    darts: Set<string>;
    turn: string;
    phase: string;
  } | null>(null);

  useEffect(() => {
    if (!match) {
      seen.current = null;
      return;
    }
    const { state } = match;
    const darts = state.currentVisit?.darts ?? [];
    const turn = `${state.legs.length}:${state.legs.at(-1)?.visits.length ?? 0}:${state.currentPlayer}`;
    const before = seen.current;
    seen.current = {
      matchId: match.id,
      darts: new Set(darts.map((d) => d.dartId)),
      turn,
      phase: state.phase,
    };
    if (!on || !before || before.matchId !== match.id) return;

    if (state.phase === "matchWon" && before.phase !== "matchWon") {
      play("win");
      return;
    }
    const fresh = darts.filter((d) => !before.darts.has(d.dartId) && !d.ignored);
    const last = fresh.at(-1);
    if (last) {
      play(state.currentVisit?.bust ? "bust" : dartSound(last.segment));
      return;
    }
    if (turn !== before.turn && state.phase === "throwing" && darts.length === 0) play("next");
  }, [match, on]);
}
