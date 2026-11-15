"use client";

import { Check, Copy, Download, Share2, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { PixelAvatar, STAGES, levelFromBoxes, levelTitle, stageOf } from "@/components/pixel";
import { useProject } from "@/components/project-context";
import { Button } from "@/components/ui/button";
import { api, type Stats } from "@/lib/api";
import { play } from "@/lib/sound";

/**
 * Pixel's card: a 1200x630 PNG (the usual social preview size) with the open project's Pixel and TRUE numbers
 * from /api/stats only (rule 2: no invented progress). Drawn in the browser on a canvas: download, copy, share.
 */

const EVT = "kweeto:share-card";
const W = 1200;
const H = 630;

export function openShareCard() {
  window.dispatchEvent(new Event(EVT));
}

type CardData = {
  name: string; project: string; level: number; stage: string; title: string; accent: string;
  boxes: number; images: number; classes: number; propagated: number; verified: number;
  learning: Stats["learning"];
};

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

async function svgImage(svg: SVGSVGElement, size: number): Promise<HTMLImageElement> {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  clone.setAttribute("width", String(size));
  clone.setAttribute("height", String((size * 124) / 120));
  const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(clone)], { type: "image/svg+xml" }));
  try {
    const img = new Image();
    img.decoding = "async";
    img.src = url;
    await img.decode();
    return img;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

const fmt = (n: number) => n.toLocaleString("en-US");

async function drawCard(svg: SVGSVGElement, d: CardData): Promise<HTMLCanvasElement> {
  await document.fonts?.ready;
  const font = getComputedStyle(document.body).fontFamily || "sans-serif";
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const ctx = c.getContext("2d")!;
  const accent = `hsl(${d.accent})`;
  const accentA = (a: number) => `hsl(${d.accent} / ${a})`;

  // background: the dark annotation canvas, a dotted grid and the Pixel's colour as a glow
  ctx.fillStyle = "#17152b";
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = "rgba(255,255,255,0.08)";
  for (let y = 9; y < H; y += 18) for (let x = 9; x < W; x += 18) ctx.fillRect(x, y, 1.5, 1.5);
  const glow = ctx.createRadialGradient(300, 330, 20, 300, 330, 380);
  glow.addColorStop(0, accentA(0.55));
  glow.addColorStop(1, accentA(0));
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);
  const band = ctx.createLinearGradient(0, 0, W, 0);
  band.addColorStop(0, accent);
  band.addColorStop(1, "#f59e0b");
  ctx.fillStyle = band;
  ctx.fillRect(0, 0, W, 8);

  // Pixel
  const img = await svgImage(svg, 420);
  ctx.drawImage(img, 90, 105, 420, 434);

  // name, level, project
  const x0 = 560;
  ctx.fillStyle = "#ffffff";
  ctx.font = `800 68px ${font}`;
  ctx.fillText(d.name, x0, 150, W - x0 - 60);
  ctx.fillStyle = accent;
  ctx.font = `700 28px ${font}`;
  ctx.fillText(`Level ${d.level} · ${d.stage} · ${d.title}`, x0, 196, W - x0 - 60);
  ctx.fillStyle = "rgba(255,255,255,0.65)";
  ctx.font = `500 22px ${font}`;
  ctx.fillText(`Apprentice of the project “${d.project}”`, x0, 234, W - x0 - 60);

  // true numbers
  const tiles: [string, string][] = [
    [fmt(d.boxes), d.boxes === 1 ? "example taught" : "examples taught"],
    [fmt(d.images), d.images === 1 ? "image seen" : "images seen"],
    [fmt(d.classes), d.classes === 1 ? "class known" : "classes known"],
    [`⚡ ${fmt(d.propagated)}`, "times it changed its mind"],
  ];
  const tw = 145;
  tiles.forEach(([v, l], i) => {
    const x = x0 + i * (tw + 12);
    roundRect(ctx, x, 274, tw, 108, 18);
    ctx.fillStyle = "rgba(255,255,255,0.07)";
    ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,0.12)";
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.fillStyle = "#ffffff";
    ctx.font = `800 34px ${font}`;
    ctx.fillText(v, x + 16, 326, tw - 26);
    ctx.fillStyle = "rgba(255,255,255,0.6)";
    ctx.font = `500 15px ${font}`;
    const words = l.split(" ");
    const half = Math.ceil(words.length / 2);
    ctx.fillText(words.slice(0, half).join(" "), x + 16, 352, tw - 26);
    ctx.fillText(words.slice(half).join(" "), x + 16, 371, tw - 26);
  });

  // the learning proof, only when there is one (first judged guesses vs the latest)
  ctx.font = `500 21px ${font}`;
  ctx.fillStyle = "rgba(255,255,255,0.85)";
  const lines: string[] = [];
  if (d.learning) {
    const { first, recent } = d.learning;
    lines.push(`First ${first.total} guesses: ${first.right} right. Latest ${recent.total}: ${recent.right} right.`);
  }
  if (d.verified > 0) lines.push(`${fmt(d.verified)} ${d.verified === 1 ? "image" : "images"} finished together.`);
  if (!lines.length) lines.push("Just hatched: every box you draw teaches it something.");
  lines.slice(0, 2).forEach((t, i) => ctx.fillText(t, x0, 432 + i * 34, W - x0 - 60));

  // footer
  ctx.fillStyle = "rgba(255,255,255,0.45)";
  ctx.font = `600 18px ${font}`;
  ctx.fillText(`Taught with Kweeto · ${new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })}`, x0, 572);
  return c;
}

/** Mounted once (layout): listens for `openShareCard()` and shows the card with its actions. */
export function ShareCardHost() {
  const { project } = useProject();
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<CardData | null>(null);
  const [png, setPng] = useState<{ url: string; blob: Blob } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const avatar = useRef<HTMLDivElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const back = useRef<HTMLElement | null>(null);

  const close = useCallback(() => {
    setOpen(false);
    setPng((p) => { if (p) URL.revokeObjectURL(p.url); return null; });
    setData(null);
    requestAnimationFrame(() => back.current?.focus?.());
  }, []);

  useEffect(() => {
    const onOpen = () => {
      back.current = document.activeElement as HTMLElement | null;
      setError(null);
      setCopied(false);
      setOpen(true);
    };
    window.addEventListener(EVT, onOpen);
    return () => window.removeEventListener(EVT, onOpen);
  }, []);

  // 1. the numbers
  useEffect(() => {
    if (!open || !project) return;
    api.stats().then((s) => {
      const level = levelFromBoxes(s.boxes);
      setData({
        name: project.pixel.name, project: project.name, level, stage: STAGES[stageOf(level)].label, title: levelTitle(level),
        accent: project.accent.light, boxes: s.boxes, images: s.images.total, classes: s.classes.length,
        propagated: s.propagated, verified: s.verified, learning: s.learning,
      });
    }).catch((e) => setError((e as Error).message));
  }, [open, project]);

  // 2. the picture (once the hidden 2D Pixel is rendered)
  useEffect(() => {
    if (!data) return;
    let gone = false;
    const t = setTimeout(async () => {
      const svg = avatar.current?.querySelector("svg");
      if (!svg) return;
      try {
        const canvas = await drawCard(svg, data);
        const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/png"));
        if (!blob || gone) return;
        setPng({ url: URL.createObjectURL(blob), blob });
        play("proud");
      } catch (e) {
        setError(`Could not draw the card: ${(e as Error).message}`);
      }
    }, 60);
    return () => { gone = true; clearTimeout(t); };
  }, [data]);

  useEffect(() => { if (png) dialog.current?.querySelector<HTMLButtonElement>("button[data-primary]")?.focus(); }, [png]);

  if (!open) return null;
  const file = () => new File([png!.blob], `${(data?.name ?? "pixel").toLowerCase().replace(/[^a-z0-9]+/g, "-")}-card.png`, { type: "image/png" });
  const canCopy = typeof window !== "undefined" && "ClipboardItem" in window && !!navigator.clipboard?.write;
  const canShare = typeof navigator !== "undefined" && !!navigator.canShare && !!png && navigator.canShare({ files: [file()] });

  const download = () => {
    const a = document.createElement("a");
    a.href = png!.url;
    a.download = file().name;
    a.click();
  };
  const copy = async () => {
    try {
      await navigator.clipboard.write([new ClipboardItem({ "image/png": png!.blob })]);
      setCopied(true);
    } catch (e) {
      setError(`Copy failed: ${(e as Error).message}`);
    }
  };
  const share = async () => {
    try { await navigator.share({ files: [file()], title: `${data?.name}, my Kweeto apprentice` }); } catch { /* cancelled */ }
  };

  return (
    <div className="fixed inset-0 z-[95] flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm animate-in fade-in duration-150"
      onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}
      onKeyDown={(e) => {
        if (e.key === "Escape") { e.stopPropagation(); close(); return; }
        if (e.key !== "Tab" || !dialog.current) return; // keep the keyboard inside the dialog
        const els = Array.from(dialog.current.querySelectorAll<HTMLElement>("button:not([disabled]), [href], [tabindex='0']"));
        if (!els.length) return;
        const first = els[0], last = els[els.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }}>
      <div ref={dialog} role="dialog" aria-modal="true" aria-labelledby="share-card-title"
        className="w-full max-w-3xl space-y-4 rounded-2xl border bg-card p-5 shadow-2xl animate-in zoom-in-95 duration-150">
        <div className="flex items-center gap-2">
          <Share2 className="h-5 w-5 text-pixel" aria-hidden />
          <h2 id="share-card-title" className="flex-1 text-lg font-bold">{data ? `${data.name}'s card` : "Pixel's card"}</h2>
          <button type="button" onClick={close} aria-label="Close" className="rounded-lg p-1.5 hover:bg-accent"><X className="h-4 w-4" /></button>
        </div>
        {!project ? (
          <p className="text-sm text-muted-foreground">Open a project first: the card shows its Pixel.</p>
        ) : png ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={png.url} alt={data ? `${data.name}, level ${data.level} ${data.stage.toLowerCase()}: ${data.boxes} examples taught, ${data.images} images, ${data.classes} classes` : ""}
            className="w-full rounded-xl border shadow-lg" />
        ) : (
          <div className="flex aspect-[1200/630] items-center justify-center rounded-xl bg-muted text-sm text-muted-foreground" role="status">
            {error ?? "Drawing the card…"}
          </div>
        )}
        {error && png && <p className="text-sm text-destructive">{error}</p>}
        <p className="text-xs text-muted-foreground">Every number on the card is real: it comes from this project&apos;s data, nothing is estimated.</p>
        <div className="flex flex-wrap justify-end gap-2">
          {canShare && <Button variant="outline" onClick={share}><Share2 /> Share…</Button>}
          {canCopy && <Button variant="outline" disabled={!png} onClick={copy}>{copied ? <><Check /> Copied</> : <><Copy /> Copy image</>}</Button>}
          <Button variant="pixel" data-primary disabled={!png} onClick={download}><Download /> Download PNG</Button>
        </div>
        {/* the Pixel drawn on the card: the 2D avatar, rendered out of sight */}
        {data && project && (
          <div ref={avatar} aria-hidden className="pointer-events-none fixed -left-[9999px] top-0">
            <PixelAvatar render="2d" animated={false} track={false} size={420} mood="proud" level={data.level} traits={project.pixel} />
          </div>
        )}
      </div>
    </div>
  );
}
