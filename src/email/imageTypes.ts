const IMAGE_MIME_TYPES = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/gif",
  "image/webp",
]);

export function isImageContentType(contentType: string): boolean {
  return IMAGE_MIME_TYPES.has(contentType.toLowerCase().split(";")[0]?.trim() ?? "");
}

// Telegram rejects photo uploads larger than 10 MB. Above this the image is
// routed to a download link instead — which also avoids decrypting the whole
// file into memory for a sendPhoto call that would fail anyway.
export const TELEGRAM_PHOTO_MAX_BYTES = 10 * 1024 * 1024;

/**
 * True if an attachment should be sent inline as a Telegram photo. An image of
 * unknown size keeps the prior behavior (attempt the photo send); an image
 * over the Telegram photo limit is excluded so it falls back to a link.
 */
export function isInlinePhoto(contentType: string, sizeBytes: number | null | undefined): boolean {
  if (!isImageContentType(contentType)) return false;
  if (sizeBytes == null) return true;
  return sizeBytes <= TELEGRAM_PHOTO_MAX_BYTES;
}
