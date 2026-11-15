"use client";

import { Shuffle } from "lucide-react";

import { PixelAvatar } from "@/components/pixel";
import { EYE_COLORS, FALLBACK_ACCENTS } from "@/components/project-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { PixelOptions, PixelShape, PixelTraits } from "@/lib/api";
import { cn } from "@/lib/utils";

const SHAPES: PixelShape[] = ["round", "square", "blob", "tall"];
const ACCESSORIES = ["none", "bow", "cap", "glasses", "headphones", "leaf"];
const NAMES = ["Pixel", "Bit", "Byte", "Voxel", "Texel", "Pico", "Nibble", "Kilo", "Glitch", "Sprite", "Dot", "Lumen"];

const pick = <T,>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)];

export function randomTraits(options?: PixelOptions | null): PixelTraits {
  return {
    name: pick(options?.names ?? NAMES),
    color: pick(Object.keys(options?.colors ?? FALLBACK_ACCENTS)),
    shape: pick(options?.shapes ?? SHAPES),
    eyes: pick(options?.eyes ?? Object.keys(EYE_COLORS)),
    accessory: pick(options?.accessories ?? ACCESSORIES),
  };
}

/** Live editor of a project's Pixel: name, colour, body shape, eyes and accessory. */
export function PixelEditor({ value, onChange, options, size = 120, level = 7 }: {
  value: PixelTraits;
  /** growth stage shown in the preview */
  level?: number;
  onChange: (t: PixelTraits) => void;
  options?: PixelOptions | null;
  size?: number;
}) {
  const colors = options?.colors ?? Object.fromEntries(Object.entries(FALLBACK_ACCENTS).map(([k, v]) => [k, { light: v, dark: v }]));
  const set = (patch: Partial<PixelTraits>) => onChange({ ...value, ...patch });

  return (
    <div className="flex flex-col gap-5 sm:flex-row sm:items-start">
      <div className="flex flex-col items-center gap-2 sm:w-40">
        <div className="flex h-36 w-36 items-center justify-center rounded-3xl bg-gradient-to-b from-pixel/15 to-transparent">
          <PixelAvatar traits={value} size={size} mood="happy" level={level} />
        </div>
        <Button type="button" variant="outline" size="sm" onClick={() => onChange(randomTraits(options))}>
          <Shuffle /> Surprise me
        </Button>
      </div>

      <div className="flex-1 space-y-4">
        <label className="block space-y-1">
          <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Name</span>
          <Input value={value.name} maxLength={24} onChange={(e) => set({ name: e.target.value })} />
        </label>

        <Field label="Colour">
          {Object.entries(colors).map(([name, c]) => (
            <button key={name} type="button" title={name} aria-label={name} onClick={() => set({ color: name })}
              className={cn("h-7 w-7 rounded-full ring-offset-2 ring-offset-card transition hover:scale-110",
                value.color === name && "ring-2 ring-foreground")}
              style={{ backgroundColor: `hsl(${c.light})` }} />
          ))}
        </Field>

        <Field label="Shape">
          {(options?.shapes ?? SHAPES).map((s) => (
            <Choice key={s} active={value.shape === s} onClick={() => set({ shape: s })}>
              <PixelAvatar traits={{ ...value, shape: s, accessory: "none" }} size={30} animated={false} track={false} />
              <span className="capitalize">{s}</span>
            </Choice>
          ))}
        </Field>

        <Field label="Eyes">
          {(options?.eyes ?? Object.keys(EYE_COLORS)).map((e) => (
            <button key={e} type="button" title={e} aria-label={`${e} eyes`} onClick={() => set({ eyes: e })}
              className={cn("flex h-7 w-9 items-center justify-center gap-1 rounded-lg bg-slate-900 transition hover:scale-110",
                value.eyes === e && "ring-2 ring-foreground ring-offset-2 ring-offset-card")}>
              <span className="h-3 w-1.5 rounded-full" style={{ backgroundColor: EYE_COLORS[e] }} />
              <span className="h-3 w-1.5 rounded-full" style={{ backgroundColor: EYE_COLORS[e] }} />
            </button>
          ))}
        </Field>

        <Field label="Accessory">
          {(options?.accessories ?? ACCESSORIES).map((a) => (
            <Choice key={a} active={value.accessory === a} onClick={() => set({ accessory: a })}>
              <span className="capitalize">{a}</span>
            </Choice>
          ))}
        </Field>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{label}</p>
      <div className="flex flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}

function Choice({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick}
      className={cn("flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition",
        active ? "border-pixel bg-pixel/10 text-pixel" : "hover:bg-accent")}>
      {children}
    </button>
  );
}
