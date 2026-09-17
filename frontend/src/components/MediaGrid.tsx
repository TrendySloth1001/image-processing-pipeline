"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { FaceCrop } from "@/components/FaceCrop";
import { clock } from "@/components/MediaTile";

const pictureOf = (item: Item) => ({
  src: item.frameSrc,
  width: item.frameWidth,
  height: item.frameHeight,
});

export type Item = {
  id: string; // unique per tile
  faceId: number;
  kind: "photo" | "video";
  name: string;
  /** The picture to show: the photo itself, or the frame this face was caught in. */
  frameSrc: string;
  frameWidth: number | null;
  frameHeight: number | null;
  /** The face inside that picture, in its pixels. */
  bbox: number[];
  videoSrc?: string;
  startMs?: number;
  endMs?: number;
};

/**
 * The pictures of one person, and a viewer for them.
 *
 * Opening a frame or a clip used to hand the file to the browser, which loses the gallery, the
 * face you were looking at and the time it came from, and gives back a bare file in a tab. The
 * viewer keeps all three: it draws the box on the frame, plays the video from the moment the
 * appearance starts, and steps to the next picture without going anywhere.
 */
export function MediaGrid({ items, personId }: { items: Item[]; personId: string }) {
  const [openAt, setOpenAt] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const open = openAt === null ? null : items[openAt];

  const show = useCallback((index: number, asVideo: boolean) => {
    setOpenAt(index);
    setPlaying(asVideo);
  }, []);

  const step = useCallback(
    (by: number) => {
      setOpenAt((at) => (at === null ? null : (at + by + items.length) % items.length));
      setPlaying(false);
    },
    [items.length],
  );

  useEffect(() => {
    if (openAt === null) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpenAt(null);
      if (event.key === "ArrowRight") step(1);
      if (event.key === "ArrowLeft") step(-1);
    };
    window.addEventListener("keydown", onKey);
    // Stop the page behind from scrolling while the viewer is over it.
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
    };
  }, [openAt, step]);

  return (
    <>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-1">
        {items.map((item, index) => (
          <div key={item.id} className="group relative">
            <button
              type="button"
              onClick={() => show(index, false)}
              title={item.kind === "video" ? "The frame this face was caught in" : item.name}
              className="block w-full cursor-zoom-in"
            >
              {item.kind === "video" ? (
                <FaceCrop picture={pictureOf(item)} bbox={item.bbox} fill zoom={2.2} className="rounded" />
              ) : (
                <img src={item.frameSrc} alt={item.name} className="aspect-square w-full rounded object-cover" />
              )}
            </button>

            {item.kind === "video" ? (
              <button
                type="button"
                onClick={() => show(index, true)}
                title="Play the video from here"
                className="absolute bottom-1 left-1 rounded bg-black/65 px-1.5 text-[11px] text-white hover:bg-black/85"
              >
                ▶ {clock(item.startMs ?? 0)}–{clock(item.endMs ?? item.startMs ?? 0)}
              </button>
            ) : (
              <FaceCrop
                picture={pictureOf(item)}
                bbox={item.bbox}
                size={44}
                className="pointer-events-none absolute bottom-1 right-1 rounded-full shadow ring-2 ring-white/90"
              />
            )}

            {items.length > 1 && (
              <form action="/api/split" method="post" className="absolute right-1 top-1">
                <input type="hidden" name="from" value={personId} />
                <input type="hidden" name="face" value={item.faceId} />
                <button
                  type="submit"
                  title={`Take this out of Person ${personId}`}
                  className="rounded bg-black/60 px-1.5 text-[11px] text-white opacity-0 transition-opacity group-hover:opacity-100"
                >
                  not them
                </button>
              </form>
            )}
          </div>
        ))}
      </div>

      {open && openAt !== null && (
        <Viewer
          item={open}
          playing={playing}
          position={`${openAt + 1} of ${items.length}`}
          onPlay={() => setPlaying(true)}
          onFrame={() => setPlaying(false)}
          onClose={() => setOpenAt(null)}
          onStep={step}
        />
      )}
    </>
  );
}

function Viewer({
  item,
  playing,
  position,
  onPlay,
  onFrame,
  onClose,
  onStep,
}: {
  item: Item;
  playing: boolean;
  position: string;
  onPlay: () => void;
  onFrame: () => void;
  onClose: () => void;
  onStep: (by: number) => void;
}) {
  const video = useRef<HTMLVideoElement>(null);

  // Start the clip where the appearance starts, not where the file does.
  useEffect(() => {
    const element = video.current;
    if (!element || !playing) return;
    const seek = () => {
      element.currentTime = Math.max(0, (item.startMs ?? 0) / 1000);
      void element.play().catch(() => {}); // a browser may refuse to autoplay; the controls still work
    };
    if (element.readyState >= 1) seek();
    else element.addEventListener("loadedmetadata", seek, { once: true });
  }, [playing, item.startMs, item.videoSrc]);

  const [x1, y1, x2, y2] = item.bbox;
  const canBox = !playing && item.frameWidth && item.frameHeight;

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-black/85 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm text-white"
        onClick={(event) => event.stopPropagation()}
      >
        <span className="font-medium">{item.name}</span>
        {item.kind === "video" && (
          <span className="text-white/70">
            {clock(item.startMs ?? 0)}–{clock(item.endMs ?? item.startMs ?? 0)}
          </span>
        )}
        <span className="text-white/50">{position}</span>
        <span className="flex-1" />
        {item.kind === "video" && (
          <div className="flex overflow-hidden rounded-full border border-white/25">
            <button
              type="button"
              onClick={onFrame}
              className={`px-3 py-1 ${playing ? "text-white/70 hover:bg-white/10" : "bg-white text-black"}`}
            >
              Frame
            </button>
            <button
              type="button"
              onClick={onPlay}
              className={`px-3 py-1 ${playing ? "bg-white text-black" : "text-white/70 hover:bg-white/10"}`}
            >
              Play
            </button>
          </div>
        )}
        <button
          type="button"
          onClick={onClose}
          title="Close (Esc)"
          className="rounded-full border border-white/25 px-3 py-1 hover:bg-white/10"
        >
          Close
        </button>
      </div>

      <div
        className="flex min-h-0 flex-1 items-center justify-center gap-2 px-2 pb-4"
        onClick={(event) => event.stopPropagation()}
      >
        <button
          type="button"
          onClick={() => onStep(-1)}
          title="Previous (←)"
          className="shrink-0 rounded-full px-3 py-6 text-2xl text-white/60 hover:bg-white/10 hover:text-white"
        >
          ‹
        </button>

        {playing && item.videoSrc ? (
          <video
            ref={video}
            src={item.videoSrc}
            controls
            playsInline
            className="max-h-full max-w-full rounded"
          />
        ) : (
          <div className="relative inline-block max-h-full">
            <img src={item.frameSrc} alt={item.name} className="max-h-[78vh] max-w-full rounded object-contain" />
            {canBox && (
              <div
                className="pointer-events-none absolute rounded-sm border-2 border-emerald-300 shadow-[0_0_0_9999px_rgba(0,0,0,0.25)]"
                style={{
                  left: `${(x1 / item.frameWidth!) * 100}%`,
                  top: `${(y1 / item.frameHeight!) * 100}%`,
                  width: `${((x2 - x1) / item.frameWidth!) * 100}%`,
                  height: `${((y2 - y1) / item.frameHeight!) * 100}%`,
                }}
              />
            )}
          </div>
        )}

        <button
          type="button"
          onClick={() => onStep(1)}
          title="Next (→)"
          className="shrink-0 rounded-full px-3 py-6 text-2xl text-white/60 hover:bg-white/10 hover:text-white"
        >
          ›
        </button>
      </div>
    </div>
  );
}
