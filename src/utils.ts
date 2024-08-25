import { FileType } from "./types";
import { extname } from "path";

export function getFileType(filePath: string): FileType {
  const ext = extname(filePath).slice(1).toLowerCase();
  return getFileTypeByExt(ext);
}

export function getFileTypeByExt(ext: string): FileType {
  for (const fileType of [FileType.Image, FileType.Video]) {
    if (SUPPORTED_EXTENSIONS[fileType].has(ext)) {
      return fileType;
    }
  }
  throw new Error(`Unsupported file type for file ${ext}`);
}

export const SUPPORTED_EXTENSIONS = {
  [FileType.Image]: new Set([
    "jpg",
    "jpeg",
    "jpe",
    "jif",
    "jfif",
    "jfi",
    "jp2",
    "j2c",
    "jpf",
    "jpx",
    "jpm",
    "mj2",
    "png",
    "webp",
    "tif",
    "tiff",
    "bmp",
    "dib",
    "heic",
    "heif",
    "avif",
    "cr2",
    "cr3",
    "nef",
    "nrw",
    "arw",
    "srf",
    "sr2",
    "dng",
    "orf",
    "ptx",
    "pef",
    "rw2",
    "raf",
    "raw",
    "x3f",
    "srw",
  ]),
  [FileType.Video]: new Set([
    "mp4",
    "m4v",
    "mov",
    "3gp",
    "3g2",
    "avi",
    "mpg",
    "mpeg",
    "mpe",
    "mpv",
    "m2v",
    "m2p",
    "m2ts",
    "mts",
    "ts",
    "qt",
    "wmv",
    "asf",
    "flv",
    "f4v",
    "webm",
    "divx",
    "gif",
  ]),
};

export const ALL_SUPPORTED_EXTENSIONS = new Set([
  ...SUPPORTED_EXTENSIONS[FileType.Image],
  ...SUPPORTED_EXTENSIONS[FileType.Video],
]);

export function bufferToSharedArrayBuffer(buffer: Buffer): SharedArrayBuffer {
  const sharedArrayBuffer = new SharedArrayBuffer(buffer.length);
  const sharedArrayBufferView = new Uint8Array(sharedArrayBuffer);
  sharedArrayBufferView.set(new Uint8Array(buffer));
  return sharedArrayBuffer;
}

export function sharedArrayBufferToBuffer(
  sharedArrayBuffer: SharedArrayBuffer,
): Buffer {
  return Buffer.from(sharedArrayBuffer);
}

export async function filterAsync<T>(
  arr: T[],
  filter: (item: T) => Promise<boolean>,
): Promise<T[]> {
  const results = await Promise.all(arr.map(filter));
  return arr.filter((_v, index) => results[index]);
}

export function mapAsync<T, U>(
  arr: T[],
  map: (item: T) => Promise<U>,
): Promise<U[]> {
  return Promise.all(arr.map(map));
}

// Convert SharedArrayBuffer to hex string
export function sharedArrayBufferToHex(buffer: SharedArrayBuffer): string {
  const uint8Array = new Uint8Array(buffer);
  let hexString = "";

  for (let i = 0; i < uint8Array.length; i++) {
    hexString += uint8Array[i].toString(16).padStart(2, "0");
  }

  return hexString;
}

// Convert hex string to SharedArrayBuffer
export function hexToSharedArrayBuffer(hex: string): SharedArrayBuffer {
  if (hex.length % 2 !== 0) {
    throw new Error("Hex string must have an even number of characters");
  }
  const buffer = new SharedArrayBuffer(hex.length / 2);
  const view = new Uint8Array(buffer);
  for (let i = 0; i < hex.length; i += 2) {
    view[i / 2] = parseInt(hex.substr(i, 2), 16);
  }
  return buffer;
}
