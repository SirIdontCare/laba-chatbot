import "server-only";
import type { FileUIPart } from "ai";
import { isPhotoType, MAX_PHOTO_BYTES } from "./image-input";

export function validPhotoPart(part: FileUIPart) {
  if (!isPhotoType(part.mediaType)) return false;
  const prefix = `data:${part.mediaType};base64,`;
  if (!part.url.startsWith(prefix)) return false;
  const data = part.url.slice(prefix.length);
  if (!data.length || data.length > Math.ceil(MAX_PHOTO_BYTES / 3) * 4 ||
    data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return false;
  const bytes = Buffer.from(data, "base64");
  if (!bytes.length || bytes.length > MAX_PHOTO_BYTES || bytes.toString("base64") !== data) return false;
  if (part.mediaType === "image/jpeg") return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (part.mediaType === "image/png") return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  return bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP";
}
