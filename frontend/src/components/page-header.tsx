import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/** Consistent page title block: icon tile, title, description and right-aligned actions. */
export function PageHeader({ icon, title, description, actions, className }: {
  icon?: ReactNode;
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("mb-6 flex flex-wrap items-center gap-4", className)}>
      {icon && (
        <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-pixel/10 text-pixel [&_svg]:h-5 [&_svg]:w-5">
          {icon}
        </div>
      )}
      <div className="min-w-0 flex-1">
        <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
