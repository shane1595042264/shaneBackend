// src/modules/journal/image-validate.ts
//
// Magic-byte sniffer for the four image MIME types we accept on
// POST /api/journal/images. Used in place of a client-supplied
// Content-Type because (a) SVG would otherwise satisfy the old
// startsWith("image/") check and is a script-execution vector when
// the URL is opened directly, and (b) any client can spoof
// file.type on a multipart upload.

export type AllowedImageMime =
  | "image/png"
  | "image/jpeg"
  | "image/gif"
  | "image/webp";

export const ALLOWED_IMAGE_MIMES: ReadonlyArray<AllowedImageMime> = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
];

export function sniffImageMime(buf: Buffer): AllowedImageMime | null {
  if (buf.length >= 8 &&
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
    buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a) {
    return "image/png";
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return "image/jpeg";
  }
  if (buf.length >= 6 &&
    buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38 &&
    (buf[4] === 0x37 || buf[4] === 0x39) && buf[5] === 0x61) {
    return "image/gif";
  }
  if (buf.length >= 12 &&
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) {
    return "image/webp";
  }
  return null;
}
