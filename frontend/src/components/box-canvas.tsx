"use client";

import { Check, Focus, Maximize2, Trash2, X, ZoomIn, ZoomOut } from "lucide-react";
import {
  useCallback, useEffect, useLayoutEffect, useRef, useState,
  type CSSProperties, type PointerEvent as ReactPointerEvent,
} from "react";

import type { Detection, Geometry, LabelClass, Proposal } from "@/lib/api";
import { cn, LEVEL_LABEL } from "@/lib/utils";

export type DraftBox = Geometry & {
  key: string;
  id?: number;
  class_id: number;
  proposal_region_id?: number | null;
  proposal_class_id?: number | null;
};

type Props = {
  src: string;
  boxes: DraftBox[];
  proposals?: Proposal[];
  /** boxes of the project's trained detector: solid thin frame, label below, faint when its score is low */
  detections?: Detection[];
  classes: LabelClass[];
  activeClassId?: number | null;
  selectedKey?: string | null;
  readOnly?: boolean;
  /** sizes the viewport (it needs a definite height, e.g. "h-[60vh]" or "flex-1 min-h-0") */
  className?: string;
  onAddBox?: (b: Omit<DraftBox, "key">) => void;
  onSelect?: (key: string | null) => void;
  /** a box was moved or resized (one call per gesture) */
  onChangeBox?: (key: string, g: Geometry) => void;
  onChangeClass?: (key: string, classId: number) => void;
  onDeleteBox?: (key: string) => void;
  onAcceptProposal?: (p: Proposal) => void;
  onRejectProposal?: (p: Proposal) => void;
  /** a click (no drag) outside every box, or Alt+click anywhere: used for click-to-box */
  onPointClick?: (x: number, y: number) => void;
  /** where Pixel is currently looking (pulsing marker) */
  pending?: { x: number; y: number } | null;
  /** the guess highlighted from the keyboard (G): drawn with a thick ring */
  focusedProposalId?: number | null;
  /** the visible part of the image (normalised), whenever the view changes: keyboard-created boxes go there */
  onVisibleChange?: (g: Geometry) => void;
  /** keyboard access: the canvas is focusable, with this name and these instructions (an element id) */
  label?: string;
  describedBy?: string;
};

type View = { z: number; tx: number; ty: number };
type Size = { w: number; h: number };
type Handle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";
type Gesture =
  | { kind: "draw"; x0: number; y0: number; x1: number; y1: number; alt: boolean }
  | { kind: "pan"; cx: number; cy: number; tx: number; ty: number }
  | { kind: "edit"; key: string; handle: Handle | "move"; px: number; py: number; g0: Geometry; moved: boolean };

const MAX_ZOOM = 16;
const PAD = 12; // free space around the fitted image, px
const MIN_SIZE = 0.004;
const HANDLES: Handle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
const HANDLE_POS: Record<Handle, [number, number]> = {
  nw: [0, 0], n: [0.5, 0], ne: [1, 0], e: [1, 0.5], se: [1, 1], s: [0.5, 1], sw: [0, 1], w: [0, 0.5],
};
const HANDLE_CURSOR: Record<Handle, string> = {
  nw: "nwse-resize", se: "nwse-resize", ne: "nesw-resize", sw: "nesw-resize", n: "ns-resize", s: "ns-resize", e: "ew-resize", w: "ew-resize",
};

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

const place = (g: Geometry): CSSProperties => ({
  left: `${g.x * 100}%`,
  top: `${g.y * 100}%`,
  width: `${g.w * 100}%`,
  height: `${g.h * 100}%`,
});

/** the zoomed layer is laid out at its real on-screen size (not CSS-scaled), so overlays stay crisp at any zoom */
const unzoom = (origin: string, extra = ""): CSSProperties => ({ transform: extra.trim() || undefined, transformOrigin: origin });
const px = (n: number) => `${n}px`;

function editGeometry(g0: Geometry, handle: Handle | "move", dx: number, dy: number): Geometry {
  if (handle === "move") {
    return { x: Math.max(0, Math.min(1 - g0.w, g0.x + dx)), y: Math.max(0, Math.min(1 - g0.h, g0.y + dy)), w: g0.w, h: g0.h };
  }
  let x0 = g0.x, y0 = g0.y, x1 = g0.x + g0.w, y1 = g0.y + g0.h;
  if (handle.includes("w")) x0 = clamp01(x0 + dx);
  if (handle.includes("e")) x1 = clamp01(x1 + dx);
  if (handle.includes("n")) y0 = clamp01(y0 + dy);
  if (handle.includes("s")) y1 = clamp01(y1 + dy);
  const x = Math.min(x0, x1), y = Math.min(y0, y1);
  return { x, y, w: Math.max(MIN_SIZE, Math.abs(x1 - x0)), h: Math.max(MIN_SIZE, Math.abs(y1 - y0)) };
}

/**
 * Annotation canvas: drag to draw a box with the active class, click a box to select it
 * (then drag it, resize it from the handles, change its class from the little toolbar).
 * Wheel = zoom around the pointer, Space+drag or middle button = pan, + / - / 0 = zoom keys.
 * Pixel's proposals are dashed (guesses), confirmed boxes are solid (knowledge).
 */
export function BoxCanvas({
  src, boxes, proposals = [], detections = [], classes, activeClassId, selectedKey, readOnly, className,
  onAddBox, onSelect, onChangeBox, onChangeClass, onDeleteBox, onAcceptProposal, onRejectProposal, onPointClick, pending,
  focusedProposalId, onVisibleChange, label, describedBy,
}: Props) {
  const viewport = useRef<HTMLDivElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const [vp, setVp] = useState<Size>({ w: 0, h: 0 });
  const [natural, setNatural] = useState<Size | null>(null);
  const [view, setView] = useState<View>({ z: 1, tx: 0, ty: 0 });
  const [gesture, setGesture] = useState<Gesture | null>(null);
  const [hover, setHover] = useState<{ x: number; y: number } | null>(null);
  const [space, setSpace] = useState(false);
  const byId = new Map(classes.map((c) => [c.id, c]));

  // ---- geometry: the image is fitted into the viewport (base size), then zoomed/panned with a transform
  const base: Size = natural && vp.w > 0
    ? (() => {
      const s = Math.min((vp.w - 2 * PAD) / natural.w, (vp.h - 2 * PAD) / natural.h);
      return { w: Math.max(1, natural.w * s), h: Math.max(1, natural.h * s) };
    })()
    : { w: 0, h: 0 };

  const clampView = useCallback((v: View, b: Size, size: Size): View => {
    const z = Math.max(1, Math.min(MAX_ZOOM, v.z));
    const fix = (t: number, content: number, room: number) => {
      if (content <= room) return (room - content) / 2;
      return Math.min(PAD * 3, Math.max(room - content - PAD * 3, t));
    };
    return { z, tx: fix(v.tx, b.w * z, size.w), ty: fix(v.ty, b.h * z, size.h) };
  }, []);

  const v = clampView(view, base, vp);
  const visKey = base.w ? [v.z, Math.round(v.tx), Math.round(v.ty), Math.round(vp.w), Math.round(vp.h)].join(":") : "";
  useEffect(() => {
    if (!visKey || !onVisibleChange) return;
    const { v: cur, base: b, vp: size } = live.current;
    const x0 = clamp01(-cur.tx / (b.w * cur.z)), y0 = clamp01(-cur.ty / (b.h * cur.z));
    const x1 = clamp01((size.w - cur.tx) / (b.w * cur.z)), y1 = clamp01((size.h - cur.ty) / (b.h * cur.z));
    onVisibleChange({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
  }, [visKey, onVisibleChange]); // eslint-disable-line react-hooks/exhaustive-deps
  const live = useRef({ v, base, vp });
  live.current = { v, base, vp };

  useLayoutEffect(() => {
    const el = viewport.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setVp({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // new image: forget the old size and zoom
  useEffect(() => {
    setNatural(null);
    setView({ z: 1, tx: 0, ty: 0 });
    const img = imgRef.current;
    if (img?.complete && img.naturalWidth) setNatural({ w: img.naturalWidth, h: img.naturalHeight });
  }, [src]);

  /** zoom by `factor` keeping the viewport point (cx, cy) still */
  const zoomAt = useCallback((factor: number, cx?: number, cy?: number) => {
    const { v: cur, base: b, vp: size } = live.current;
    const x = cx ?? size.w / 2, y = cy ?? size.h / 2;
    const z = Math.max(1, Math.min(MAX_ZOOM, cur.z * factor));
    const k = z / cur.z;
    setView(clampView({ z, tx: x - (x - cur.tx) * k, ty: y - (y - cur.ty) * k }, b, size));
  }, [clampView]);

  const fit = useCallback(() => setView({ z: 1, tx: 0, ty: 0 }), []);

  /** frame a region of the image (normalised) with some margin */
  const zoomTo = useCallback((g: Geometry) => {
    const { base: b, vp: size } = live.current;
    if (!b.w) return;
    const z = Math.max(1, Math.min(MAX_ZOOM, 0.6 * Math.min(size.w / (g.w * b.w), size.h / (g.h * b.h))));
    const cx = (g.x + g.w / 2) * b.w * z, cy = (g.y + g.h / 2) * b.h * z;
    setView(clampView({ z, tx: size.w / 2 - cx, ty: size.h / 2 - cy }, b, size));
  }, [clampView]);

  // wheel = zoom (native listener: React's wheel handler is passive and can't stop the page scrolling)
  useEffect(() => {
    const el = viewport.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const d = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      zoomAt(Math.exp(-d * 0.0018), e.clientX - r.left, e.clientY - r.top);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomAt]);

  // keys: Space (hold) = pan, + / - / 0 = zoom
  useEffect(() => {
    const typing = (t: EventTarget | null) => {
      const tag = (t as HTMLElement | null)?.tagName;
      return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (t as HTMLElement | null)?.isContentEditable;
    };
    const down = (e: KeyboardEvent) => {
      if (typing(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === " ") {
        if ((e.target as HTMLElement)?.tagName !== "BUTTON") e.preventDefault();
        setSpace(true);
      } else if (e.key === "+" || e.key === "=") zoomAt(1.4);
      else if (e.key === "-" || e.key === "_") zoomAt(1 / 1.4);
      else if (e.key === "0") fit();
    };
    const up = (e: KeyboardEvent) => { if (e.key === " ") setSpace(false); };
    const blur = () => setSpace(false);
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
    };
  }, [zoomAt, fit]);

  // ---- pointer gestures (all captured by the viewport)
  const norm = (e: { clientX: number; clientY: number }) => {
    const r = wrap.current!.getBoundingClientRect(); // includes the zoom transform
    return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
  };
  const inside = (p: { x: number; y: number }) => p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1;
  const canDraw = !readOnly && activeClassId != null;

  const capture = (e: ReactPointerEvent) => viewport.current?.setPointerCapture(e.pointerId);

  const startPan = (e: ReactPointerEvent) => {
    e.preventDefault();
    capture(e);
    setGesture({ kind: "pan", cx: e.clientX, cy: e.clientY, tx: v.tx, ty: v.ty });
  };

  const startEdit = (e: ReactPointerEvent, b: DraftBox, handle: Handle | "move") => {
    if (readOnly || e.button !== 0 || space) return; // let pan gestures through
    e.stopPropagation();
    capture(e);
    const p = norm(e);
    setGesture({ kind: "edit", key: b.key, handle, px: p.x, py: p.y, g0: { x: b.x, y: b.y, w: b.w, h: b.h }, moved: false });
  };

  const onPointerDown = (e: ReactPointerEvent) => {
    if (e.button === 1 || (e.button === 0 && (space || readOnly))) return startPan(e);
    if (e.button !== 0 || readOnly) return;
    const p = norm(e);
    if (!inside(p)) { onSelect?.(null); return; }
    capture(e);
    setGesture({ kind: "draw", x0: p.x, y0: p.y, x1: p.x, y1: p.y, alt: e.altKey });
  };

  const onPointerMove = (e: ReactPointerEvent) => {
    const p = norm(e);
    setHover(inside(p) ? p : null);
    if (!gesture) return;
    if (gesture.kind === "pan") {
      setView(clampView({ z: v.z, tx: gesture.tx + e.clientX - gesture.cx, ty: gesture.ty + e.clientY - gesture.cy }, base, vp));
    } else if (gesture.kind === "draw") {
      setGesture({ ...gesture, x1: clamp01(p.x), y1: clamp01(p.y) });
    } else {
      const moved = gesture.moved || Math.abs(p.x - gesture.px) * base.w * v.z > 3 || Math.abs(p.y - gesture.py) * base.h * v.z > 3;
      setGesture({ ...gesture, moved });
    }
    if (gesture.kind === "edit") lastPoint.current = p;
  };
  const lastPoint = useRef<{ x: number; y: number } | null>(null);

  const editing = gesture?.kind === "edit" && gesture.moved && lastPoint.current
    ? { key: gesture.key, g: editGeometry(gesture.g0, gesture.handle, lastPoint.current.x - gesture.px, lastPoint.current.y - gesture.py) }
    : null;

  const onPointerUp = () => {
    const g = gesture;
    setGesture(null);
    if (!g) return;
    if (g.kind === "edit") {
      if (editing) onChangeBox?.(editing.key, editing.g);
      lastPoint.current = null;
      return;
    }
    if (g.kind !== "draw") return;
    const r = rect(g);
    if (r.w > 0.01 && r.h > 0.01 && canDraw) {
      onSelect?.(null);
      onAddBox?.({ ...r, class_id: activeClassId! });
      return;
    }
    const tiny = r.w * base.w * v.z < 5 && r.h * base.h * v.z < 5;
    if (!tiny) return;
    // a click: select the smallest box under the pointer, else ask Pixel for a magic box
    const hit = g.alt ? undefined : boxes
      .filter((b) => g.x0 >= b.x && g.x0 <= b.x + b.w && g.y0 >= b.y && g.y0 <= b.y + b.h)
      .sort((a, b) => a.w * a.h - b.w * b.h)[0];
    if (hit) onSelect?.(hit.key);
    else {
      onSelect?.(null);
      if (canDraw) onPointClick?.(g.x0, g.y0);
    }
  };

  const rect = (d: { x0: number; y0: number; x1: number; y1: number }): Geometry => ({
    x: Math.min(d.x0, d.x1), y: Math.min(d.y0, d.y1), w: Math.abs(d.x1 - d.x0), h: Math.abs(d.y1 - d.y0),
  });

  const panning = gesture?.kind === "pan";
  const zoomed = v.z > 1.01;
  const cursor = panning ? "grabbing" : space || (readOnly && zoomed) ? "grab" : canDraw ? "crosshair" : "default";
  const ready = !!natural && base.w > 0;
  const shown = boxes.map((b) => (editing && editing.key === b.key ? { ...b, ...editing.g } : b));
  const selectedBox = shown.find((b) => b.key === selectedKey) ?? null;

  return (
    <div
      ref={viewport}
      className={cn("canvas-grid relative touch-none select-none overflow-hidden focus-visible:outline-offset-[-3px]", className)}
      style={{ cursor }}
      data-canvas=""
      tabIndex={label ? 0 : undefined}
      role={label ? "application" : undefined}
      aria-roledescription={label ? "annotation canvas" : undefined}
      aria-label={label}
      aria-describedby={describedBy}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => { setGesture(null); lastPoint.current = null; }}
      onPointerLeave={() => setHover(null)}
      onAuxClick={(e) => e.preventDefault()}
    >
      <div
        ref={wrap}
        className={cn("absolute left-0 top-0", !ready && "invisible")}
        style={{
          width: ready ? base.w * v.z : undefined,
          height: ready ? base.h * v.z : undefined,
          transform: `translate(${v.tx}px, ${v.ty}px)`,
          transition: gesture ? "none" : "transform 120ms ease-out, width 120ms ease-out, height 120ms ease-out",
        }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img ref={imgRef} src={src} alt="" draggable={false}
          onLoad={(e) => setNatural({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
          className={cn("block shadow-2xl shadow-black/40", ready && "h-full w-full")}
          style={{ imageRendering: v.z >= 4 ? "pixelated" : undefined, borderRadius: px(6) }} />

        {/* crosshair guides while drawing */}
        {canDraw && hover && !panning && !space && gesture?.kind !== "edit" && (
          <>
            <div className="pointer-events-none absolute inset-x-0 bg-white/50 mix-blend-difference" style={{ top: `${hover.y * 100}%`, height: px(1) }} />
            <div className="pointer-events-none absolute inset-y-0 bg-white/50 mix-blend-difference" style={{ left: `${hover.x * 100}%`, width: px(1) }} />
          </>
        )}

        {pending && (
          <span className="pointer-events-none absolute z-10" style={{ left: `${pending.x * 100}%`, top: `${pending.y * 100}%`, ...unzoom("0 0", " translate(-50%, -50%)") }}>
            <span className="absolute -inset-4 animate-ping rounded-full bg-pixel/40" />
            <span className="relative block h-3 w-3 rounded-full bg-pixel ring-2 ring-white" />
          </span>
        )}

        {proposals.map((p) => {
          const c = byId.get(p.class_id);
          const color = c?.color ?? "#888";
          const inner = p.y < 0.06;
          return (
            <div key={`p${p.id}`} className="pointer-events-none absolute border-dashed"
              style={{ ...place(p), borderColor: color, borderWidth: px(focusedProposalId === p.id ? 3 : 2),
                outline: focusedProposalId === p.id ? `3px solid ${color}` : undefined, outlineOffset: px(3),
                boxShadow: focusedProposalId === p.id ? "0 0 0 9999px rgba(0,0,0,0.35)" : undefined,
                zIndex: focusedProposalId === p.id ? 4 : undefined }}>
              <div className={cn("pointer-events-auto absolute left-0 flex items-center gap-1 whitespace-nowrap rounded px-1.5 py-0.5 text-xs font-medium text-white shadow",
                inner ? "top-0" : "bottom-full mb-0.5")}
                style={{ backgroundColor: color, ...unzoom(inner ? "top left" : "bottom left") }}
                onPointerDown={(e) => { if (e.button === 0 && !space) e.stopPropagation(); }}>
                <span>{c?.name ?? "?"} <span className="opacity-80">· {LEVEL_LABEL[p.level]}</span></span>
                {!readOnly && (
                  <>
                    <button type="button" tabIndex={label ? -1 : undefined} title="Correct (A)" aria-label={`Correct: ${c?.name ?? "object"}`} className="rounded bg-white/25 p-0.5 hover:bg-white/40" onClick={() => onAcceptProposal?.(p)}>
                      <Check className="h-3 w-3" />
                    </button>
                    <button type="button" tabIndex={label ? -1 : undefined} title="Not there (X)" aria-label={`Not there: ${c?.name ?? "object"}`} className="rounded bg-white/25 p-0.5 hover:bg-white/40" onClick={() => onRejectProposal?.(p)}>
                      <X className="h-3 w-3" />
                    </button>
                  </>
                )}
              </div>
            </div>
          );
        })}

        {detections.map((d, i) => {
          const color = byId.get(d.class_id)?.color ?? "#888";
          const inner = d.y + d.h > 0.94;
          return (
            <div key={`d${i}`} className={cn("pointer-events-none absolute", d.score < 0.3 && "opacity-45")}
              style={{ ...place(d), border: `${px(1.5)} solid ${color}`, borderRadius: px(2), boxShadow: `0 0 0 ${px(1)} rgba(0,0,0,0.35)` }}>
              <span className={cn("absolute left-0 flex items-center gap-1 whitespace-nowrap rounded bg-slate-950/85 px-1.5 py-0.5 text-[11px] font-medium text-white shadow",
                inner ? "bottom-0" : "top-full mt-0.5")} style={unzoom(inner ? "bottom left" : "top left")}>
                <span className="h-2 w-2 rounded-full" style={{ backgroundColor: color }} />
                {d.class_name} <span className="tabular-nums opacity-70">{d.score.toFixed(2)}</span>
              </span>
            </div>
          );
        })}

        {shown.map((b) => {
          const c = byId.get(b.class_id);
          const color = c?.color ?? "#888";
          const sel = selectedKey === b.key;
          const inner = b.y < 0.06;
          return (
            <div key={b.key}
              className={cn("absolute", sel && !readOnly ? "pointer-events-auto" : "pointer-events-none",
                !editing && "transition-[left,top,width,height] duration-300 ease-out")}
              style={{
                ...place(b),
                border: `${px(2)} solid ${color}`,
                backgroundColor: sel ? `${color}33` : `${color}1f`,
                outline: sel ? `${px(2)} solid ${color}` : undefined,
                outlineOffset: px(2),
                cursor: sel && !readOnly && !space ? "move" : undefined,
                zIndex: sel ? 5 : undefined,
              }}
              onPointerDown={(e) => startEdit(e, b, "move")}>
              <button type="button" tabIndex={label ? -1 : undefined}
                className={cn("pointer-events-auto absolute left-0 whitespace-nowrap rounded px-1.5 py-0.5 text-xs font-semibold text-white shadow",
                  inner ? "top-0" : "bottom-full mb-0.5")}
                style={{ backgroundColor: color, ...unzoom(inner ? "top left" : "bottom left") }}
                onPointerDown={(e) => { if (e.button === 0 && !space) e.stopPropagation(); }}
                onClick={() => !readOnly && onSelect?.(sel ? null : b.key)}>
                {c?.name ?? "?"}
              </button>
              {sel && !readOnly && HANDLES.map((h) => (
                <span key={h} className="absolute rounded-[2px] border-white bg-slate-950 shadow"
                  style={{
                    left: `${HANDLE_POS[h][0] * 100}%`, top: `${HANDLE_POS[h][1] * 100}%`,
                    width: px(10), height: px(10), borderWidth: px(2), borderColor: color,
                    transform: "translate(-50%, -50%)", cursor: HANDLE_CURSOR[h],
                  }}
                  onPointerDown={(e) => startEdit(e, b, h)} />
              ))}
            </div>
          );
        })}

        {/* little toolbar of the selected box: change class, frame it, delete it */}
        {selectedBox && !readOnly && !gesture && (() => {
          const b = selectedBox;
          const below = b.y + b.h < 0.8;
          const right = b.x > 0.55;
          const style: CSSProperties = {
            ...(below ? { top: `${(b.y + b.h) * 100}%` } : { bottom: `${(1 - b.y) * 100}%` }),
            ...(right ? { right: `${(1 - b.x - b.w) * 100}%` } : { left: `${b.x * 100}%` }),
            ...unzoom(`${below ? "top" : "bottom"} ${right ? "right" : "left"}`, below ? " translateY(8px)" : " translateY(-30px)"),
          };
          return (
            <div className="absolute z-20 flex max-w-[340px] animate-in fade-in zoom-in-95 flex-wrap items-center gap-1 rounded-xl border border-white/10 bg-slate-950/90 p-1.5 text-white shadow-2xl backdrop-blur duration-150"
              style={style} onPointerDown={(e) => e.stopPropagation()}>
              {classes.map((c, i) => (
                <button key={c.id} type="button" title={`Change to ${c.name} (${i + 1})`} aria-label={`Change to ${c.name}`} aria-pressed={c.id === b.class_id}
                  onClick={() => onChangeClass?.(b.key, c.id)}
                  className={cn("flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium transition",
                    c.id === b.class_id ? "text-white" : "text-white/75 hover:bg-white/10")}
                  style={c.id === b.class_id ? { backgroundColor: c.color } : undefined}>
                  {c.id !== b.class_id && <span className="h-2 w-2 rounded-full" style={{ backgroundColor: c.color }} />}
                  {c.name}{i < 9 && <kbd className="text-[9px] opacity-80">{i + 1}</kbd>}
                </button>
              ))}
              <span className="mx-0.5 h-5 w-px bg-white/15" />
              <button type="button" title="Zoom to this box" aria-label="Zoom to this box" className="rounded-lg p-1.5 text-white/75 hover:bg-white/10" onClick={() => zoomTo(b)}>
                <Focus className="h-3.5 w-3.5" />
              </button>
              <button type="button" title="Delete (Del)" aria-label="Delete this box" className="rounded-lg p-1.5 text-rose-300 hover:bg-rose-500/20" onClick={() => onDeleteBox?.(b.key)}>
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          );
        })()}

        {gesture?.kind === "draw" && (
          <div className="pointer-events-none absolute border-pixel bg-pixel/10" style={{ ...place(rect(gesture)), borderWidth: px(2) }} />
        )}
      </div>

      {/* zoom controls */}
      {ready && (
        <div className="absolute bottom-3 right-3 z-30 flex items-center gap-0.5 rounded-xl border border-white/10 bg-slate-950/75 p-1 text-white shadow-lg backdrop-blur"
          onPointerDown={(e) => e.stopPropagation()}>
          <button type="button" title="Zoom out (-)" aria-label="Zoom out" className="rounded-lg p-1.5 hover:bg-white/10 disabled:opacity-40" disabled={!zoomed} onClick={() => zoomAt(1 / 1.4)}>
            <ZoomOut className="h-4 w-4" />
          </button>
          <button type="button" title="Fit (0)" aria-label={`Zoom ${Math.round(v.z * 100)}%: fit the image`} className="min-w-[3.25rem] rounded-lg px-1.5 py-1 text-xs font-semibold tabular-nums hover:bg-white/10" onClick={fit}>
            {Math.round(v.z * 100)}%
          </button>
          <button type="button" title="Zoom in (+ or wheel)" aria-label="Zoom in" className="rounded-lg p-1.5 hover:bg-white/10 disabled:opacity-40" disabled={v.z >= MAX_ZOOM} onClick={() => zoomAt(1.4)}>
            <ZoomIn className="h-4 w-4" />
          </button>
          {zoomed && (
            <button type="button" title="Fit the whole image (0)" aria-label="Fit the whole image" className="rounded-lg p-1.5 hover:bg-white/10" onClick={fit}>
              <Maximize2 className="h-4 w-4" />
            </button>
          )}
        </div>
      )}

      {/* minimap: where you are in the image; click or drag to move there */}
      {ready && zoomed && <MiniMap src={src} base={base} view={v} vp={vp}
        onCenter={(x, y) => setView(clampView({ z: v.z, tx: vp.w / 2 - x * base.w * v.z, ty: vp.h / 2 - y * base.h * v.z }, base, vp))} />}

      {ready && zoomed && !readOnly && (
        <p className="pointer-events-none absolute left-1/2 top-3 z-30 -translate-x-1/2 rounded-full bg-slate-950/70 px-3 py-1 text-[11px] text-white/80 backdrop-blur">
          Space + drag (or middle button) to move · 0 to fit
        </p>
      )}
    </div>
  );
}

function MiniMap({ src, base, view, vp, onCenter }: {
  src: string; base: Size; view: View; vp: Size; onCenter: (x: number, y: number) => void;
}) {
  const w = base.w >= base.h ? 150 : Math.round((150 * base.w) / base.h);
  const h = Math.round((w * base.h) / base.w);
  const x0 = clamp01(-view.tx / (base.w * view.z)), y0 = clamp01(-view.ty / (base.h * view.z));
  const x1 = clamp01((vp.w - view.tx) / (base.w * view.z)), y1 = clamp01((vp.h - view.ty) / (base.h * view.z));
  const [dragging, setDragging] = useState(false);
  const go = (e: ReactPointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    onCenter(clamp01((e.clientX - r.left) / r.width), clamp01((e.clientY - r.top) / r.height));
  };
  return (
    <div className="absolute bottom-3 left-3 z-30 animate-in fade-in cursor-pointer overflow-hidden rounded-lg border border-white/15 shadow-lg"
      style={{ width: w, height: h }}
      onPointerDown={(e) => { e.stopPropagation(); e.currentTarget.setPointerCapture(e.pointerId); setDragging(true); go(e); }}
      onPointerMove={(e) => { e.stopPropagation(); if (dragging) go(e); }}
      onPointerUp={(e) => { e.stopPropagation(); setDragging(false); }}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={src} alt="" draggable={false} className="h-full w-full object-fill opacity-80" />
      <div className="pointer-events-none absolute border-2 border-white shadow-[0_0_0_999px_rgba(0,0,0,0.45)]"
        style={{ left: `${x0 * 100}%`, top: `${y0 * 100}%`, width: `${(x1 - x0) * 100}%`, height: `${(y1 - y0) * 100}%` }} />
    </div>
  );
}
