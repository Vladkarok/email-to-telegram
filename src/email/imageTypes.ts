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
