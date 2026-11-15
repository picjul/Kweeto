import { PixelAvatar } from "@/components/pixel";

/** The one "this page is loading" view: Pixel thinking + a spinner and a word (route loading and page data). */
export function PageLoading({ label = "Loading…" }: { label?: string }) {
  return (
    <div role="status" aria-live="polite" className="flex animate-in fade-in flex-col items-center gap-3 pt-24 text-sm text-muted-foreground duration-300">
      <PixelAvatar mood="thinking" size={88} render="2d" track={false} />
      <span className="flex items-center gap-2">
        <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-pixel border-t-transparent" />
        {label}
      </span>
    </div>
  );
}
