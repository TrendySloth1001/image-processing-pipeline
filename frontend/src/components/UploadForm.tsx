"use client";

import { useRef, useState } from "react";

/**
 * Sends each chosen file to the app as the raw body of its own request.
 *
 * A plain HTML form can only send a multipart body, and a multipart body is parsed into memory
 * before the server ever sees it — which killed this process the first time the file was a video
 * rather than a photo. Posting one file at a time as the body itself lets the server pipe it
 * straight to storage, so the size of the video stops mattering.
 */
export function UploadForm() {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function send(event: React.FormEvent) {
    event.preventDefault();
    const files = [...(input.current?.files ?? [])];
    if (files.length === 0) return;

    setError(null);
    for (const [index, file] of files.entries()) {
      const size = file.size > 1e6 ? `${(file.size / 1e6).toFixed(0)} MB` : `${Math.ceil(file.size / 1e3)} kB`;
      setBusy(`Sending ${index + 1} of ${files.length}: ${file.name} (${size})…`);
      try {
        const response = await fetch(
          `/api/upload?name=${encodeURIComponent(file.name)}&type=${encodeURIComponent(file.type)}`,
          { method: "POST", body: file },
        );
        if (!response.ok) {
          const body = (await response.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? `the server answered ${response.status}`);
        }
      } catch (failure) {
        setBusy(null);
        setError(`${file.name}: ${failure instanceof Error ? failure.message : String(failure)}`);
        return;
      }
    }
    setBusy(null);
    if (input.current) input.current.value = "";
    location.href = "/";
  }

  return (
    <form onSubmit={send} className="flex flex-wrap items-center gap-3">
      <input
        ref={input}
        type="file"
        name="files"
        multiple
        accept="image/*,video/*"
        required
        disabled={busy !== null}
        className="text-sm"
      />
      <button
        type="submit"
        disabled={busy !== null}
        className="rounded-full bg-blue-600 px-4 py-2 text-sm text-white disabled:opacity-50"
      >
        {busy ? "Uploading…" : "Upload"}
      </button>
      <span className="text-sm text-neutral-500">
        {busy ?? "Photos or videos. They go to S3, then the queue; faces come back by webhook."}
      </span>
      {error && (
        <p className="w-full rounded-xl border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-100">
          {error}
        </p>
      )}
    </form>
  );
}
