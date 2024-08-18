import { ExifDate, ExifDateTime, ExifTool, type Tags } from "exiftool-vendored";
import {
  FileType,
  type FileInfo,
  type FrameInfo,
  type ProcessingConfig,
} from "./types";
import { stat } from "fs/promises";
import { extname } from "path";
import sharp from "sharp";
import { Hash, createHash } from "crypto";
import { createReadStream } from "fs";
import ffmpeg from "fluent-ffmpeg";
import { promisify } from "util";

export class MediaProcessor {
  private exiftool: ExifTool;

  constructor(public config: ProcessingConfig) {
    this.exiftool = new ExifTool();
  }

  async processFile(filePath: string, fileHash?: Buffer): Promise<FileInfo> {
    const fileType = this.getFileType(filePath);
    const metadata = await this.getMetadata(filePath);
    const duration = await this.getMediaDuration(filePath, fileType).then(
      (d) => (isNaN(d) ? 0 : d),
    );
    const frames = await this.extractFrames(filePath, fileType, duration);

    fileHash ??= await this.calculateFileHash(filePath);
    const effectiveFrames = duration
      ? Math.floor(duration * this.config.framesPerSecond)
      : 1;

    const fileInfo: FileInfo = {
      hash: fileHash,
      size: (await stat(filePath)).size,
      frames,
      duration,
      imageDate:
        this.toDate(metadata.DateTimeOriginal) ??
        this.toDate(metadata.MediaCreateDate),
      width: metadata.ImageWidth ?? 0,
      height: metadata.ImageHeight ?? 0,
      quality: (metadata.ImageHeight ?? 0) * (metadata.ImageWidth ?? 0),
      gpsLatitude: metadata.GPSLatitude,
      gpsLongitude: metadata.GPSLongitude,
      cameraModel: metadata.Model,
      processingConfig: this.config,
      effectiveFrames,
    };

    return fileInfo;
  }

  private getFileType(filePath: string): FileType {
    const ext = extname(filePath).toLowerCase();
    return MediaProcessor.SUPPORTED_EXTENSIONS[FileType.Image].has(ext.slice(1))
      ? FileType.Image
      : FileType.Video;
  }

  private async getMediaDuration(
    filePath: string,
    fileType: FileType,
  ): Promise<number> {
    if (fileType === FileType.Image) {
      return 0;
    }
    const metadata = await promisify<string, ffmpeg.FfprobeData>(
      ffmpeg.ffprobe,
    )(filePath);
    return metadata.format.duration || 0;
  }

  private async extractFrames(
    filePath: string,
    fileType: FileType,
    duration: number,
  ): Promise<FrameInfo[]> {
    if (fileType === FileType.Image) {
      return this.extractImageFrames(filePath);
    } else {
      return this.extractVideoFrames(filePath, duration);
    }
  }

  private async extractImageFrames(filePath: string): Promise<FrameInfo[]> {
    const image = sharp(filePath);
    const data = await image
      .resize(this.config.resolution, this.config.resolution, { fit: "fill" })
      .grayscale()
      .raw()
      .toBuffer({ resolveWithObject: false });

    const hash = this.getPerceptualHash(data);
    return [{ hash, timestamp: 0 }];
  }

  private async extractVideoFrames(
    filePath: string,
    duration: number,
  ): Promise<FrameInfo[]> {
    const frameCount = Math.min(
      Math.ceil(duration * this.config.framesPerSecond),
      this.config.maxFrames,
    );
    const interval = Math.max(1, duration / (frameCount + 1));
    const frames: FrameInfo[] = [];

    return new Promise((resolve, reject) => {
      ffmpeg(filePath)
        .videoFilters(
          `select='(isnan(prev_selected_t)*gte(t\\,${interval}))+gte(t-prev_selected_t\\,${interval})',scale=${this.config.resolution}:${this.config.resolution},format=gray`,
        )
        .outputOptions(
          "-vsync",
          "vfr",
          "-vcodec",
          "rawvideo",
          "-f",
          "rawvideo",
          "-pix_fmt",
          "gray",
        )
        .on("error", reject)
        .on("end", async () => {
          try {
            if (frames.length < 1) {
              throw new Error("Video has less than 1 frames");
            }
            resolve(frames);
          } catch (error) {
            reject(error);
          }
        })
        .pipe()
        .on("data", (chunk) => {
          frames.push({
            hash: this.getPerceptualHash(chunk),
            timestamp: frames.length * interval * 1000,
          });
        });
    });
  }

  private getPerceptualHash(imageBuffer: Buffer): Buffer {
    const resolution = Math.sqrt(imageBuffer.length);
    if (!Number.isInteger(resolution)) {
      throw new Error("Image buffer does not represent a square image");
    }

    const pixelCount = imageBuffer.length;
    const hash = Buffer.alloc(Math.ceil(pixelCount / 8));

    const average =
      imageBuffer.reduce((sum, pixel) => sum + pixel, 0) / pixelCount;

    for (let i = 0; i < pixelCount; i++) {
      if (imageBuffer[i] > average) {
        hash[Math.floor(i / 8)] |= 1 << i % 8;
      }
    }

    return hash;
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

  async cleanup() {
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
