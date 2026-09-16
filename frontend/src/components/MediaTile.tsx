/** mm:ss, the way a video player writes a time. */
export function clock(ms: number) {
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/**
 * One square tile in a grid of uploads. A video looks like its poster frame with a play mark
 * and its length; until the pipeline has cut that poster there is nothing to show, so the tile
 * shows the film symbol on its own rather than a broken image.
 */
export function MediaTile({
  src,
  alt,
  kind,
  poster = true,
  durationMs,
  badge,
}: {
  src: string;
  alt: string;
  kind: string;
  poster?: boolean;
  durationMs?: number | null;
  badge?: string;
}) {
  const isVideo = kind === "video";
  return (
    <div className="relative">
      {isVideo && !poster ? (
        <div className="flex aspect-square w-full items-center justify-center rounded bg-neutral-200 text-2xl text-neutral-500 dark:bg-neutral-800">
          🎞
        </div>
      ) : (
        <img src={src} alt={alt} className="aspect-square w-full rounded object-cover" />
      )}
      {isVideo && (
        <span className="absolute right-1 top-1 rounded bg-black/60 px-1.5 text-[11px] text-white">
          ▶ {durationMs ? clock(durationMs) : "video"}
        </span>
      )}
      {badge && (
        <span className="absolute bottom-1 left-1 rounded bg-black/60 px-1.5 text-[11px] text-white">{badge}</span>
      )}
    </div>
  );
}
