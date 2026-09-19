/**
 * Send the browser somewhere else, by a path rather than a whole URL.
 *
 * `Response.redirect(new URL(path, request.url))` looks right and is not: inside a container the
 * request URL carries the port the server itself listens on, not the one the browser asked for.
 * Publish the app on any port but 3000 and every form posts once, then throws you at
 * localhost:3000 — a port that in this case belonged to a different app entirely.
 *
 * A Location header may be relative (RFC 7231 §7.1.2) and every browser resolves it against the
 * address it actually used, so the app stops needing to know its own name.
 */
export function goTo(path: string, notice?: string) {
  const where = notice ? `${path}${path.includes("?") ? "&" : "?"}notice=${encodeURIComponent(notice)}` : path;
  return new Response(null, { status: 303, headers: { location: where } });
}
