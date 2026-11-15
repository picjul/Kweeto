import type { Geometry } from "@/lib/api";
import { fileUrl } from "@/lib/api";
import { cn } from "@/lib/utils";

export type ThumbOverlay = Geometry & { color: string; dashed?: boolean; label?: string };

/** Thumbnail with a box (or several) drawn on top (Harvest, Questions, Health, lesson recap). */
export function ThumbBox({ thumbUrl, box, boxes, color = "#7c3aed", className, dim, alt = "" }: {
  thumbUrl: string | null;
  box?: Geometry;
  boxes?: ThumbOverlay[];
  color?: string;
  className?: string;
  dim?: boolean;
  alt?: string;
}) {
  const all: ThumbOverlay[] = [...(box ? [{ ...box, color }] : []), ...(boxes ?? [])];
  return (
    <div className={cn("relative overflow-hidden rounded-md bg-muted", className)}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={fileUrl(thumbUrl)} alt={alt} loading="lazy" draggable={false}
        className={cn("block h-auto w-full", dim && "opacity-40")} />
      {all.map((b, i) => (
        <div key={i} className={cn("pointer-events-none absolute border-2", b.dashed && "border-dashed")} title={b.label}
          style={{ left: `${b.x * 100}%`, top: `${b.y * 100}%`, width: `${b.w * 100}%`, height: `${b.h * 100}%`, borderColor: b.color }} />
      ))}
    </div>
  );
}

/** A zoomed crop of the full image around one box (with some context), the box outlined. */
export function BoxCrop({ url, box, color, width, height, className, alt = "" }: {
  url: string;
  box: Geometry;
  color: string;
  /** image size in pixels (keeps the crop's aspect right) */
  width: number;
  height: number;
  className?: string;
  alt?: string;
}) {
  // a square-ish window around the box: 1.6x its size, at least 12% of the image, clamped to the image
  const side = Math.max(box.w * width, box.h * height) * 1.6;
  const vw = Math.min(1, Math.max(0.12, side / width));
  const vh = Math.min(1, Math.max(0.12, side / height));
  const vx = Math.min(1 - vw, Math.max(0, box.x + box.w / 2 - vw / 2));
  const vy = Math.min(1 - vh, Math.max(0, box.y + box.h / 2 - vh / 2));
  return (
    <div className={cn("relative overflow-hidden rounded-lg bg-muted canvas-grid", className)}
      style={{ aspectRatio: `${vw * width} / ${vh * height}` }}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={fileUrl(url)} alt={alt} loading="lazy" draggable={false} className="absolute max-w-none"
        style={{ width: `${100 / vw}%`, height: `${100 / vh}%`, left: `${(-vx / vw) * 100}%`, top: `${(-vy / vh) * 100}%` }} />
      <div className="pointer-events-none absolute rounded-[3px] border-2 shadow-[0_0_0_1px_rgba(0,0,0,0.35)]"
        style={{
          left: `${((box.x - vx) / vw) * 100}%`, top: `${((box.y - vy) / vh) * 100}%`,
          width: `${(box.w / vw) * 100}%`, height: `${(box.h / vh) * 100}%`, borderColor: color,
        }} />
    </div>
  );
}
