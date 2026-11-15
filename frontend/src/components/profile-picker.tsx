"use client";

import { Cpu, Feather, Gauge, Puzzle, SlidersHorizontal, Telescope, TriangleAlert, Zap } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { api, type CustomEngine, type EngineComponent, type EngineInfo, type EngineProfile, type ProfileName, type RuntimeInfo } from "@/lib/api";
import { cn } from "@/lib/utils";

const ICONS: Record<string, typeof Feather> = { light: Feather, balanced: Gauge, accurate: Telescope, custom: SlidersHorizontal };
const CUSTOM = "custom";

const customOf = (p: EngineProfile): CustomEngine => ({
  embedder: p.embedder, model: p.model, segmenter: p.segmenter, sam_model: p.sam_model,
  sam_points: p.sam_points, sam_refine: p.sam_refine,
});

/** Engine profile: an intention (light / balanced / accurate), or "custom": any registered embedder + segmenter. */
export function ProfilePicker({ onChanged }: { onChanged?: (msg: string) => void }) {
  const [info, setInfo] = useState<EngineInfo | null>(null);
  const [pending, setPending] = useState<ProfileName | null>(null);
  const [custom, setCustom] = useState<CustomEngine | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { api.engine().then(setInfo).catch(() => undefined); }, []);
  if (!info) return null;

  const active = info.active.profile;
  const comps = info.components;
  const isCustom = pending === CUSTOM;
  const target = isCustom ? null : pending ? info.profiles.find((p) => p.profile === pending) : null;
  const changedEyes = isCustom && !!custom
    ? custom.embedder !== info.active.embedder || custom.model !== info.active.model
    : !!target && target.signature !== info.active.signature;

  const pick = (name: ProfileName | null) => {
    setError(null);
    setPending(name);
    if (name === CUSTOM) setCustom(customOf(info.active)); // start from what runs now
  };

  const confirm = async () => {
    if (!pending) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.setEngine(pending, isCustom && custom ? custom : undefined);
      setInfo(r);
      setPending(null);
      onChanged?.(r.rescan
        ? `Switched to ${r.active.title}. Pixel is re-scanning your images in the background${r.embeddings_changed ? " and re-learning your boxes with the new eyes" : ""}.`
        : `Switched to ${r.active.title}.`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const cards: { profile: ProfileName; title: string; summary: string; line: string }[] = [
    ...info.profiles.map((p) => ({
      profile: p.profile, title: p.title, summary: p.summary,
      line: `${p.model.split("/").pop()} · ${p.segmenter === "simple" ? "simple" : p.sam_model.split("/").pop()} · ${p.sam_points}×${p.sam_points}+${p.sam_refine}`,
    })),
    {
      profile: CUSTOM, title: "Custom",
      summary: active === CUSTOM ? info.active.summary : "Pick the embedder, the segmenter and their checkpoints yourself (plugins included).",
      line: active === CUSTOM ? `${info.active.model.split("/").pop() || info.active.embedder} · ${info.active.sam_model.split("/").pop() || info.active.segmenter}` : "any registered model",
    },
  ];

  return (
    <Card>
      <CardHeader className="flex flex-row items-center gap-3 space-y-0">
        <Cpu className="h-5 w-5 text-pixel" /><CardTitle>Engine profile</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          How hard Pixel looks at each image when it first sees it. Lighter profiles scan faster on a laptop;
          everything you taught is kept when you switch.
        </p>
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          {cards.map((p) => {
            const Icon = ICONS[p.profile] ?? Puzzle;
            const isActive = p.profile === active;
            const isPending = p.profile === pending;
            return (
              <button key={p.profile} type="button" disabled={busy}
                onClick={() => pick(isPending ? null : isActive && p.profile !== CUSTOM ? null : p.profile)}
                className={cn("lift rounded-2xl border p-4 text-left transition",
                  isActive ? "border-pixel bg-pixel/10 ring-1 ring-pixel" : isPending ? "border-amber-400 ring-1 ring-amber-400" : "hover:bg-accent")}>
                <div className="flex items-center gap-2 font-semibold">
                  <Icon className="h-4 w-4 text-pixel" /> {p.title}
                  {isActive && <span className="ml-auto rounded-full bg-pixel px-2 py-0.5 text-[10px] font-semibold text-white">active</span>}
                </div>
                <p className="mt-1 text-xs text-muted-foreground">{p.summary}</p>
                <p className="mt-2 truncate font-mono text-[10px] text-muted-foreground">{p.line}</p>
              </button>
            );
          })}
        </div>
        {isCustom && custom && <CustomForm value={custom} onChange={setCustom} comps={comps} />}
        <RuntimeLine rt={info.runtime} sam2={info.active.segmenter === "sam2"} />
        {info.overrides.length > 0 && (
          <p className="text-xs text-amber-600 dark:text-amber-400">
            Environment overrides in effect: {info.overrides.join(", ")} (they win over the profile).
          </p>
        )}
        {error && <p className="text-sm text-destructive">{error}</p>}
        {(target || isCustom) && (
          <div className="flex flex-wrap items-center gap-3 rounded-2xl bg-muted px-4 py-3 text-sm">
            <p className="flex-1">
              Switch to <b>{target ? target.title : "your custom engine"}</b>? Pixel will re-scan every image in the background
              {changedEyes ? " and re-learn your boxes with new eyes (different embedder)" : ""}. Your boxes and history are kept;
              rejections tied to the old regions are dropped.
            </p>
            <Button variant="pixel" disabled={busy} onClick={confirm}>Switch</Button>
            <Button variant="ghost" disabled={busy} onClick={() => pick(null)}>Cancel</Button>
          </div>
        )}
        <Components comps={comps} />
      </CardContent>
    </Card>
  );
}

/** The custom engine: one registered embedder and one segmenter, each with a suggested or typed checkpoint. */
function CustomForm({ value, onChange, comps }: {
  value: CustomEngine; onChange: (v: CustomEngine) => void; comps: EngineInfo["components"];
}) {
  const emb = comps.embedders.find((c) => c.id === value.embedder);
  const seg = comps.segmenters.find((c) => c.id === value.segmenter);
  const set = (patch: Partial<CustomEngine>) => onChange({ ...value, ...patch });
  return (
    <div className="grid gap-4 rounded-2xl border border-amber-300/60 bg-amber-50/40 p-4 dark:border-amber-800/60 dark:bg-amber-950/20 md:grid-cols-2">
      <ComponentPicker label="Embedder (Pixel's eyes)" kind="embedder" list={comps.embedders} comp={emb}
        id={value.embedder} model={value.model}
        onPick={(c) => set({ embedder: c.id, model: c.default_model })} onModel={(m) => set({ model: m })} />
      <div className="space-y-3">
        <ComponentPicker label="Segmenter (where to look)" kind="segmenter" list={comps.segmenters} comp={seg}
          id={value.segmenter} model={value.sam_model}
          onPick={(c) => set({ segmenter: c.id, sam_model: c.default_model })} onModel={(m) => set({ sam_model: m })} />
        {seg && seg.custom_model && (
          <div className="grid grid-cols-2 gap-3 text-sm">
            <label className="space-y-1"><span className="text-xs text-muted-foreground">Scan grid (N×N prompts)</span>
              <input type="number" min={1} max={32} value={value.sam_points}
                onChange={(e) => set({ sam_points: Math.max(1, Number(e.target.value) || 1) })}
                className="w-full rounded-xl border bg-background px-3 py-2" /></label>
            <label className="space-y-1"><span className="text-xs text-muted-foreground">Extra prompts where nothing was found</span>
              <input type="number" min={0} max={128} value={value.sam_refine}
                onChange={(e) => set({ sam_refine: Math.max(0, Number(e.target.value) || 0) })}
                className="w-full rounded-xl border bg-background px-3 py-2" /></label>
          </div>
        )}
      </div>
      <p className="text-xs text-muted-foreground md:col-span-2">
        Every model needs a license compatible with Apache-2.0: the suggested checkpoints are; for a typed one, check
        its model card. A different embedder means Pixel re-learns your boxes with new eyes (nothing is lost).
      </p>
    </div>
  );
}

function ComponentPicker({ label, kind, list, comp, id, model, onPick, onModel }: {
  label: string; kind: string; list: EngineComponent[]; comp: EngineComponent | undefined; id: string; model: string;
  onPick: (c: EngineComponent) => void; onModel: (m: string) => void;
}) {
  const listId = `${kind}-models`;
  return (
    <div className="space-y-2 text-sm">
      <label className="block space-y-1">
        <span className="text-xs text-muted-foreground">{label}</span>
        <select value={id} onChange={(e) => { const c = list.find((x) => x.id === e.target.value); if (c) onPick(c); }}
          className="w-full rounded-xl border bg-background px-3 py-2">
          {list.map((c) => (
            <option key={c.id} value={c.id} disabled={!c.available}>
              {c.title}{c.builtin ? "" : " (plugin)"}{c.available ? "" : " (not installed)"}
            </option>
          ))}
        </select>
      </label>
      {comp && <p className="text-xs text-muted-foreground">{comp.summary} <span className="font-mono">· {comp.license}</span></p>}
      {comp?.custom_model && (
        <label className="block space-y-1">
          <span className="text-xs text-muted-foreground">Checkpoint (Hugging Face id or path)</span>
          <input list={listId} value={model} onChange={(e) => onModel(e.target.value)} placeholder={comp.default_model}
            className="w-full rounded-xl border bg-background px-3 py-2 font-mono text-xs" />
          <datalist id={listId}>
            {comp.models.map((m) => <option key={m.id} value={m.id}>{`${m.title} · ${m.license}${m.note ? ` · ${m.note}` : ""}`}</option>)}
          </datalist>
        </label>
      )}
    </div>
  );
}

/** What is registered: built-in components and plugins (with their load errors). */
function Components({ comps }: { comps: EngineInfo["components"] }) {
  const groups: [string, EngineComponent[]][] = [["Embedders", comps.embedders], ["Segmenters", comps.segmenters], ["Learners", comps.probes]];
  return (
    <details className="group rounded-2xl border px-4 py-3 text-sm">
      <summary className="flex cursor-pointer list-none items-center gap-2 font-medium">
        <Puzzle className="h-4 w-4 text-pixel" /> Models and plugins
        <span className="text-xs font-normal text-muted-foreground">
          · {comps.embedders.length + comps.segmenters.length + comps.probes.length} components
          {comps.plugins.length > 0 && `, ${comps.plugins.length} plugin${comps.plugins.length === 1 ? "" : "s"}`}
        </span>
        {comps.errors.length > 0 && <TriangleAlert className="h-4 w-4 text-amber-500" />}
      </summary>
      <div className="mt-3 space-y-3">
        {groups.map(([title, list]) => (
          <div key={title}>
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{title}</p>
            <ul className="mt-1 space-y-1">
              {list.map((c) => (
                <li key={c.id} className="flex flex-wrap items-baseline gap-x-2 text-xs">
                  <b className={cn(!c.available && "text-muted-foreground line-through")}>{c.title}</b>
                  <span className="font-mono text-muted-foreground">{c.id}</span>
                  <span className="text-muted-foreground">· {c.license}</span>
                  {!c.builtin && <span className="rounded-full bg-pixel/10 px-1.5 text-[10px] font-semibold text-pixel">plugin</span>}
                  {!c.available && <span className="text-amber-600 dark:text-amber-400">dependencies not installed</span>}
                </li>
              ))}
            </ul>
          </div>
        ))}
        {comps.errors.map((e) => (
          <p key={e.plugin} className="text-xs text-amber-700 dark:text-amber-300">Plugin <b>{e.plugin}</b> did not load: {e.error}</p>
        ))}
        <p className="text-xs text-muted-foreground">
          Add your own models with a plugin: a Python file in <span className="font-mono">{comps.plugins_dir}</span> (see
          <span className="font-mono"> _example_plugin.py</span> there and docs/extending.md).
        </p>
      </div>
    </details>
  );
}

/** Where the models run: ONNX Runtime on the best execution provider found, or the PyTorch fallback. */
function RuntimeLine({ rt, sam2 }: { rt: RuntimeInfo; sam2: boolean }) {
  const fallbacks = Object.entries(rt.fallbacks);
  return (
    <div className="space-y-1 rounded-2xl border px-4 py-3 text-sm">
      <p className="flex flex-wrap items-center gap-2">
        <Zap className={cn("h-4 w-4", rt.gpu ? "text-amber-500" : "text-muted-foreground")} />
        {rt.runtime === "onnx" ? (
          <>
            <span>Inference: <b>ONNX Runtime</b> on <b>{rt.provider}</b></span>
            <span className={cn("rounded-full px-2 py-0.5 text-[10px] font-semibold",
              rt.gpu ? "bg-amber-500/15 text-amber-700 dark:text-amber-300" : "bg-muted text-muted-foreground")}>
              {rt.gpu ? "GPU" : "CPU"}
            </span>
          </>
        ) : (
          <span>Inference: <b>PyTorch</b>{rt.requested_runtime === "torch" ? " (KWEETO_RUNTIME=torch)" : " (onnxruntime not installed)"}</span>
        )}
      </p>
      <p className="text-xs text-muted-foreground">
        {rt.runtime === "onnx"
          ? `Available here: ${rt.available.join(", ")}. Pick another with KWEETO_EP (cpu, cuda, tensorrt, dml, coreml, openvino).`
          : "Install the onnxruntime package for your hardware to run the models on ONNX Runtime (usually much faster with a GPU)."}
        {sam2 && rt.runtime === "onnx" && " SAM 2 (Balanced profile) still runs on PyTorch."}
      </p>
      {fallbacks.map(([part, why]) => (
        <p key={part} className="text-xs text-amber-600 dark:text-amber-400">The {part} fell back to PyTorch: {why}</p>
      ))}
    </div>
  );
}
