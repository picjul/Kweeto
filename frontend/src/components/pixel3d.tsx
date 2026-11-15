"use client";

/**
 * Pixel in 3D (three.js via React Three Fiber). The same character as the SVG avatar in `pixel.tsx`
 * (shape, colour, eyes, accessory, growth stage, mood), but with a body: it breathes, blinks, looks at
 * the pointer, waves, hops, waddles when it walks and squishes when poked.
 *
 * - `PixelModel` is the character itself (world units: ~1.2 tall, feet on y = 0, facing +z).
 * - `Pixel3DCanvas` is a tiny transparent canvas around one avatar (used by `PixelAvatar` for big sizes).
 * The Playground puts many `PixelModel`s in one scene.
 */

import { Environment, Lightformer, RoundedBox } from "@react-three/drei";
import { Canvas, useFrame } from "@react-three/fiber";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import * as THREE from "three";

import { STAGES, stageOf, type PixelMood } from "@/components/pixel";
import { EYE_COLORS, pixelColors } from "@/components/project-context";
import type { PixelOptions, PixelShape, PixelTraits } from "@/lib/api";

// ---------- shapes (the SVG body boxes, in world units: 100 SVG px = 1 unit, feet line at y = 0) ----------

type Dims = { w: number; h: number; d: number; r: number; cy: number; top: number; sw: number };
const SVG_BODY: Record<PixelShape, { x: number; y: number; w: number; h: number; rx: number }> = {
  round: { x: 18, y: 27, w: 84, h: 84, rx: 30 },
  square: { x: 18, y: 27, w: 84, h: 84, rx: 14 },
  blob: { x: 12, y: 34, w: 96, h: 77, rx: 38 },
  tall: { x: 25, y: 20, w: 70, h: 91, rx: 24 },
};
const FEET = 113; // SVG y of the ground
const wy = (svgY: number) => (FEET - svgY) / 100;

function dimsOf(shape: PixelShape): Dims {
  const B = SVG_BODY[shape] ?? SVG_BODY.round;
  const w = B.w / 100;
  const h = B.h / 100;
  const d = Math.min(w, h) * 0.78;
  const r = Math.min(B.rx / 100, Math.min(w, h, d) / 2 - 0.01);
  const screenX = Math.max(29, B.x + 11);
  return { w, h, d, r, cy: wy(B.y + B.h / 2), top: wy(B.y), sw: (120 - 2 * screenX) / 100 };
}

/** z of the (rounded) front surface at an offset from the body centre: where to stick things on it. */
function frontZ(b: Dims, ox: number, oy: number) {
  const ex = Math.max(0, Math.abs(ox) - (b.w / 2 - b.r));
  const ey = Math.max(0, Math.abs(oy) - (b.h / 2 - b.r));
  const e = Math.min(b.r, Math.hypot(ex, ey));
  return b.d / 2 - (b.r - Math.sqrt(b.r * b.r - e * e));
}

/** "hsl(262 83% 58%)" (CSS level 4, which three.js does not parse) → THREE.Color */
function color(css: string) {
  const c = new THREE.Color();
  const m = css.match(/hsl\(\s*(-?[\d.]+)\s+([\d.]+)%\s+([\d.]+)%/);
  if (m) c.setHSL((((+m[1] % 360) + 360) % 360) / 360, +m[2] / 100, +m[3] / 100);
  else c.set(css);
  return c;
}

// ---------- the face: drawn on a canvas texture (same drawings as the SVG face), redrawn only when it changes ----------

type Op =
  | { k: "path"; d: string; fill?: string; stroke?: string; w?: number }
  | { k: "rect"; x: number; y: number; w: number; h: number; r: number; fill: string; blink?: boolean }
  | { k: "circle"; cx: number; cy: number; r: number; fill?: string; stroke?: string; w?: number }
  | { k: "ellipse"; cx: number; cy: number; rx: number; ry: number; fill: string };

const E = "eye"; // placeholder for the eye colour
const CHEEKS: Op[] = [
  { k: "circle", cx: 38, cy: 80, r: 4.5, fill: "rgba(244,114,182,0.55)" },
  { k: "circle", cx: 82, cy: 80, r: 4.5, fill: "rgba(244,114,182,0.55)" },
];
/** A face that is not a mood: the effort of a workout (eyes squeezed, teeth clenched, flushed). */
type FaceKey = PixelMood | "effort";

const FACE: Record<FaceKey, Op[]> = {
  effort: [
    { k: "path", d: "M43 60 L53 66 L43 72", stroke: E }, { k: "path", d: "M77 60 L67 66 L77 72", stroke: E },
    { k: "rect", x: 50, y: 78, w: 20, h: 8, r: 3, fill: E }, { k: "path", d: "M51 82 H69", stroke: "#1e1b4b", w: 1.6 },
    { k: "circle", cx: 38, cy: 80, r: 5.5, fill: "rgba(248,113,113,0.6)" }, { k: "circle", cx: 82, cy: 80, r: 5.5, fill: "rgba(248,113,113,0.6)" },
  ],
  happy: [
    { k: "path", d: "M42 69 Q48.5 60 55 69", stroke: E }, { k: "path", d: "M65 69 Q71.5 60 78 69", stroke: E },
    { k: "path", d: "M51 79 Q60 88 69 79", stroke: E }, ...CHEEKS,
  ],
  proud: [
    { k: "path", d: "M42 68 Q48.5 59 55 68", stroke: E }, { k: "path", d: "M65 68 Q71.5 59 78 68", stroke: E },
    { k: "path", d: "M49 77 Q60 93 71 77 Z", fill: E }, ...CHEEKS,
  ],
  curious: [
    { k: "rect", x: 43, y: 60, w: 10, h: 14, r: 5, fill: E, blink: true },
    { k: "rect", x: 65, y: 57, w: 13, h: 18, r: 6.5, fill: E, blink: true },
    { k: "circle", cx: 50, cy: 63, r: 1.8, fill: "#fff" }, { k: "circle", cx: 74, cy: 61, r: 2.2, fill: "#fff" },
    { k: "circle", cx: 62, cy: 84, r: 3, stroke: E, w: 3 },
  ],
  thinking: [
    { k: "rect", x: 47, y: 56, w: 9, h: 12, r: 4.5, fill: E, blink: true },
    { k: "rect", x: 68, y: 56, w: 9, h: 12, r: 4.5, fill: E, blink: true },
    { k: "path", d: "M55 83 H66", stroke: E },
  ],
  surprised: [
    { k: "circle", cx: 49, cy: 66, r: 7.5, fill: E }, { k: "circle", cx: 71, cy: 66, r: 7.5, fill: E },
    { k: "circle", cx: 51.5, cy: 63.5, r: 2.4, fill: "#fff" }, { k: "circle", cx: 73.5, cy: 63.5, r: 2.4, fill: "#fff" },
    { k: "ellipse", cx: 60, cy: 84, rx: 4, ry: 5, fill: E },
  ],
  sleepy: [
    { k: "path", d: "M43 69 Q49 72 55 69", stroke: E }, { k: "path", d: "M65 69 Q71 72 77 69", stroke: E },
    { k: "path", d: "M56 84 Q60 86 64 84", stroke: E, w: 3 },
  ],
  idle: [
    { k: "rect", x: 44, y: 59, w: 10, h: 14, r: 5, fill: E, blink: true },
    { k: "rect", x: 66, y: 59, w: 10, h: 14, r: 5, fill: E, blink: true },
    { k: "circle", cx: 51, cy: 62.5, r: 1.8, fill: "#fff" }, { k: "circle", cx: 73, cy: 62.5, r: 1.8, fill: "#fff" },
    { k: "path", d: "M53 82 Q60 87.5 67 82", stroke: E },
  ],
};

class FaceScreen {
  canvas = document.createElement("canvas");
  ctx: CanvasRenderingContext2D;
  tex: THREE.CanvasTexture;
  key = "";
  constructor(private W: number) {
    this.canvas.width = 256;
    this.canvas.height = Math.round((256 * 46) / W);
    this.ctx = this.canvas.getContext("2d")!;
    this.tex = new THREE.CanvasTexture(this.canvas);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.tex.anisotropy = 4;
  }
  draw(mood: FaceKey, eye: string, gx: number, gy: number, blink: number, eyes: number, glasses: boolean) {
    const key = `${mood}|${eye}|${gx.toFixed(1)}|${gy.toFixed(1)}|${blink.toFixed(2)}|${eyes}|${glasses}`;
    if (key === this.key) return;
    this.key = key;
    const { ctx, W } = this;
    const k = this.canvas.width / W;
    const x0 = 60 - W / 2;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.setTransform(k, 0, 0, k, -x0 * k, -47 * k);
    // the screen, with a soft glare
    const bg = ctx.createRadialGradient(60, 60, 2, 60, 62, W * 0.75);
    bg.addColorStop(0, "#3b3486");
    bg.addColorStop(1, "#1e1b4b");
    ctx.fillStyle = bg;
    ctx.fillRect(x0, 47, W, 46);
    const glare = ctx.createLinearGradient(x0, 47, x0 + W * 0.6, 80);
    glare.addColorStop(0, "rgba(255,255,255,0.13)");
    glare.addColorStop(0.5, "rgba(255,255,255,0)");
    ctx.fillStyle = glare;
    ctx.fillRect(x0, 47, W, 46);

    ctx.save();
    ctx.translate(gx, gy);
    ctx.translate(60, 70);
    ctx.scale(eyes, eyes);
    ctx.translate(-60, -70);
    ctx.shadowColor = eye;
    ctx.shadowBlur = 3.2 * k;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (const op of FACE[mood]) {
      const col = (c?: string) => (c === E ? eye : c);
      ctx.save();
      const p = new Path2D();
      if (op.k === "path") p.addPath(new Path2D(op.d));
      else if (op.k === "rect") {
        if (op.blink) {
          ctx.translate(op.x + op.w / 2, op.y + op.h / 2);
          ctx.scale(1, blink);
          ctx.translate(-(op.x + op.w / 2), -(op.y + op.h / 2));
        }
        p.roundRect(op.x, op.y, op.w, op.h, op.r);
      } else if (op.k === "circle") p.arc(op.cx, op.cy, op.r, 0, Math.PI * 2);
      else p.ellipse(op.cx, op.cy, op.rx, op.ry, 0, 0, Math.PI * 2);
      const fill = "fill" in op ? col(op.fill) : undefined;
      const stroke = "stroke" in op ? col(op.stroke) : undefined;
      if (fill) {
        if (fill === "#fff" || fill.startsWith("rgba")) ctx.shadowBlur = 0;
        ctx.fillStyle = fill;
        ctx.fill(p);
      }
      if (stroke) {
        ctx.strokeStyle = stroke;
        ctx.lineWidth = ("w" in op && op.w) || 3.5;
        ctx.stroke(p);
      }
      ctx.restore();
    }
    ctx.restore();
    if (glasses) {
      ctx.save();
      ctx.strokeStyle = "rgba(226,232,240,0.9)";
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.roundRect(39, 56, 20, 20, 6);
      ctx.roundRect(61, 56, 20, 20, 6);
      ctx.moveTo(59, 64);
      ctx.lineTo(61, 64);
      ctx.stroke();
      ctx.restore();
    }
    this.tex.needsUpdate = true;
  }
  dispose() { this.tex.dispose(); }
}

// ---------- small shared helpers ----------

const glyphs = new Map<string, THREE.CanvasTexture>();
/** A character ("z", "?", "!", "✦") as a sprite texture, cached and shared. */
function glyph(ch: string, fill: string) {
  const key = ch + fill;
  let t = glyphs.get(key);
  if (t) return t;
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d")!;
  g.font = "800 100px system-ui, 'Segoe UI', sans-serif";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.lineJoin = "round";
  g.lineWidth = 12;
  g.strokeStyle = "rgba(255,255,255,0.9)";
  g.strokeText(ch, 64, 70);
  g.fillStyle = fill;
  g.fillText(ch, 64, 70);
  t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  glyphs.set(key, t);
  return t;
}

let dropTex: THREE.CanvasTexture | null = null;
/** A drop of sweat (workout). */
function sweatDrop() {
  if (dropTex) return dropTex;
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d")!;
  g.beginPath();
  g.moveTo(32, 6);
  g.bezierCurveTo(44, 26, 52, 36, 52, 44);
  g.arc(32, 44, 20, 0, Math.PI);
  g.bezierCurveTo(12, 36, 20, 26, 32, 6);
  const grd = g.createLinearGradient(20, 10, 44, 60);
  grd.addColorStop(0, "#e0f2fe");
  grd.addColorStop(1, "#38bdf8");
  g.fillStyle = grd;
  g.fill();
  g.fillStyle = "rgba(255,255,255,0.85)";
  g.beginPath();
  g.ellipse(25, 42, 4, 7, -0.4, 0, Math.PI * 2);
  g.fill();
  dropTex = new THREE.CanvasTexture(c);
  dropTex.colorSpace = THREE.SRGBColorSpace;
  return dropTex;
}

/** Half extents (x, z) of the rounded body at `dy` below its top: where a headband sits. */
function girth(b: Dims, dy: number): [number, number] {
  const r = b.r;
  const e = r - Math.min(r, dy);
  const k = r - Math.sqrt(Math.max(0, r * r - e * e));
  return [b.w / 2 - k, b.d / 2 - k];
}

let blobTex: THREE.CanvasTexture | null = null;
function blobShadow() {
  if (blobTex) return blobTex;
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d")!;
  const r = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  r.addColorStop(0, "rgba(30,27,75,0.45)");
  r.addColorStop(1, "rgba(30,27,75,0)");
  g.fillStyle = r;
  g.fillRect(0, 0, 64, 64);
  blobTex = new THREE.CanvasTexture(c);
  return blobTex;
}

let glowTex: THREE.CanvasTexture | null = null;
function glow() {
  if (glowTex) return glowTex;
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d")!;
  const r = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  r.addColorStop(0, "rgba(255,255,255,0.8)");
  r.addColorStop(0.5, "rgba(255,255,255,0.25)");
  r.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = r;
  g.fillRect(0, 0, 64, 64);
  glowTex = new THREE.CanvasTexture(c);
  return glowTex;
}

/** Rounded-rectangle shape (the face screen), centred on the origin. */
function roundRect(w: number, h: number, r: number) {
  const s = new THREE.Shape();
  const x = -w / 2;
  const y = -h / 2;
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y);
  s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + h - r);
  s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  s.lineTo(x + r, y + h);
  s.quadraticCurveTo(x, y + h, x, y + h - r);
  s.lineTo(x, y + r);
  s.quadraticCurveTo(x, y, x + r, y);
  return s;
}

/** Bottom half of an egg shell with a zig-zag rim (what a newborn Pixel still sits in). */
function eggShellGeometry(R: number) {
  const pts: THREE.Vector2[] = [];
  for (let i = 0; i <= 10; i++) {
    const a = (i / 10) * (Math.PI / 2);
    pts.push(new THREE.Vector2(Math.max(0.001, R * Math.sin(a)), -0.04 + 0.23 * (1 - Math.cos(a))));
  }
  pts.push(new THREE.Vector2(R, 0.22));
  const g = new THREE.LatheGeometry(pts, 24);
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    if (pos.getY(i) > 0.2) {
      const a = Math.atan2(pos.getZ(i), pos.getX(i));
      const seg = Math.round(((a + Math.PI) / (2 * Math.PI)) * 24);
      pos.setY(i, pos.getY(i) + (seg % 2 ? 0.035 : -0.035));
    }
  }
  g.computeVertexNormals();
  return g;
}

function crownGeometry() {
  const g = new THREE.CylinderGeometry(0.16, 0.14, 0.11, 10, 1, true);
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    if (pos.getY(i) > 0) {
      const a = Math.atan2(pos.getZ(i), pos.getX(i));
      const seg = Math.round(((a + Math.PI) / (2 * Math.PI)) * 10);
      if (seg % 2 === 0) pos.setY(i, pos.getY(i) + 0.07);
    }
  }
  g.computeVertexNormals();
  return g;
}

// the pixel "sprouts" on the antenna, one more every two levels: [x, height above the tip, colour]
const SPROUTS: [number, number, string][] = [[0, 0.04, "#a78bfa"], [0.08, 0.11, "#fbbf24"], [-0.08, 0.11, "#f472b6"], [0, 0.19, "#34d399"]];

const lerp = (a: number, b: number, k: number) => a + (b - a) * Math.min(1, k);
const angleLerp = (a: number, b: number, k: number) => {
  let d = ((b - a + Math.PI) % (Math.PI * 2)) - Math.PI;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * Math.min(1, k);
};

// ---------- the character ----------

/** What moves a Pixel from outside, read every frame (no React re-render): walking, heading, gaze. */
export type PixelActivity = "lift" | "run";

export type PixelDrive = { walk: number; yaw: number; lookX: number; lookY: number; hover?: boolean };

export function PixelModel({
  traits, options, level = 7, mood = "idle", bounce = 0, poke = 0, drive, animated = true, shadows = false, blob = true,
  activity = null,
}: {
  /** a workout while a detector trains: dumbbells ("lift") or running on the spot ("run") */
  activity?: PixelActivity | null;
  traits: PixelTraits;
  options?: PixelOptions | null;
  level?: number;
  mood?: PixelMood;
  /** change it to make Pixel jump */
  bounce?: number;
  /** change it to make Pixel squish */
  poke?: number;
  drive?: MutableRefObject<PixelDrive>;
  animated?: boolean;
  /** cast real shadows (the Playground has a sun) */
  shadows?: boolean;
  /** soft blob shadow under the feet */
  blob?: boolean;
}) {
  const stageKey = stageOf(level);
  const stage = STAGES[stageKey];
  const b = useMemo(() => dimsOf(traits.shape), [traits.shape]);
  const col = useMemo(() => pixelColors(traits, options), [traits, options]);
  const eye = EYE_COLORS[traits.eyes] ?? "#67e8f9";
  const sprouts = Math.min(4, 1 + Math.floor((level - 1) / 2));

  const mats = useMemo(() => {
    const body = new THREE.MeshPhysicalMaterial({
      color: color(col.mid).lerp(color(col.light), 0.35), roughness: 0.38, clearcoat: 1, clearcoatRoughness: 0.18,
      sheen: 0.4, sheenColor: color(col.light),
    });
    const limb = new THREE.MeshPhysicalMaterial({ color: color(col.limb), roughness: 0.45, clearcoat: 0.6 });
    const limb2 = new THREE.MeshPhysicalMaterial({ color: color(col.limb2), roughness: 0.45, clearcoat: 0.6 });
    const accent = new THREE.MeshPhysicalMaterial({ color: color(col.contrast), roughness: 0.4, clearcoat: 0.8 });
    const visor = new THREE.MeshPhysicalMaterial({ color: "#1e1b4b", roughness: 0.2, clearcoat: 1, metalness: 0.1 });
    const gold = new THREE.MeshStandardMaterial({ color: "#fbbf24", metalness: 0.75, roughness: 0.25, emissive: "#b45309", emissiveIntensity: 0.25, side: THREE.DoubleSide });
    const shell = new THREE.MeshStandardMaterial({ color: "#fffbeb", roughness: 0.55, side: THREE.DoubleSide });
    return { body, limb, limb2, accent, visor, gold, shell };
  }, [col]);
  useEffect(() => () => Object.values(mats).forEach((m) => m.dispose()), [mats]);

  const face = useMemo(() => new FaceScreen(b.sw * 100), [b.sw]);
  useEffect(() => () => face.dispose(), [face]);
  const screen = useMemo(() => {
    const s = roundRect(b.sw, 0.46, 0.15);
    const visor = new THREE.ExtrudeGeometry(s, { depth: 0.12, bevelEnabled: true, bevelSize: 0.012, bevelThickness: 0.012, bevelSegments: 3, curveSegments: 10 });
    const front = new THREE.ShapeGeometry(s, 10);
    const pos = front.attributes.position;
    const uv = front.attributes.uv;
    for (let i = 0; i < pos.count; i++) uv.setXY(i, (pos.getX(i) + b.sw / 2) / b.sw, (pos.getY(i) + 0.23) / 0.46);
    return { visor, front };
  }, [b.sw]);
  useEffect(() => () => { screen.visor.dispose(); screen.front.dispose(); }, [screen]);
  const shellGeo = useMemo(() => (stageKey === "baby" ? eggShellGeometry(b.w / 2 + 0.05) : null), [stageKey, b.w]);
  const crownGeo = useMemo(() => (stageKey === "master" ? crownGeometry() : null), [stageKey]);
  useEffect(() => () => { shellGeo?.dispose(); crownGeo?.dispose(); }, [shellGeo, crownGeo]);

  const root = useRef<THREE.Group>(null);
  const body = useRef<THREE.Group>(null);
  const armL = useRef<THREE.Group>(null);
  const armR = useRef<THREE.Group>(null);
  const footL = useRef<THREE.Mesh>(null);
  const footR = useRef<THREE.Mesh>(null);
  const sproutRefs = useRef<(THREE.Mesh | null)[]>([]);
  const shadow = useRef<THREE.Mesh>(null);
  const extras = useRef<THREE.Group>(null);
  const sweat = useRef<THREE.Group>(null);

  // timers of one-shot gestures
  const s = useRef({ moodAt: -1, mood, jumpAt: -9, pokeAt: -9, blinkAt: 2 + Math.random() * 3, seed: Math.random() * 10, walk: 0, yaw: 0, lx: 0, ly: 0 });
  const bounceSeen = useRef(bounce);
  const pokeSeen = useRef(poke);

  useLayoutEffect(() => {
    root.current?.traverse((o) => {
      if ((o as THREE.Mesh).isMesh && !o.userData.noShadow) { o.castShadow = shadows; o.receiveShadow = false; }
    });
  });

  useFrame((state, dt) => {
    const t = state.clock.elapsedTime;
    const st = s.current;
    const dr = drive?.current;
    if (st.mood !== mood || st.moodAt < 0) { st.mood = mood; st.moodAt = t; }
    if (bounce !== bounceSeen.current) { bounceSeen.current = bounce; st.jumpAt = t; }
    if (poke !== pokeSeen.current) { pokeSeen.current = poke; st.pokeAt = t; }
    const A = animated ? 1 : 0;
    const since = t - st.moodAt;

    // walking (0..1, smoothed) and heading
    st.walk = lerp(st.walk, dr?.walk ?? 0, dt * 8);
    const w = st.walk * A;
    const step = t * 14;

    // gaze: the pointer (avatars) or a lazy look around
    let lx = dr?.lookX ?? 0;
    let ly = dr?.lookY ?? 0;
    if (!dr || (dr.lookX === 0 && dr.lookY === 0)) {
      lx = Math.sin(t * 0.37 + st.seed) * 0.35 * A;
      ly = Math.sin(t * 0.23 + st.seed * 2) * 0.15 * A;
    }
    if (mood === "sleepy") { lx = 0; ly = 0.2; }
    st.lx = lerp(st.lx, lx, dt * 6);
    st.ly = lerp(st.ly, ly, dt * 6);
    st.yaw = angleLerp(st.yaw, dr?.yaw ?? 0, dt * 7);

    // blink every few seconds
    if (t > st.blinkAt + 0.16) st.blinkAt = t + 2.2 + Math.random() * 4;
    const bp = (t - st.blinkAt) / 0.16;
    const blink = A && bp >= 0 && bp <= 1 ? Math.max(0.08, Math.abs(1 - 2 * bp)) : 1;
    // workout while a detector trains: 4 alternating curls (0.9 s each), then 2 overhead presses (1.8 s each)
    const act = A ? activity : null;
    const liftT = t % 7.2;
    const repPh = liftT < 3.6 ? (liftT % 0.9) / 0.9 : ((liftT - 3.6) % 1.8) / 1.8;
    const strain = act === "lift" && repPh > 0.3 && repPh < 0.75;
    const faceKey: FaceKey = act === "lift" ? (strain ? "effort" : "proud") : act === "run" ? "happy" : mood;
    face.draw(faceKey, eye, st.lx * 3.5, st.ly * 3.5, blink, stage.eyes, traits.accessory === "glasses");

    // body language
    let y = A * (Math.sin(t * 1.96) * 0.018 + 0.018) * (1 - w);
    let rz = 0;
    let rx = st.ly * 0.22;
    let sx = 1;
    let sy = 1 + A * Math.sin(t * 2.2) * 0.012;
    let zBack = 0;
    let arms: [number, number] = [-0.15, 0.15];
    const wave = Math.sin(t * 7);
    switch (mood) {
      case "happy": {
        const ph = (t % 2.6) / 2.6;
        if (ph > 0.6 && ph < 0.86) y += A * Math.sin(((ph - 0.6) / 0.26) * Math.PI) * 0.12;
        if (ph > 0.55 && ph < 0.62) { sy *= 0.94; sx *= 1.05; }
        arms = [-(2.3 + 0.35 * wave * A), 0.25];
        break;
      }
      case "proud":
        sx *= 1 + A * 0.04 * Math.sin(t * 3.5) ** 2;
        sy *= 1 + A * 0.05 * Math.sin(t * 3.5) ** 2;
        arms = [-(2.4 + 0.3 * wave * A), 2.4 + 0.3 * Math.sin(t * 7 + 1.2) * A];
        break;
      case "surprised":
        if (since < 0.6) {
          const k = Math.sin((since / 0.6) * Math.PI);
          y += A * k * 0.16;
          zBack = -A * k * 0.12;
          rz -= A * k * 0.1;
        }
        arms = since < 1.2 ? [-2.1, 2.1] : [-0.7, 0.7];
        break;
      case "sleepy":
        y = -0.015;
        rz = A * Math.sin(t * 1.85) * 0.07;
        rx = 0.12;
        sy *= 1 + A * Math.sin(t * 1.85) * 0.025;
        arms = [-0.05, 0.05];
        break;
      case "curious":
        rz = -0.14 + A * Math.sin(t * 2.8) * 0.06;
        rx += 0.06;
        arms = [-0.55, 0.15];
        break;
      case "thinking":
        rz = 0.1 + A * Math.sin(t * 2.1) * 0.03;
        arms = [-0.15, 2.6 + A * Math.sin(t * 9) * 0.08];
        break;
    }
    // walking: waddle, bob, swinging arms, stepping feet
    rz += w * Math.sin(step) * 0.09;
    y += w * Math.abs(Math.sin(step)) * 0.045;

    // jump (two hops, like the SVG one)
    const jt = t - st.jumpAt;
    if (A && jt >= 0 && jt < 1.4) {
      const ph = (jt % 0.7) / 0.7;
      y += Math.sin(ph * Math.PI) * 0.32;
      const land = ph < 0.12 ? 1 - ph / 0.12 : ph > 0.9 ? (ph - 0.9) / 0.1 : 0;
      sy *= 1 - land * 0.12 + (ph > 0.12 && ph < 0.6 ? 0.06 : 0);
      sx *= 1 + land * 0.1;
      arms = [-2.4, 2.4];
    }
    // poke: a springy squish and a wiggle
    const pt = t - st.pokeAt;
    if (pt >= 0 && pt < 1.2) {
      const sq = Math.exp(-6 * pt) * Math.cos(pt * 24) * 0.22;
      sy *= 1 - sq;
      sx *= 1 + sq * 0.6;
      rz += Math.exp(-5 * pt) * Math.sin(pt * 30) * 0.12;
    }

    // limbs (walking by default), then the workout overrides
    let armZ: [number, number] = [arms[0] * (1 - w) - 0.15 * w, arms[1] * (1 - w) + 0.15 * w];
    const sw = Math.sin(step) * 0.7 * w;
    let armX: [number, number] = [sw, -sw];
    const fz = Math.sin(step) * 0.07 * w;
    let feet: [number, number, number, number] = [0.04 + fz, 0.04 - fz,
      0.045 + Math.max(0, Math.sin(step)) * 0.05 * w, 0.045 + Math.max(0, -Math.sin(step)) * 0.05 * w];
    if (act === "run") {        // running on the spot: high knees, pumping arms, leaning forward
      const rs = t * 19;
      y = Math.abs(Math.sin(rs)) * 0.06;
      rx = 0.14;
      rz = Math.sin(rs) * 0.05;
      sy = 1 + Math.abs(Math.cos(rs)) * 0.03;
      armZ = [-0.35, 0.35];
      armX = [Math.sin(rs) * 1.2, -Math.sin(rs) * 1.2];
      feet = [0.06 + Math.sin(rs) * 0.04, 0.06 - Math.sin(rs) * 0.04,
        0.045 + Math.max(0, Math.sin(rs)) * 0.11, 0.045 + Math.max(0, -Math.sin(rs)) * 0.11];
    } else if (act === "lift") {
      if (liftT < 3.6) {        // alternating curls
        const left = Math.floor(liftT / 0.9) % 2 === 0;
        const up = Math.sin(repPh * Math.PI);
        armZ = [-0.25, 0.25];
        armX = left ? [-2.3 * up, 0] : [0, -2.3 * up];
        rz = (left ? 1 : -1) * 0.05 * up;
        y = 0;
        sy = 1 - 0.02 * up;
      } else {                  // overhead press, with a small squat to drive it
        const up = repPh < 0.25 ? 0 : repPh < 0.5 ? (repPh - 0.25) / 0.25 : repPh < 0.75 ? 1 : 1 - (repPh - 0.75) / 0.25;
        const squat = repPh < 0.25 ? Math.sin((repPh / 0.25) * Math.PI) : 0;
        armZ = [-(1.7 + 1.15 * up), 1.7 + 1.15 * up];
        armX = [0, 0];
        y = -0.03 * squat + 0.01 * up;
        sy = 1 - 0.08 * squat + 0.03 * up;
        sx = 1 + 0.05 * squat;
        rz = up === 1 ? Math.sin(t * 30) * 0.015 : 0;  // shaking under the weight
      }
    }

    if (root.current) {
      root.current.position.y = y;
      root.current.position.z = zBack;
      root.current.rotation.y = st.yaw;
    }
    if (body.current) {
      body.current.rotation.set(rx, st.lx * 0.5 * (1 - w), rz);
      body.current.scale.set(sx, sy, sx);
    }
    const k = act ? dt * 16 : dt * 10;
    if (armL.current) {
      armL.current.rotation.z = lerp(armL.current.rotation.z, armZ[0], k);
      armL.current.rotation.x = lerp(armL.current.rotation.x, armX[0], k);
    }
    if (armR.current) {
      armR.current.rotation.z = lerp(armR.current.rotation.z, armZ[1], k);
      armR.current.rotation.x = lerp(armR.current.rotation.x, armX[1], k);
    }
    if (footL.current && footR.current) {
      footL.current.position.z = feet[0];
      footR.current.position.z = feet[1];
      footL.current.position.y = feet[2];
      footR.current.position.y = feet[3];
    }
    // sweat: drops flying off both sides of the head
    sweat.current?.children.forEach((c, i) => {
      const ph = (t * 1.15 + i / 3) % 1;
      const side = i % 2 ? 1 : -1;
      c.position.set(side * (b.w * 0.42 + 0.22 * ph), b.top - 0.04 + 0.16 * ph - 0.5 * ph * ph, b.d * 0.3 + 0.05 * ph);
      (c as THREE.Sprite).material.opacity = Math.sin(ph * Math.PI);
    });
    sproutRefs.current.forEach((m, i) => {
      if (!m) return;
      const k = 1 + A * Math.sin(t * 2.6 + i * 1.3) * 0.12;
      m.scale.setScalar(k);
      m.rotation.y = A * t * 0.8 + i;
    });
    if (shadow.current) {
      const k = Math.max(0.4, 1 - Math.max(0, y) * 2.2);
      shadow.current.scale.setScalar(k);
      (shadow.current.material as THREE.MeshBasicMaterial).opacity = k;
    }
    extras.current?.children.forEach((c, i) => {
      const u = c.userData as { base?: [number, number, number]; kind?: string };
      if (!u.base) return;
      if (u.kind === "dot") {
        const k = 0.7 + 0.3 * Math.sin(t * 5.2 - i * 0.9);
        c.scale.setScalar(k);
        c.position.y = u.base[1] + A * Math.sin(t * 5.2 - i * 0.9) * 0.02;
      } else if (u.kind === "z") {
        const ph = (t * 0.4 + i * 0.5) % 1;
        c.position.set(u.base[0] + ph * 0.15, u.base[1] + ph * 0.3 * A, u.base[2]);
        (c as THREE.Sprite).material.opacity = A ? Math.sin(ph * Math.PI) : 1;
      } else if (u.kind === "spark") {
        c.scale.setScalar((0.12 + 0.07 * Math.sin(t * 4.2 + i * 1.7) * A) * (u.base[2] || 1));
      } else if (u.kind === "pop") {
        c.scale.setScalar(0.24 + 0.04 * Math.sin(t * 7) * A);
      }
    });
  });

  const hw = b.w / 2;
  const crownY = b.top - 0.03;
  const badge = { x: hw - 0.16, y: b.cy - b.h / 2 + 0.16 };
  const fz = (ox: number, oy: number) => frontZ(b, ox, oy);

  return (
    <group ref={root} scale={stage.scale}>
      {blob && (
        <mesh ref={shadow} rotation-x={-Math.PI / 2} position-y={0.002} userData={{ noShadow: true }}>
          <planeGeometry args={[0.95, 0.6]} />
          <meshBasicMaterial map={blobShadow()} transparent depthWrite={false} />
        </mesh>
      )}
      {stageKey === "master" && (
        <sprite position={[0, b.cy + 0.05, -0.4]} scale={1.35} userData={{ noShadow: true }}>
          <spriteMaterial map={glow()} color="#fbbf24" opacity={0.55} transparent depthWrite={false} blending={THREE.AdditiveBlending} />
        </sprite>
      )}
      <mesh ref={footL} position={[-0.11, 0.045, 0.04]} material={mats.limb2}>
        <boxGeometry args={[0.11, 0.08, 0.15]} />
      </mesh>
      <mesh ref={footR} position={[0.11, 0.045, 0.04]} material={mats.limb2}>
        <boxGeometry args={[0.11, 0.08, 0.15]} />
      </mesh>

      <group ref={body}>
        <RoundedBox args={[b.w, b.h, b.d]} radius={b.r} smoothness={5} position-y={b.cy} material={mats.body} />
        {/* visor + face */}
        <group position={[0, wy(70), fz(0, wy(70) - b.cy) - 0.1]}>
          <mesh geometry={screen.visor} material={mats.visor} />
          <mesh geometry={screen.front} position-z={0.134}>
            <meshBasicMaterial map={face.tex} toneMapped={false} />
          </mesh>
        </group>

        {/* antenna + the sprouts that grow with the level */}
        <mesh position={[0, b.top + 0.06, 0]} material={mats.limb}>
          <cylinderGeometry args={[0.014, 0.014, 0.12, 8]} />
        </mesh>
        {SPROUTS.slice(0, sprouts).map(([x, yy, c], i) => (
          <RoundedBox key={i} ref={(m: THREE.Mesh | null) => { sproutRefs.current[i] = m; }} args={[0.08, 0.08, 0.08]} radius={0.02}
            position={[x, b.top + 0.12 + yy, 0]}>
            <meshStandardMaterial color={c as string} emissive={c as string} emissiveIntensity={0.35} roughness={0.4} />
          </RoundedBox>
        ))}

        {/* arms: pivot at the shoulder */}
        <group ref={armL} position={[-(hw + 0.01), wy(69), 0]}>
          <mesh position-y={-0.085} scale={[0.07, 0.105, 0.07]} material={mats.limb}><sphereGeometry args={[1, 16, 12]} /></mesh>
          {activity === "lift" && <Dumbbell />}
        </group>
        <group ref={armR} position={[hw + 0.01, wy(69), 0]}>
          <mesh position-y={-0.085} scale={[0.07, 0.105, 0.07]} material={mats.limb2}><sphereGeometry args={[1, 16, 12]} /></mesh>
          {activity === "lift" && <Dumbbell />}
        </group>

        <Accessory kind={traits.accessory} b={b} mat={mats.accent} />
        {activity && (() => {  // sweatband
          const [gx, gz] = girth(b, 0.1);
          return (
            <mesh position-y={b.top - 0.1} scale={[gx + 0.014, 1, gz + 0.014]}>
              <cylinderGeometry args={[1, 1, 0.06, 40, 1, true]} />
              <meshStandardMaterial color="#ef4444" roughness={0.7} side={THREE.DoubleSide} />
            </mesh>
          );
        })()}

        {stageKey === "baby" && shellGeo && (
          <mesh geometry={shellGeo} material={mats.shell} scale={[1, 1, (b.d / 2 + 0.05) / (b.w / 2 + 0.05)]} />
        )}
        {stageKey === "adult" && (
          <group position={[badge.x, badge.y, fz(badge.x, badge.y - b.cy) - 0.005]} rotation-x={Math.PI / 2}>
            <mesh material={mats.gold}><cylinderGeometry args={[0.065, 0.065, 0.025, 20]} /></mesh>
            <mesh position-y={0.014}><cylinderGeometry args={[0.035, 0.035, 0.01, 5]} /><meshStandardMaterial color="#fff7ed" /></mesh>
          </group>
        )}
        {stageKey === "master" && crownGeo && (
          <mesh geometry={crownGeo} material={mats.gold} position={[0, crownY + 0.05, 0]} />
        )}
      </group>

      {activity && (
        <group ref={sweat}>
          {[0, 1, 2].map((i) => (
            <sprite key={i} scale={0.075} userData={{ noShadow: true }}>
              <spriteMaterial map={sweatDrop()} transparent depthWrite={false} />
            </sprite>
          ))}
        </group>
      )}
      {/* what the mood adds around the head (not during a workout: the sweat says enough) */}
      <group ref={extras} visible={!activity}>
        {mood === "thinking" && [[0.42, 0.86, 0.03], [0.5, 0.96, 0.04], [0.6, 1.08, 0.05]].map(([x, yy, r], i) => (
          <mesh key={i} position={[x, yy, 0]} userData={{ base: [x, yy, 0], kind: "dot" }} material={mats.limb}>
            <sphereGeometry args={[r, 12, 10]} />
          </mesh>
        ))}
        {mood === "sleepy" && [0, 1].map((i) => (
          <sprite key={i} position={[0.4, 0.85, 0]} scale={0.2 - i * 0.05} userData={{ base: [0.4, 0.85, 0], kind: "z" }}>
            <spriteMaterial map={glyph("z", col.mid)} transparent depthWrite={false} />
          </sprite>
        ))}
        {mood === "proud" && [[-0.5, 0.87, 1], [0.48, 0.79, 0.9], [0.44, 0.13, 0.75], [-0.52, 0.17, 0.65]].map(([x, yy, k], i) => (
          <sprite key={i} position={[x, yy, 0.1]} userData={{ base: [x, yy, k], kind: "spark" }}>
            <spriteMaterial map={glyph("✦", "#fbbf24")} transparent depthWrite={false} />
          </sprite>
        ))}
        {(mood === "surprised" || mood === "curious") && (
          <sprite position={[0.44, 0.9, 0]} userData={{ base: [0.44, 0.9, 0], kind: "pop" }}>
            <spriteMaterial map={glyph(mood === "surprised" ? "!" : "?", mood === "surprised" ? "#f59e0b" : col.mid)} transparent depthWrite={false} />
          </sprite>
        )}
      </group>
    </group>
  );
}

/** A small dumbbell held in the hand (the end of the arm), bar pointing forward. */
function Dumbbell() {
  return (
    <group position={[0, -0.185, 0.0]}>
      <mesh rotation-x={Math.PI / 2}>
        <cylinderGeometry args={[0.018, 0.018, 0.26, 12]} />
        <meshStandardMaterial color="#e2e8f0" metalness={0.85} roughness={0.2} />
      </mesh>
      {[-1, 1].map((z) => (
        <group key={z} position-z={z * 0.105}>
          <mesh rotation-x={Math.PI / 2}>
            <cylinderGeometry args={[0.075, 0.075, 0.05, 24]} />
            <meshStandardMaterial color="#64748b" metalness={0.6} roughness={0.3} />
          </mesh>
          <mesh rotation-x={Math.PI / 2} position-z={z * 0.027}>
            <cylinderGeometry args={[0.05, 0.05, 0.008, 20]} />
            <meshStandardMaterial color="#cbd5e1" metalness={0.8} roughness={0.25} />
          </mesh>
        </group>
      ))}
    </group>
  );
}

function Accessory({ kind, b, mat }: { kind: string; b: Dims; mat: THREE.Material }) {
  const hw = b.w / 2;
  switch (kind) {
    case "bow": {
      const x = hw - 0.16;
      const y = b.top - 0.04;
      return (
        <group position={[x, y, b.d * 0.22]} rotation-z={-0.2}>
          <mesh position-x={-0.065} rotation-z={-Math.PI / 2} material={mat}><coneGeometry args={[0.065, 0.12, 14]} /></mesh>
          <mesh position-x={0.065} rotation-z={Math.PI / 2} material={mat}><coneGeometry args={[0.065, 0.12, 14]} /></mesh>
          <mesh material={mat}><sphereGeometry args={[0.035, 12, 10]} /></mesh>
        </group>
      );
    }
    case "cap":
      return (
        <group position-y={b.top - 0.07}>
          <mesh scale={[hw * 0.86, 0.19, b.d * 0.46]} material={mat}>
            <sphereGeometry args={[1, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2]} />
          </mesh>
          <mesh position={[0, 0.01, b.d * 0.42]} rotation-x={0.12} scale={[0.36, 0.022, 0.24]} material={mat}>
            <cylinderGeometry args={[0.5, 0.5, 1, 20, 1, false, -Math.PI / 2, Math.PI]} />
          </mesh>
        </group>
      );
    case "headphones":
      return (
        <group position-y={wy(64)}>
          <mesh material={mat}>
            <torusGeometry args={[hw + 0.05, 0.026, 8, 28, Math.PI]} />
          </mesh>
          {[-1, 1].map((sd) => (
            <mesh key={sd} position-x={sd * (hw + 0.04)} rotation-z={Math.PI / 2} material={mat}>
              <cylinderGeometry args={[0.085, 0.085, 0.09, 20]} />
            </mesh>
          ))}
        </group>
      );
    case "leaf":
      return (
        <group position={[-(hw - 0.2), b.top + 0.02, 0.05]} rotation-z={0.6}>
          <mesh position-x={-0.09} scale={[0.12, 0.03, 0.065]}>
            <sphereGeometry args={[1, 16, 10]} />
            <meshStandardMaterial color="#4ade80" roughness={0.5} />
          </mesh>
          <mesh rotation-z={Math.PI / 2} position-x={-0.03}>
            <cylinderGeometry args={[0.008, 0.008, 0.08, 6]} />
            <meshStandardMaterial color="#15803d" />
          </mesh>
        </group>
      );
    default:
      return null; // "glasses" are drawn on the face screen
  }
}

/** Soft studio light shared by every Pixel (no HDR download: local light-formers only). */
export function PixelLights({ dim = false }: { dim?: boolean }) {
  return (
    <>
      <hemisphereLight args={["#ffffff", "#c4b5fd", dim ? 0.35 : 1.1]} />
      <directionalLight position={[2.5, 4, 4]} intensity={dim ? 1 : 1.9} />
      <directionalLight position={[-3, 2, -3]} intensity={0.9} color="#a5b4fc" />
      <Environment resolution={64} frames={1} environmentIntensity={dim ? 0.35 : 1}>
        <Lightformer form="rect" intensity={2.2} position={[0, 4, 3]} scale={[6, 3, 1]} />
        <Lightformer form="rect" intensity={1.2} position={[-4, 1, 2]} scale={[2, 4, 1]} color="#c4b5fd" />
        <Lightformer form="rect" intensity={1} position={[4, 1, -2]} scale={[2, 4, 1]} color="#fde68a" />
      </Environment>
    </>
  );
}

// ---------- a single avatar on its own little transparent canvas ----------

/**
 * The canvas is larger than the avatar's layout box (room for jumps, waves and the mood extras), so it is
 * absolutely positioned around it. The camera is set so that the box maps exactly onto the model: 1.2 × 1.24
 * world units, the same framing as the SVG viewBox.
 */
const PAD = { x: 0.3, top: 0.3, bottom: 0.2 };
const VIEW_H = 1.24 * (1 + PAD.top + PAD.bottom);
const FOV = 22;
const CAM_Y = wy(0) + 1.24 * PAD.top - VIEW_H / 2;
const CAM_Z = VIEW_H / 2 / Math.tan(((FOV / 2) * Math.PI) / 180);

export function Pixel3DCanvas({
  traits, options, level, mood, bounce, poke, track, animated, onReady, activity = null,
}: {
  activity?: PixelActivity | null;
  traits: PixelTraits;
  options?: PixelOptions | null;
  level: number;
  mood: PixelMood;
  bounce: number;
  poke: number;
  track: boolean;
  animated: boolean;
  onReady?: () => void;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const drive = useRef<PixelDrive>({ walk: 0, yaw: 0, lookX: 0, lookY: 0 });
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => setVisible(e.isIntersecting));
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!track || !animated) { drive.current.lookX = drive.current.lookY = 0; return; }
    const onMove = (e: PointerEvent) => {
      const el = wrap.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const dx = e.clientX - (r.left + r.width / 2);
      const dy = e.clientY - (r.top + r.height * 0.5);
      const d = Math.hypot(dx, dy) || 1;
      const k = Math.min(1, d / 260);
      drive.current.lookX = (dx / d) * k;
      drive.current.lookY = (dy / d) * k;
    };
    window.addEventListener("pointermove", onMove);
    return () => window.removeEventListener("pointermove", onMove);
  }, [track, animated]);

  return (
    <div ref={wrap} aria-hidden className="pointer-events-none absolute"
      style={{ left: `${-PAD.x * 100}%`, right: `${-PAD.x * 100}%`, top: `${-PAD.top * 100}%`, bottom: `${-PAD.bottom * 100}%` }}>
      <Canvas dpr={[1, 2]} frameloop={!visible ? "never" : animated ? "always" : "demand"}
        gl={{ alpha: true, antialias: true, powerPreference: "low-power" }}
        camera={{ fov: FOV, position: [0, CAM_Y, CAM_Z], rotation: [0, 0, 0], near: 0.1, far: 50 }}
        style={{ pointerEvents: "none" }}>
        <PixelLights />
        <PixelModel traits={traits} options={options} level={level} mood={mood} bounce={bounce} poke={poke}
          drive={drive} animated={animated} activity={activity} />
        <FirstFrame onReady={onReady} />
      </Canvas>
    </div>
  );
}

function FirstFrame({ onReady }: { onReady?: () => void }) {
  const done = useRef(false);
  useFrame(() => {
    if (done.current) return;
    done.current = true;
    requestAnimationFrame(() => onReady?.());
  });
  return null;
}

// ---------- capability check ----------

let webgl: boolean | null = null;
/** Is WebGL available here? (checked once; the probe context is released at once) */
export function hasWebGL() {
  if (webgl !== null) return webgl;
  try {
    const c = document.createElement("canvas");
    const g = (c.getContext("webgl2") || c.getContext("webgl")) as WebGLRenderingContext | null;
    webgl = !!g;
    g?.getExtension("WEBGL_lose_context")?.loseContext();
  } catch {
    webgl = false;
  }
  return webgl;
}
