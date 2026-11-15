"use client";

import { Palette, RefreshCw, RotateCcw, SlidersHorizontal } from "lucide-react";
import { useEffect, useState } from "react";

import { PageHeader } from "@/components/page-header";
import { PageLoading } from "@/components/page-loading";
import { ProfilePicker } from "@/components/profile-picker";
import { ThemePicker } from "@/components/theme-toggle";
import { useSoundEnabled } from "@/lib/sound";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { api, type EngineComponent, type EngineSettings, type SettingsResponse } from "@/lib/api";

const FIELDS: { key: keyof EngineSettings; label: string; hint: string; min: number; max: number; step: number }[] = [
  { key: "sim_min", label: "Minimum similarity", hint: "Below this Pixel says “I don't know what it is” (when auto-calibration is off)", min: 0, max: 1, step: 0.01 },
  { key: "sim_high", label: "High similarity", hint: "Above this familiarity is full", min: 0, max: 1, step: 0.01 },
  { key: "propose_min", label: "Minimum confidence to propose", hint: "Below this there is no proposal", min: 0, max: 1, step: 0.05 },
  { key: "batch_min", label: "Minimum confidence for the Harvest", hint: "Proposals above this go into the batch", min: 0, max: 1, step: 0.05 },
  { key: "knn_k", label: "Neighbours (k)", hint: "Examples consulted for each decision", min: 1, max: 50, step: 1 },
  { key: "temperature", label: "Temperature", hint: "Lower = the most similar neighbour weighs more", min: 0.01, max: 0.2, step: 0.01 },
  { key: "max_per_image", label: "Proposals per image", hint: "Maximum number of proposed objects", min: 1, max: 30, step: 1 },
  { key: "probe_weight", label: "Linear probe weight", hint: "0 = only the kNN memory, 1 = only the linear probe (once ramped up)", min: 0, max: 1, step: 0.05 },
  { key: "probe_ramp", label: "Probe ramp (examples per class)", hint: "The probe's say grows until each class has this many examples", min: 1, max: 30, step: 1 },
  { key: "detector_weight", label: "Detector weight", hint: "With the detector on: how much a matching detector box pulls the class and “is it an object”", min: 0, max: 1, step: 0.05 },
  { key: "detector_veto", label: "Detector veto", hint: "With the detector on: how much Pixel's confidence drops where the detector saw nothing", min: 0, max: 1, step: 0.05 },
];

const TOGGLES: { key: "auto_calibrate" | "use_probe" | "use_background" | "snap_boxes" | "use_detector"; label: string }[] = [
  { key: "auto_calibrate", label: "Auto-calibrate the similarity thresholds from the taught examples" },
  { key: "use_probe", label: "Linear probe: a second, generalising learner next to the kNN memory" },
  { key: "use_background", label: "Learn “not an object” (pieces, piles, clutter) from the images you finished" },
  { key: "snap_boxes", label: "Snap hand-drawn boxes to the object (segmenter)" },
  { key: "use_detector", label: "Use the project's trained detector as a second opinion in Pixel's guesses (Training page)" },
];

export default function SettingsPage() {
  const [data, setData] = useState<SettingsResponse | null>(null);
  const [draft, setDraft] = useState<Partial<EngineSettings>>({});
  const [confirmReset, setConfirmReset] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [confirmRescan, setConfirmRescan] = useState(false);

  const [probes, setProbes] = useState<EngineComponent[]>([]);

  useEffect(() => {
    api.settings().then(setData);
    api.engine().then((e) => setProbes(e.components.probes)).catch(() => undefined);
  }, []);

  if (!data) return <PageLoading />;
  const s = { ...data.settings, ...draft };

  const save = async () => {
    const r = await api.updateSettings(draft);
    setData(r);
    setDraft({});
    setMsg("Thresholds updated, proposals recomputed.");
  };

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader icon={<SlidersHorizontal />} title="Engine & appearance" description="How Pixel decides, and how Kweeto looks." />
      <div className="space-y-5">
        <Card>
          <CardHeader className="flex flex-row items-center gap-3 space-y-0">
            <Palette className="h-5 w-5 text-pixel" /><CardTitle>Appearance</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <p className="text-sm text-muted-foreground">Light, dark, or follow your system.</p>
              <ThemePicker />
            </div>
            <div className="flex flex-wrap items-center justify-between gap-4 border-t pt-4">
              <p className="text-sm text-muted-foreground">
                Sounds: the Pixels chirp when they meet, react when poked, cheer when they level up or grow.
              </p>
              <SoundSwitch />
            </div>
          </CardContent>
        </Card>

        <ProfilePicker onChanged={setMsg} />
        {msg && <p className="px-1 text-sm text-muted-foreground">{msg}</p>}

        <Card>
          <CardHeader><CardTitle>Engine thresholds</CardTitle></CardHeader>
          <CardContent className="space-y-6">
            <div className="rounded-2xl bg-muted px-4 py-3 text-sm">
              <p>
                Effective thresholds: min similarity <b>{data.effective.sim_min.toFixed(3)}</b>, high <b>{data.effective.sim_high.toFixed(3)}</b>
                {data.effective.calibrated ? " (auto-calibrated from the examples)" : " (manual)"}
              </p>
              {data.effective.profile && (
                <p className="text-muted-foreground">
                  Median nearest same-class {data.effective.profile.same.toFixed(3)} · other class {data.effective.profile.other.toFixed(3)}
                </p>
              )}
              <p className="text-muted-foreground">
                {data.effective.probe
                  ? `${probes.find((p) => p.id === data.effective.probe?.kind)?.title ?? "Probe"} trained on ${data.effective.probe.examples} examples, ${data.effective.probe.classes} ${data.effective.probe.classes === 1 ? "class" : "classes"}${data.effective.probe.background ? " + background" : ""} (train accuracy ${Math.round(data.effective.probe.train_acc * 100)}%, say ${Math.round(data.effective.probe.weight * 100)}% of the class choice).`
                  : "The learner is not trained yet (needs a few examples, and either 2 classes or one finished image)."}
              </p>
              {data.effective.probe && (
                <p className="text-muted-foreground">
                  Learned from {data.effective.probe.sources.boxes} boxes on {data.effective.probe.sources.verified} finished images:
                  {" "}{data.effective.probe.sources.parts} pieces, {data.effective.probe.sources.groups} piles and {data.effective.probe.sources.clutter} other regions taught as &ldquo;not an object&rdquo;.
                </p>
              )}
            </div>
            <div className="space-y-2">
              {TOGGLES.map((t) => (
                <label key={t.key} className="flex items-center gap-3 text-sm font-medium">
                  <input type="checkbox" className="h-4 w-4 accent-[hsl(var(--pixel))]" checked={s[t.key]}
                    onChange={(e) => setDraft((d) => ({ ...d, [t.key]: e.target.checked }))} />
                  {t.label}
                </label>
              ))}
            </div>
            {probes.length > 1 && (
              <label className="block max-w-xl space-y-1 text-sm">
                <span className="font-medium">Learner next to the kNN memory</span>
                <select value={s.probe} disabled={!s.use_probe}
                  onChange={(e) => setDraft((d) => ({ ...d, probe: e.target.value }))}
                  className="w-full rounded-xl border bg-background px-3 py-2">
                  {probes.map((p) => <option key={p.id} value={p.id}>{p.title}{p.builtin ? "" : " (plugin)"}</option>)}
                </select>
                <span className="block text-xs text-muted-foreground">
                  {probes.find((p) => p.id === s.probe)?.summary} Always re-learned from all your examples, so changing it loses nothing.
                </span>
              </label>
            )}
            <div className="grid gap-6 md:grid-cols-2">
              {FIELDS.map((f) => (
                <div key={f.key} className="space-y-2">
                  <div className="flex items-baseline justify-between">
                    <p className="text-sm font-medium">{f.label}</p>
                    <span className="rounded-md bg-pixel/10 px-2 py-0.5 font-mono text-xs font-semibold text-pixel">{String(s[f.key])}</span>
                  </div>
                  <input type="range" min={f.min} max={f.max} step={f.step} value={Number(s[f.key])}
                    className="w-full accent-[hsl(var(--pixel))]"
                    onChange={(e) => setDraft((d) => ({ ...d, [f.key]: Number(e.target.value) }))} />
                  <p className="text-xs text-muted-foreground">{f.hint}</p>
                </div>
              ))}
            </div>
            <div className="flex items-center gap-3">
              <Button variant="pixel" className="rounded-full" onClick={save} disabled={!Object.keys(draft).length}>Save and recompute</Button>
              {Object.keys(draft).length > 0 && <Button variant="ghost" onClick={() => setDraft({})}>Discard</Button>}

            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center gap-3 space-y-0">
            <RefreshCw className="h-5 w-5 text-pixel" /><CardTitle>Re-scan the images</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-wrap items-center justify-between gap-4 text-sm">
            <p className="max-w-xl text-muted-foreground">
              Looks at every image again to find object regions (needed for projects created before the segment-based scan,
              or after changing the segmenter). Your boxes and history are kept; it can take a while on CPU.
            </p>
            {!confirmRescan ? (
              <Button variant="outline" onClick={() => setConfirmRescan(true)}>Re-scan…</Button>
            ) : (
              <div className="flex gap-2">
                <Button variant="pixel" onClick={async () => {
                  const r = await api.rescan(); setConfirmRescan(false); setMsg(`Re-scanning ${r.images} images in the background.`);
                }}>Yes, re-scan</Button>
                <Button variant="ghost" onClick={() => setConfirmRescan(false)}>Cancel</Button>
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="border-destructive/30">
          <CardHeader className="flex flex-row items-center gap-3 space-y-0">
            <RotateCcw className="h-5 w-5 text-destructive" /><CardTitle>Start over</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-wrap items-center justify-between gap-4 text-sm">
            <p className="text-muted-foreground">Deletes all annotations, answers and history. Images and embeddings are kept.</p>
            {!confirmReset ? (
              <Button variant="outline" onClick={() => setConfirmReset(true)}>Reset the teaching…</Button>
            ) : (
              <div className="flex gap-2">
                <Button variant="destructive" onClick={async () => { await api.reset(); setConfirmReset(false); setMsg("Pixel has forgotten everything."); }}>
                  Yes, delete everything
                </Button>
                <Button variant="ghost" onClick={() => setConfirmReset(false)}>Cancel</Button>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
      <p className="pb-2 text-center text-xs text-muted-foreground">
        Kweeto {process.env.NEXT_PUBLIC_KWEETO_VERSION ? `v${process.env.NEXT_PUBLIC_KWEETO_VERSION}` : ""} · Apache-2.0 · runs entirely on your machine
      </p>
    </div>
  );
}

function SoundSwitch() {
  const [on, setOn] = useSoundEnabled();
  return (
    <div className="inline-flex rounded-full border bg-card p-1 text-sm">
      {([true, false] as const).map((v) => (
        <button key={String(v)} type="button" onClick={() => setOn(v)}
          className={v === on ? "rounded-full bg-pixel px-3 py-1 font-medium text-white" : "rounded-full px-3 py-1 text-muted-foreground"}>
          {v ? "On" : "Off"}
        </button>
      ))}
    </div>
  );
}
