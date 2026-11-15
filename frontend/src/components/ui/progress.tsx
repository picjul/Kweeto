import * as React from "react";

import { cn } from "@/lib/utils";

/** Lightweight version of shadcn/ui Progress (no Radix dependency). */
function Progress({ value = 0, className, indicatorClassName, style }: {
  value?: number;
  className?: string;
  indicatorClassName?: string;
  style?: React.CSSProperties;
}) {
  const v = Math.max(0, Math.min(100, value));
  return (
    <div role="progressbar" aria-valuenow={v} aria-valuemin={0} aria-valuemax={100}
      className={cn("relative h-2 w-full overflow-hidden rounded-full bg-secondary", className)}>
      <div className={cn("h-full rounded-full bg-primary transition-all", indicatorClassName)}
        style={{ width: `${v}%`, ...style }} />
    </div>
  );
}

export { Progress };
