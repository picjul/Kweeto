"use client";

import { FolderKanban, FolderOpen, Palette, Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";

import { DemoButton } from "@/components/demo";
import { PageHeader } from "@/components/page-header";
import { PixelAvatar, STAGES, levelFromBoxes, stageOf } from "@/components/pixel";
import { PixelEditor, randomTraits } from "@/components/pixel-editor";
import { useProject } from "@/components/project-context";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { api, type PixelTraits, type Project } from "@/lib/api";
import { cn } from "@/lib/utils";

export default function ProjectsPage() {
  const { projects, options, refresh, switchTo } = useProject();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [traits, setTraits] = useState<PixelTraits | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => { // "hatch" links (playground egg, sidebar) open the creation form directly
    if (new URLSearchParams(window.location.search).get("new")) setCreating(true);
  }, []);
  useEffect(() => { if (creating && !traits) setTraits(randomTraits(options)); }, [creating, traits, options]);

  const create = async () => {
    if (!name.trim() || !traits) return;
    setBusy(true);
    setError(null);
    try {
      await api.createProject({ name: name.trim(), pixel: traits, open: true });
      window.location.assign("/overview"); // the new project is now open: start from its overview
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader icon={<FolderKanban />} title="Projects"
        description="One project per dataset. Each has its own images, classes, engine profile and its own Pixel."
        actions={!creating && (
          <>
            <DemoButton label="Try the demo project" />
            <Button variant="outline" className="rounded-full" onClick={() => setCreating(true)}><Plus /> New project</Button>
          </>
        )} />

      {creating && traits && (
        <Card className="mb-6 animate-in fade-in slide-in-from-top-2">
          <CardHeader><CardTitle>New project</CardTitle></CardHeader>
          <CardContent className="space-y-5">
            <label className="block space-y-1">
              <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Project name</span>
              <Input autoFocus value={name} maxLength={64} placeholder="e.g. Vegetables on the counter"
                onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") create(); }} />
            </label>
            <div>
              <p className="mb-3 text-sm text-muted-foreground">
                Meet the apprentice who will learn this dataset with you. It hatches as a baby and grows up with every example you teach.
              </p>
              <PixelEditor value={traits} onChange={setTraits} options={options} level={1} />
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <div className="flex gap-2">
              <Button variant="pixel" disabled={busy || !name.trim()} onClick={create}>Create and open</Button>
              <Button variant="ghost" disabled={busy} onClick={() => { setCreating(false); setTraits(null); }}>Cancel</Button>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="stagger grid gap-4 md:grid-cols-2">
        {projects.map((p) => (
          <ProjectCard key={p.id} project={p} onOpen={() => switchTo(p.id)} onChanged={refresh} />
        ))}
      </div>
    </div>
  );
}

function ProjectCard({ project, onOpen, onChanged }: { project: Project; onOpen: () => void; onChanged: () => Promise<void> }) {
  const { options } = useProject();
  const [mode, setMode] = useState<"view" | "edit" | "delete">("view");
  const [name, setName] = useState(project.name);
  const [traits, setTraits] = useState<PixelTraits>(project.pixel);
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    try {
      await api.updateProject(project.id, { name: name.trim() || project.name, pixel: traits });
      await onChanged();
      setMode("view");
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await api.deleteProject(project.id);
      if (project.active) window.location.assign("/"); // no project is open any more: back to the playground
      else await onChanged();
    } finally {
      setBusy(false);
    }
  };

  const s = project.stats;
  return (
    <Card className={cn("lift overflow-hidden", project.active && "ring-2 ring-pixel")}>
      <CardContent className="space-y-4 pt-5">
        <div className="flex items-center gap-4">
          <PixelAvatar traits={mode === "edit" ? traits : project.pixel} level={levelFromBoxes(s.boxes)} size={64}
            mood={project.active ? "happy" : "idle"} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h2 className="truncate text-lg font-semibold">{project.name}</h2>
              {project.active && <span className="rounded-full bg-pixel px-2 py-0.5 text-[10px] font-semibold text-white">open</span>}
            </div>
            <p className="text-sm text-muted-foreground">
              with <b>{project.pixel.name}</b> ({STAGES[stageOf(levelFromBoxes(s.boxes))].label.toLowerCase()}, level {levelFromBoxes(s.boxes)})
              · {s.images} images · {s.boxes} boxes · {s.classes} classes
            </p>
            {project.created_at && (
              <p className="text-xs text-muted-foreground">created {new Date(project.created_at).toLocaleDateString()}</p>
            )}
          </div>
        </div>

        {mode === "view" && (
          <div className="flex flex-wrap gap-2">
            {!project.active && <Button size="sm" variant="pixel" onClick={onOpen}><FolderOpen /> Open</Button>}
            <Button size="sm" variant="outline" onClick={() => setMode("edit")}><Palette /> Customise</Button>
            <Button size="sm" variant="ghost" className="ml-auto text-destructive hover:text-destructive"
              onClick={() => setMode("delete")}><Trash2 /> Delete</Button>
          </div>
        )}

        {mode === "edit" && (
          <div className="space-y-4 rounded-2xl bg-muted/50 p-4">
            <label className="block space-y-1">
              <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Project name</span>
              <Input value={name} maxLength={64} onChange={(e) => setName(e.target.value)} />
            </label>
            <PixelEditor value={traits} onChange={setTraits} options={options} size={96} level={levelFromBoxes(s.boxes)} />
            <div className="flex gap-2">
              <Button size="sm" variant="pixel" disabled={busy} onClick={save}>Save</Button>
              <Button size="sm" variant="ghost" disabled={busy}
                onClick={() => { setMode("view"); setTraits(project.pixel); setName(project.name); }}>Cancel</Button>
            </div>
          </div>
        )}

        {mode === "delete" && (
          <div className="space-y-3 rounded-2xl border border-destructive/40 bg-destructive/5 p-4 text-sm">
            <p>
              This permanently deletes <b>{project.name}</b>: its {s.images} images, {s.boxes} boxes, classes and
              everything {project.pixel.name} learned. It cannot be undone.
              {project.active && " Another project will be opened."}
            </p>
            <label className="block space-y-1">
              <span className="text-xs text-muted-foreground">Type the project name to confirm</span>
              <Input value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder={project.name} />
            </label>
            <div className="flex gap-2">
              <Button size="sm" variant="destructive" disabled={busy || confirm.trim() !== project.name} onClick={remove}>
                Delete forever
              </Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => { setMode("view"); setConfirm(""); }}>Cancel</Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
