"use client";

/**
 * Pixel's voice: tiny 8-bit cues synthesised with Web Audio (no audio files, nothing to license).
 * Every Pixel has its own pitch (younger = higher, plus a per-name offset). Off with one toggle,
 * remembered in localStorage. Browsers only allow audio after a user gesture: until then cues are skipped.
 */
import { useEffect, useState } from "react";

export type Cue =
  | "hello" | "happy" | "surprised" | "sleepy" | "proud" | "curious" | "poke"
  | "levelup" | "grow" | "hatch" | "done" | "click" | "oops";

type Note = { f: number; to?: number; ms: number; type?: OscillatorType; gap?: number; vol?: number };

const C5 = 523.25, E5 = 659.25, G5 = 783.99, C6 = 1046.5, G4 = 392, A5 = 880, D5 = 587.33;

const CUES: Record<Cue, Note[]> = {
  hello: [{ f: 660, ms: 60 }, { f: 880, ms: 80, gap: 20 }],
  happy: [{ f: C5, ms: 70 }, { f: E5, ms: 70 }, { f: G5, ms: 120 }],
  surprised: [{ f: 420, to: 1250, ms: 110, type: "square", vol: 0.7 }, { f: 1250, ms: 50, gap: 30 }],
  sleepy: [{ f: 520, to: 260, ms: 650, type: "sine", vol: 0.7 }],
  proud: [{ f: G4, ms: 90 }, { f: C5, ms: 90 }, { f: E5, ms: 90 }, { f: G5, ms: 260 }],
  curious: [{ f: 520, to: 720, ms: 140, type: "sine" }, { f: 700, to: 640, ms: 120, gap: 40, type: "sine" }],
  poke: [{ f: 260, to: 620, ms: 90, type: "square", vol: 0.6 }, { f: 620, to: 300, ms: 140, type: "square", vol: 0.6 }],
  levelup: [{ f: C5, ms: 70 }, { f: E5, ms: 70 }, { f: G5, ms: 70 }, { f: C6, ms: 220 }],
  grow: [{ f: G5, ms: 60 }, { f: C6, ms: 60 }, { f: E5 * 2, ms: 60 }, { f: G5 * 2, ms: 300, type: "sine" }],
  hatch: [{ f: 180, to: 90, ms: 60, type: "sawtooth", vol: 0.5 }, { f: D5, ms: 70, gap: 60 }, { f: A5, ms: 140 }],
  done: [{ f: G5, ms: 110, type: "sine" }, { f: C6, ms: 260, type: "sine" }],
  click: [{ f: 1200, ms: 25, type: "square", vol: 0.35 }],
  oops: [{ f: 440, to: 330, ms: 160, type: "triangle" }, { f: 330, to: 250, ms: 220, type: "triangle" }],
};

const KEY = "kweeto-sound";
const EVENT = "kweeto-sound-change";
const MASTER = 0.07;
let ctx: AudioContext | null = null;
let unlocked = false;
let lastAt = 0;

export function soundEnabled(): boolean {
  try { return localStorage.getItem(KEY) !== "off"; } catch { return true; }
}

export function setSoundEnabled(on: boolean) {
  try { localStorage.setItem(KEY, on ? "on" : "off"); } catch { /* ignore */ }
  window.dispatchEvent(new Event(EVENT));
  if (on) play("hello");
}

export function useSoundEnabled(): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(true);
  useEffect(() => {
    setOn(soundEnabled());
    const f = () => setOn(soundEnabled());
    window.addEventListener(EVENT, f);
    return () => window.removeEventListener(EVENT, f);
  }, []);
  return [on, setSoundEnabled];
}

function audio(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (!ctx) {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
  }
  return ctx;
}

// audio may only start after a user gesture
if (typeof window !== "undefined") {
  const unlock = () => {
    unlocked = true;
    audio()?.resume().catch(() => undefined);
    window.removeEventListener("pointerdown", unlock);
    window.removeEventListener("keydown", unlock);
  };
  window.addEventListener("pointerdown", unlock);
  window.addEventListener("keydown", unlock);
}

/** A Pixel's voice: younger Pixels speak higher; the name gives each one a slightly different timbre. */
export function voiceOf(name: string, level: number): number {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const age = level <= 2 ? 1.35 : level <= 4 ? 1.2 : level <= 6 ? 1.08 : level <= 9 ? 1 : 0.92;
  return age * (0.92 + ((h % 17) / 16) * 0.16);
}

/** Plays a cue. `pitch` multiplies every frequency; `minGapMs` avoids a cacophony (field chats). */
export function play(cue: Cue, opts: { pitch?: number; minGapMs?: number } = {}) {
  if (!unlocked || !soundEnabled()) return;
  const now = performance.now();
  if (opts.minGapMs && now - lastAt < opts.minGapMs) return;
  lastAt = now;
  const ac = audio();
  if (!ac) return;
  const pitch = opts.pitch ?? 1;
  let t = ac.currentTime + 0.01;
  for (const n of CUES[cue]) {
    t += (n.gap ?? 0) / 1000;
    const dur = n.ms / 1000;
    const osc = ac.createOscillator();
    const g = ac.createGain();
    osc.type = n.type ?? "triangle";
    osc.frequency.setValueAtTime(n.f * pitch, t);
    if (n.to) osc.frequency.exponentialRampToValueAtTime(n.to * pitch, t + dur);
    const v = MASTER * (n.vol ?? 1);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(v, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g).connect(ac.destination);
    osc.start(t);
    osc.stop(t + dur + 0.02);
    t += dur;
  }
}
