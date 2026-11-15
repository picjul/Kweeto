"use client";

import dynamic from "next/dynamic";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";

import { EYE_COLORS, pixelColors, usePixelTraits, useProject } from "@/components/project-context";
import type { PixelShape, PixelTraits } from "@/lib/api";
import { cn } from "@/lib/utils";

export type PixelMood = "idle" | "happy" | "curious" | "thinking" | "surprised" | "sleepy" | "proud";

const MOOD_LABEL: Record<PixelMood, string> = {
  idle: "calm", happy: "happy", curious: "curious", thinking: "thinking",
  surprised: "surprised", sleepy: "sleepy", proud: "proud",
};

const EYE = "#67e8f9";

type BodyBox = { x: number; y: number; w: number; h: number; rx: number };

// ---------- growth: each Pixel grows up with its level (= the examples you taught it) ----------

export type PixelStage = "baby" | "child" | "teen" | "adult" | "master";

export const STAGES: Record<PixelStage, { label: string; scale: number; eyes: number; from: number }> = {
  baby: { label: "Baby", scale: 0.6, eyes: 1.28, from: 1 },
  child: { label: "Child", scale: 0.74, eyes: 1.14, from: 3 },
  teen: { label: "Teen", scale: 0.87, eyes: 1.05, from: 5 },
  adult: { label: "Adult", scale: 1, eyes: 1, from: 7 },
  master: { label: "Sage", scale: 1.04, eyes: 1, from: 10 },
};

export function stageOf(level: number): PixelStage {
  if (level >= 10) return "master";
  if (level >= 7) return "adult";
  if (level >= 5) return "teen";
  if (level >= 3) return "child";
  return "baby";
}
/** Body silhouettes: all share the feet line (y=111) and leave room for the face screen. */
const BODY: Record<PixelShape, BodyBox> = {
  round: { x: 18, y: 27, w: 84, h: 84, rx: 30 },
  square: { x: 18, y: 27, w: 84, h: 84, rx: 14 },
  blob: { x: 12, y: 34, w: 96, h: 77, rx: 38 },
  tall: { x: 25, y: 20, w: 70, h: 91, rx: 24 },
};
// pixel "sprout" on the head: grows with the level
const SPROUT: [number, number, string][] = [
  [56, 8, "#a78bfa"], [64, 1, "#fbbf24"], [48, 1, "#f472b6"], [56, -7, "#34d399"],
];

// ---------- 3D: big avatars get a real body (three.js), loaded lazily; the SVG is the placeholder and the fallback ----------

const Pixel3DCanvas = dynamic(() => import("@/components/pixel3d").then((m) => m.Pixel3DCanvas), { ssr: false });
/** below this size the SVG reads better (and saves a WebGL context) */
const MIN_3D_SIZE = 72;
/** browsers cap live WebGL contexts (~16): beyond this many 3D avatars, the rest stay SVG */
const MAX_3D = 8;
let live3d = 0;

function use3d(want: boolean) {
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (!want || live3d >= MAX_3D) return;
    let cancelled = false;
    live3d++;
    import("@/components/pixel3d").then((m) => { if (!cancelled && m.hasWebGL()) setOn(true); });
    return () => { cancelled = true; live3d--; setOn(false); };
  }, [want]);
  return on;
}

/** Eyes follow the pointer (max ~3.5px offset). */
function useGaze(ref: React.RefObject<SVGSVGElement | null>, enabled: boolean) {
  const [gaze, setGaze] = useState({ x: 0, y: 0 });
  useEffect(() => {
    if (!enabled) return;
    let frame = 0;
    const onMove = (e: PointerEvent) => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const el = ref.current;
        if (!el) return;
        const r = el.getBoundingClientRect();
        const dx = e.clientX - (r.left + r.width / 2);
        const dy = e.clientY - (r.top + r.height * 0.55);
        const d = Math.hypot(dx, dy) || 1;
        const k = Math.min(1, d / 260) * 3.5;
        setGaze({ x: (dx / d) * k, y: (dy / d) * k });
      });
    };
    window.addEventListener("pointermove", onMove);
    return () => {
      window.removeEventListener("pointermove", onMove);
      cancelAnimationFrame(frame);
    };
  }, [ref, enabled]);
  return gaze;
}

/** Pixel, the apprentice. SVG character with expressions, gaze tracking and light animations. */
export function PixelAvatar({
  mood = "idle", level: levelProp, size = 64, animated = true, track = true, bounce = 0, onPoke, className, traits, render = "auto",
  activity = null,
}: {
  /** a workout (while a detector trains): dumbbells or running on the spot; 3D only, the SVG just bounces */
  activity?: "lift" | "run" | null;
  /** "auto" = 3D from 72 px up (when WebGL is available), "2d" = always the SVG, "3d" = 3D at any size */
  render?: "auto" | "2d" | "3d";
  /** look of this Pixel; defaults to the active project's Pixel */
  traits?: PixelTraits;
  mood?: PixelMood;
  /** drives the growth stage; defaults to the open project's level (pass it for other projects' Pixels) */
  level?: number;
  size?: number;
  animated?: boolean;
  /** eyes follow the pointer */
  track?: boolean;
  /** change this number to make Pixel jump */
  bounce?: number;
  /** makes Pixel clickable ("poke") */
  onPoke?: () => void;
  className?: string;
}) {
  const id = useId().replace(/[^a-zA-Z0-9]/g, "");
  const projectTraits = usePixelTraits();
  const { options, activeBoxes } = useProject();
  const t = traits ?? projectTraits;
  const level = levelProp ?? (traits ? 7 : levelFromBoxes(activeBoxes));
  const stage = STAGES[stageOf(level)];
  const grow = `translate(60 113) scale(${stage.scale}) translate(-60 -113)`;
  const col = pixelColors(t, options);
  const eye = EYE_COLORS[t.eyes] ?? EYE;
  const B = BODY[t.shape] ?? BODY.round;
  const screenX = Math.max(29, B.x + 11);
  const svgRef = useRef<SVGSVGElement>(null);
  const three = use3d(render === "3d" || (render === "auto" && size >= MIN_3D_SIZE));
  const [ready3d, setReady3d] = useState(false);
  useEffect(() => { if (!three) setReady3d(false); }, [three]);
  const [reduced, setReduced] = useState(false);
  useEffect(() => { setReduced(!!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches); }, []);
  const [pokes, setPokes] = useState(0);
  const gaze = useGaze(svgRef, animated && track && mood !== "sleepy" && !ready3d);
  const [anim, setAnim] = useState<"" | "pixel-jump" | "pixel-squish">("");
  const tilt = mood === "curious" ? -8 : mood === "thinking" ? 6 : 0;
  const sprouts = Math.min(SPROUT.length, 1 + Math.floor((level - 1) / 2));
  const a = (cls: string) => (animated ? cls : undefined);

  useEffect(() => {
    if (!bounce || !animated || three) return;
    setAnim("pixel-jump");
    const t = setTimeout(() => setAnim(""), 1450);
    return () => clearTimeout(t);
  }, [bounce, animated, three]);

  const poke = () => {
    if (!onPoke) return;
    onPoke();
    if (three) { setPokes((n) => n + 1); return; }
    setAnim("");
    requestAnimationFrame(() => setAnim("pixel-squish"));
    setTimeout(() => setAnim(""), 480);
  };

  return (
    <span
      className={cn("relative inline-block shrink-0 select-none", onPoke && "cursor-pointer", anim, className)}
      style={{ transformOrigin: "50% 95%" }}
      onClick={poke}
      role={onPoke ? "button" : undefined}
      tabIndex={onPoke ? 0 : undefined}
      onKeyDown={(e) => { if (onPoke && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); poke(); } }}
      title={onPoke ? "Poke Pixel" : undefined}
    >
      {/* body language of the mood (inner wrapper, so it never fights with jump/squish on the outer one) */}
      {three && (
        <span role="img" aria-label={`${t.name}, ${MOOD_LABEL[mood]}`}
          className={cn("absolute inset-0 transition-opacity duration-300", ready3d ? "opacity-100" : "opacity-0")}>
          <Pixel3DCanvas traits={t} options={options} level={level} mood={mood} bounce={bounce} poke={pokes}
            track={track} animated={animated && !reduced} onReady={() => setReady3d(true)} activity={activity} />
        </span>
      )}
      <span key={mood} className={cn("block", animated && !three && (activity ? "pixel-walk" : `mood-${mood}`), ready3d && "invisible")} style={{ transformOrigin: "50% 92%" }}>
      <svg ref={svgRef} viewBox="0 0 120 124" width={size} height={(size * 124) / 120} role="img"
        aria-label={`${t.name}, ${MOOD_LABEL[mood]}`} aria-hidden={ready3d || undefined} className="block overflow-visible">
        <defs>
          <linearGradient id={`${id}b`} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor={col.light} />
            <stop offset="55%" stopColor={col.mid} />
            <stop offset="100%" stopColor={col.deep} />
          </linearGradient>
          <radialGradient id={`${id}s`} cx="50%" cy="30%" r="80%">
            <stop offset="0%" stopColor="#3b3486" />
            <stop offset="100%" stopColor="#1e1b4b" />
          </radialGradient>
          <filter id={`${id}g`} x="-60%" y="-60%" width="220%" height="220%">
            <feGaussianBlur stdDeviation="1.4" result="blur" />
            <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
        </defs>

        {stageOf(level) === "master" && (
          <circle cx="60" cy="68" r="56" fill="#fbbf24" opacity="0.13" className={a("pixel-twinkle")} />
        )}
        <ellipse className={a("pixel-shadow")} cx="60" cy="119" rx={28 * stage.scale} ry="4.5" fill="#1e1b4b" opacity="0.16" />

        <g transform={grow}>
        <g className={a("pixel-float")}>
          <g style={{ transform: `rotate(${tilt}deg)`, transformOrigin: "60px 72px", transition: "transform 350ms ease" }}>
            <path d={`M60 ${B.y + 1} V17`} stroke={col.limb} strokeWidth="3" strokeLinecap="round" />
            {SPROUT.slice(0, sprouts).map(([x, y, c], i) => (
              <rect key={i} x={x} y={y} width="8" height="8" rx="2" fill={c}
                className={a("pixel-twinkle")} style={{ animationDelay: `${i * 0.35}s` }} />
            ))}

            <ellipse cx={B.x - 1} cy="78" rx="7" ry="10.5" fill={col.limb}
              className={mood === "happy" || mood === "proud" ? a("pixel-wave-l") : undefined} />
            <ellipse cx={B.x + B.w + 1} cy="78" rx="7" ry="10.5" fill={col.limb2}
              className={mood === "proud" ? a("pixel-wave-r") : undefined} />

            <rect x={B.x} y={B.y} width={B.w} height={B.h} rx={B.rx} fill={`url(#${id}b)`} />
            <ellipse cx={B.x + 23} cy={B.y + 14} rx="15" ry="7" fill="#fff" opacity="0.3"
              transform={`rotate(-22 ${B.x + 23} ${B.y + 14})`} />
            <rect x="44" y="104" width="10" height="9" rx="4" fill={col.limb2} />
            <rect x="66" y="104" width="10" height="9" rx="4" fill={col.limb2} />

            <rect x={screenX} y="47" width={120 - 2 * screenX} height="46" rx="18" fill={`url(#${id}s)`} />
            <g filter={`url(#${id}g)`}
              style={{ transform: `translate(${gaze.x}px, ${gaze.y}px)`, transition: "transform 120ms linear" }}>
              <g transform={`translate(60 70) scale(${stage.eyes}) translate(-60 -70)`}>
                <Face mood={mood} animated={animated} eye={eye} />
              </g>
            </g>
            <Accessory kind={t.accessory} B={B} contrast={col.contrast} />
            <StageMark stage={stageOf(level)} B={B} />
          </g>
        </g>
        </g>

        {mood === "thinking" && (
          <g fill={col.mid}>
            <circle className={a("pixel-dot")} cx="100" cy="30" r="3" />
            <circle className={a("pixel-dot")} cx="108" cy="20" r="4" style={{ animationDelay: "0.2s" }} />
            <circle className={a("pixel-dot")} cx="117" cy="8" r="5" style={{ animationDelay: "0.4s" }} />
          </g>
        )}
        {mood === "proud" && (
          <g fill="#fbbf24">
            <Star className={a("pixel-sparkle")} x={10} y={26} s={8} />
            <Star className={a("pixel-sparkle")} x={108} y={34} s={7} delay="0.5s" />
            <Star className={a("pixel-sparkle")} x={104} y={100} s={6} delay="0.9s" />
            <Star className={a("pixel-sparkle")} x={8} y={96} s={5} delay="0.3s" />
          </g>
        )}
        {mood === "sleepy" && (
          <text className={a("pixel-z")} x="98" y="30" fontSize="15" fontWeight="700" fill={col.mid}>z</text>
        )}
        {mood === "surprised" && (
          <text className={a("pixel-pop")} x="100" y="32" fontSize="22" fontWeight="800" fill="#f59e0b">!</text>
        )}
        {mood === "curious" && (
          <text className={a("pixel-pop")} x="99" y="30" fontSize="20" fontWeight="800" fill={col.mid}>?</text>
        )}
      </svg>
      </span>
    </span>
  );
}

/** What shows the growth stage at a glance: the egg shell of a newborn, a badge, a crown. */
function StageMark({ stage, B }: { stage: PixelStage; B: BodyBox }) {
  const right = B.x + B.w;
  if (stage === "baby") {
    // the bottom half of the egg it just hatched from
    const zig = Array.from({ length: 9 }, (_, i) => `L${B.x - 4 + (i * (B.w + 8)) / 8} ${i % 2 ? 90 : 97}`).join(" ");
    return (
      <path d={`M${B.x - 4} 97 ${zig} L${right + 4} 97 Q${right + 4} 116 60 117 Q${B.x - 4} 116 ${B.x - 4} 97 Z`}
        fill="#fffbeb" stroke="#e7d7b1" strokeWidth="2" />
    );
  }
  if (stage === "adult") {
    return (
      <g>
        <circle cx={right - 16} cy={B.y + B.h - 16} r="6.5" fill="#fbbf24" stroke="#b45309" strokeWidth="1.5" />
        <path d={`M${right - 16} ${B.y + B.h - 20} l1.4 2.8 3 .4 -2.2 2.1 .5 3 -2.7 -1.4 -2.7 1.4 .5 -3 -2.2 -2.1 3 -.4 Z`} fill="#fff7ed" />
      </g>
    );
  }
  if (stage === "master") {
    const y = B.y - 3;
    return (
      <path d={`M44 ${y} L46 ${y - 15} L53 ${y - 6} L60 ${y - 19} L67 ${y - 6} L74 ${y - 15} L76 ${y} Z`}
        fill="#fbbf24" stroke="#b45309" strokeWidth="1.5" strokeLinejoin="round" />
    );
  }
  return null;
}

/** The accessory that makes each project's Pixel recognisable at a glance. */
function Accessory({ kind, B, contrast }: { kind: string; B: BodyBox; contrast: string }) {
  const right = B.x + B.w;
  switch (kind) {
    case "bow": {
      const x = right - 16;
      const y = B.y + 4;
      return (
        <g fill={contrast}>
          <path d={`M${x} ${y} L${x - 11} ${y - 7} L${x - 11} ${y + 7} Z`} />
          <path d={`M${x} ${y} L${x + 11} ${y - 7} L${x + 11} ${y + 7} Z`} />
          <circle cx={x} cy={y} r="3.2" />
        </g>
      );
    }
    case "cap":
      return (
        <g fill={contrast}>
          <path d={`M${B.x + 12} ${B.y + 11} Q60 ${B.y - 16} ${right - 12} ${B.y + 11} Z`} />
          <rect x={right - 34} y={B.y + 6} width="32" height="6" rx="3" />
        </g>
      );
    case "glasses":
      return (
        <g fill="none" stroke="#e2e8f0" strokeWidth="2.5" opacity="0.9">
          <rect x="39" y="56" width="20" height="20" rx="6" />
          <rect x="61" y="56" width="20" height="20" rx="6" />
          <path d="M59 64 H61" />
        </g>
      );
    case "headphones":
      return (
        <g>
          <path d={`M${B.x + 4} 64 Q60 ${B.y - 28} ${right - 4} 64`} fill="none" stroke="#334155" strokeWidth="5" strokeLinecap="round" />
          <rect x={B.x - 5} y="54" width="12" height="22" rx="5" fill={contrast} />
          <rect x={right - 7} y="54" width="12" height="22" rx="5" fill={contrast} />
        </g>
      );
    case "leaf":
      return (
        <g>
          <path d={`M${B.x + 20} ${B.y + 3} q-6 -14 -20 -12 q2 14 20 12 Z`} fill="#4ade80" />
          <path d={`M${B.x + 20} ${B.y + 3} q-8 -6 -14 -8`} stroke="#15803d" strokeWidth="1.5" fill="none" />
        </g>
      );
    default:
      return null;
  }
}

function Face({ mood, animated, eye = EYE }: { mood: PixelMood; animated: boolean; eye?: string }) {
  const EYE = eye;
  const blink = animated ? "pixel-blink" : undefined;
  const line = { stroke: EYE, strokeWidth: 3.5, strokeLinecap: "round" as const, fill: "none" };
  const cheeks = (
    <>
      <circle cx="38" cy="80" r="4.5" fill="#f472b6" opacity="0.55" />
      <circle cx="82" cy="80" r="4.5" fill="#f472b6" opacity="0.55" />
    </>
  );

  switch (mood) {
    case "happy":
      return (
        <>
          <path d="M42 69 Q48.5 60 55 69" {...line} />
          <path d="M65 69 Q71.5 60 78 69" {...line} />
          <path d="M51 79 Q60 88 69 79" {...line} />
          {cheeks}
        </>
      );
    case "proud":
      return (
        <>
          <path d="M42 68 Q48.5 59 55 68" {...line} />
          <path d="M65 68 Q71.5 59 78 68" {...line} />
          <path d="M49 77 Q60 93 71 77 Z" fill={EYE} />
          {cheeks}
        </>
      );
    case "curious":
      return (
        <>
          <rect className={blink} x="43" y="60" width="10" height="14" rx="5" fill={EYE} />
          <rect className={blink} x="65" y="57" width="13" height="18" rx="6.5" fill={EYE} />
          <circle cx="50" cy="63" r="1.8" fill="#fff" />
          <circle cx="74" cy="61" r="2.2" fill="#fff" />
          <circle cx="62" cy="84" r="3" {...line} strokeWidth={3} />
        </>
      );
    case "thinking":
      return (
        <>
          <rect className={blink} x="47" y="56" width="9" height="12" rx="4.5" fill={EYE} />
          <rect className={blink} x="68" y="56" width="9" height="12" rx="4.5" fill={EYE} />
          <path d="M55 83 H66" {...line} />
        </>
      );
    case "surprised":
      return (
        <>
          <circle cx="49" cy="66" r="7.5" fill={EYE} />
          <circle cx="71" cy="66" r="7.5" fill={EYE} />
          <circle cx="51.5" cy="63.5" r="2.4" fill="#fff" />
          <circle cx="73.5" cy="63.5" r="2.4" fill="#fff" />
          <ellipse cx="60" cy="84" rx="4" ry="5" fill={EYE} />
        </>
      );
    case "sleepy":
      return (
        <>
          <path d="M43 69 Q49 72 55 69" {...line} />
          <path d="M65 69 Q71 72 77 69" {...line} />
          <path d="M56 84 Q60 86 64 84" {...line} strokeWidth={3} />
        </>
      );
    default:
      return (
        <>
          <rect className={blink} x="44" y="59" width="10" height="14" rx="5" fill={EYE} />
          <rect className={blink} x="66" y="59" width="10" height="14" rx="5" fill={EYE} />
          <circle cx="51" cy="62.5" r="1.8" fill="#fff" />
          <circle cx="73" cy="62.5" r="1.8" fill="#fff" />
          <path d="M53 82 Q60 87.5 67 82" {...line} />
        </>
      );
  }
}

function Star({ x, y, s, className, delay }: { x: number; y: number; s: number; className?: string; delay?: string }) {
  const d = `M${x} ${y - s} L${x + s * 0.28} ${y - s * 0.28} L${x + s} ${y} L${x + s * 0.28} ${y + s * 0.28} L${x} ${y + s} L${x - s * 0.28} ${y + s * 0.28} L${x - s} ${y} L${x - s * 0.28} ${y - s * 0.28} Z`;
  return <path d={d} className={className} style={delay ? { animationDelay: delay } : undefined} />;
}

/** Same sentence with different numbers ("12 of 135" -> "13 of 135"): a live counter, not a new line. */
const sameWords = (a: string, b: string) => a.replace(/\d+([.,]\d+)?/g, "#") === b.replace(/\d+([.,]\d+)?/g, "#");

/** Reveals a string like a typewriter (fast; skipped for reduced motion). A text that only changes its numbers
 *  is updated in place instead of being typed again, so live counters don't restart the animation. */
export function Typewriter({ text, speed = 18 }: { text: string; speed?: number }) {
  const [n, setN] = useState(0);
  const prev = useRef<string | null>(null);
  useEffect(() => {
    const reduce = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const old = prev.current;
    prev.current = text;
    if (reduce || (old !== null && sameWords(old, text))) { setN(text.length); return; }
    setN(0);
    const step = Math.max(1, Math.ceil(text.length / 70)); // never longer than ~1.3s
    const t = setInterval(() => setN((v) => (v >= text.length ? (clearInterval(t), v) : v + step)), speed);
    return () => clearInterval(t);
  }, [text, speed]);
  const done = n >= text.length;
  return (
    <span>
      <span className="sr-only">{text}</span>
      <span aria-hidden className={done ? undefined : "caret"}>{text.slice(0, n)}</span>
    </span>
  );
}

/** Pixel with a speech bubble. `vertical` puts the bubble below the avatar. String children are typed out. */
export function PixelSays({
  children, mood = "idle", level, size = 56, vertical = false, bounce, onPoke, className, bubbleClassName, traits, activity,
}: {
  activity?: "lift" | "run" | null;
  traits?: PixelTraits;
  children: ReactNode;
  mood?: PixelMood;
  level?: number;
  size?: number;
  vertical?: boolean;
  bounce?: number;
  onPoke?: () => void;
  className?: string;
  bubbleClassName?: string;
}) {
  return (
    <div className={cn(vertical ? "flex flex-col items-center gap-3" : "flex items-end gap-3", className)}>
      <PixelAvatar mood={mood} level={level} size={size} bounce={bounce} onPoke={onPoke} traits={traits} activity={activity} />
      <div className={cn("bubble animate-in fade-in duration-300",
        vertical ? "slide-in-from-top-1 w-full" : "mb-4 slide-in-from-left-2", bubbleClassName)}>
        <span className={cn("absolute h-3 w-3 rotate-45 border-pixel/25 bg-card",
          vertical ? "-top-[7px] left-1/2 -translate-x-1/2 border-l border-t" : "-left-[7px] bottom-4 border-b border-l")} />
        {typeof children === "string" ? <Typewriter text={children} /> : children}
      </div>
    </div>
  );
}

/** Burst of pixel confetti. Change `trigger` to fire; place inside a `relative` parent. */
export function PixelBurst({ trigger, count = 22 }: { trigger: number; count?: number }) {
  const [bits, setBits] = useState<{ k: string; dx: number; dy: number; rot: number; s: number; c: string; d: number }[]>([]);
  useEffect(() => {
    if (!trigger) return;
    const colors = ["#a78bfa", "#fbbf24", "#f472b6", "#34d399", "#67e8f9", "#818cf8"];
    setBits(Array.from({ length: count }, (_, i) => {
      const ang = Math.random() * Math.PI * 2;
      const dist = 60 + Math.random() * 110;
      return {
        k: `${trigger}-${i}`, dx: Math.cos(ang) * dist, dy: Math.sin(ang) * dist - 30,
        rot: (Math.random() - 0.5) * 540, s: 5 + Math.random() * 7, c: colors[i % colors.length], d: Math.random() * 120,
      };
    }));
    const t = setTimeout(() => setBits([]), 1400);
    return () => clearTimeout(t);
  }, [trigger, count]);
  if (!bits.length) return null;
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 z-20 overflow-visible">
      {bits.map((b) => (
        <span key={b.k} className="burst-bit"
          style={{ width: b.s, height: b.s, backgroundColor: b.c, animationDelay: `${b.d}ms`,
            ["--dx" as string]: `${b.dx}px`, ["--dy" as string]: `${b.dy}px`, ["--rot" as string]: `${b.rot}deg` } as React.CSSProperties} />
      ))}
    </div>
  );
}

// ---------- progression ----------

export function levelFromBoxes(boxes: number) {
  return 1 + Math.floor(Math.sqrt(boxes / 3));
}

/** Progress (0..1) towards the next level. */
export function levelProgress(boxes: number) {
  const l = levelFromBoxes(boxes);
  const lo = 3 * (l - 1) ** 2;
  const hi = 3 * l ** 2;
  return { level: l, progress: (boxes - lo) / (hi - lo), toNext: hi - boxes };
}

export function levelTitle(level: number) {
  if (level <= 2) return "Curious";
  if (level <= 4) return "Apprentice";
  if (level <= 6) return "Assistant";
  if (level <= 9) return "Expert";
  return "Master";
}

/** Truthful "fun facts" Pixel says when poked, built from real stats. */
export function pokeLines(s: {
  boxes: number; gestures: number; propagated: number; batch_ready: number;
  classes: { name: string; box_count: number }[]; images: { total: number; annotated: number };
}): string[] {
  const lines = ["Hey! That tickles.", "Beep. I'm awake, I promise."];
  const best = [...s.classes].sort((a, b) => b.box_count - a.box_count)[0];
  const worst = [...s.classes].sort((a, b) => a.box_count - b.box_count)[0];
  if (best && best.box_count > 0) lines.push(`My favourite class is “${best.name}”: you've shown me ${best.box_count} of them.`);
  if (worst && best && worst.name !== best.name) lines.push(`I'm still shaky on “${worst.name}” (${worst.box_count} examples). Teach me more?`);
  if (s.propagated > 0) lines.push(`So far I've changed my mind ${s.propagated} times thanks to you.`);
  if (s.gestures > 0) lines.push(`Fun fact: ${s.gestures} of your gestures became ${s.boxes} labels.`);
  if (s.images.total > 0) lines.push(`I've looked at ${s.images.total} images. ${s.images.annotated} of them I really understand.`);
  if (s.batch_ready > 0) lines.push(`Psst… ${s.batch_ready} guesses are waiting in the Harvest.`);
  return lines;
}
