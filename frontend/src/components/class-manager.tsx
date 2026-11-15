"use client";

import { Plus, X } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, type LabelClass } from "@/lib/api";

/** Compact class list (shortcuts 1-9) with add and delete. */
export function ClassManager({ classes, onChange }: { classes: LabelClass[]; onChange: () => void }) {
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);

  const add = async () => {
    if (!name.trim()) return;
    try {
      await api.createClass(name.trim());
      setName("");
      setError(null);
      onChange();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const remove = async (c: LabelClass) => {
    try {
      await api.deleteClass(c.id);
      onChange();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {classes.map((c, i) => (
          <span key={c.id} className="inline-flex items-center gap-1.5 rounded-full border bg-card py-1 pl-1.5 pr-3 text-sm shadow-sm">
            <kbd className="flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-bold text-white"
              style={{ backgroundColor: c.color }}>{i < 9 ? i + 1 : "·"}</kbd>
            <span className="font-medium">{c.name}</span>
            <span className="text-xs text-muted-foreground">{c.box_count}</span>
            {c.box_count === 0 && (
              <button type="button" onClick={() => remove(c)} title="Delete" aria-label={`Delete class ${c.name}`} className="text-muted-foreground hover:text-destructive">
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </span>
        ))}
      </div>
      <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); add(); }}>
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="New class, e.g. Bolt" className="bg-card" />
        <Button type="submit" variant="outline"><Plus /> Add</Button>
      </form>
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}
