import { ExifDate, ExifDateTime, ExifTool, type Tags } from "exiftool-vendored";
import { FileType, type FileInfo } from "./src/types";
import { stat } from "fs/promises";
import { Hash, createHash } from "crypto";
import { createReadStream } from "fs";
import { AdaptiveExtractionJob } from "./src/jobs/AdaptiveExtractionJob";
import { MetadataExtractionJob } from "./src/jobs/MetadataExtractionJob";
import { FileStatsJob } from "./src/jobs/FileStatsJob";
import { Injectable, ProviderScope } from "@tsed/di";

@Injectable({
  scope: ProviderScope.SINGLETON,
})
export class MediaProcessor {
  constructor(
    private exiftool: ExifTool,
    private adaptiveExtractionJob: AdaptiveExtractionJob,
    private metadataExtractionJob: MetadataExtractionJob,
    private fileStatsJob: FileStatsJob,
  ) {}

  async processFile(filePath: string): Promise<FileInfo> {
    const [media, metadata, fileStats] = await Promise.all([
      this.adaptiveExtractionJob.process(filePath),
      this.metadataExtractionJob.process(filePath),
      this.fileStatsJob.process(filePath),
    ]);

    return {
      media,
      metadata,
      fileStats,
    };
  }
  async calculateFileHash(
    filePath: string,
    maxChunkSize = 1024 * 1024,
  ): Promise<Buffer> {
    const hash = createHash("md5");
    const fileSize = (await stat(filePath)).size;

    if (fileSize > maxChunkSize) {
      const chunkSize = maxChunkSize / 2;
      await this.hashFile(filePath, hash, 0, chunkSize);
      await this.hashFile(filePath, hash, fileSize - chunkSize, chunkSize);
    } else {
      await this.hashFile(filePath, hash);
    }

    return hash.digest();
  }

  private hashFile(
    filePath: string,
    hash: Hash,
    start: number = 0,
    size?: number,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const stream = createReadStream(filePath, {
        start,
        end: size ? start + size - 1 : undefined,
      });
      stream.on("data", (chunk: Buffer) => hash.update(chunk));
      stream.on("end", resolve);
      stream.on("error", reject);
    });
  }

  private async getMetadata(path: string): Promise<Tags> {
    return this.exiftool.read(path);
  }

  private toDate(
    value: string | ExifDateTime | ExifDate | undefined,
  ): Date | undefined {
    if (!value) return undefined;
    if (typeof value === "string") return new Date(value);
    if (value instanceof ExifDateTime || value instanceof ExifDate) {
      return value.toDate();
    }
    return undefined;
  }

  async cleanUp() {
    await this.exiftool.end();
  }

  static readonly SUPPORTED_EXTENSIONS = {
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

  static readonly ALL_SUPPORTED_EXTENSIONS = new Set([
    ...MediaProcessor.SUPPORTED_EXTENSIONS[FileType.Image],
    ...MediaProcessor.SUPPORTED_EXTENSIONS[FileType.Video],
  ]);
}
