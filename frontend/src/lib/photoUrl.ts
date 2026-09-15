/**
 * URL for a stored photo.
 *
 * Row ids come round again after the table is cleared, so a plain /api/photos/3 can hit a
 * browser's cached copy of a completely different photo. The object key is unique per upload,
 * so putting it in the URL makes every photo its own address.
 */
export function photoUrl(photoId: number, photoKey?: string | null) {
  const version = photoKey ? photoKey.split("/").pop() : null;
  return version ? `/api/photos/${photoId}?v=${encodeURIComponent(version)}` : `/api/photos/${photoId}`;
}
