import {
  AdaptiveExtractionConfig,
  MediaInfo,
  FileType,
  FrameInfo,
} from "../types";
import { FileHashBaseJob } from "./FileHashBaseJob";
import { getFileType } from "../utils";
import { injectable } from "inversify";
import { SharpService } from "../contexts/SharpService";
import { FFmpegService } from "../contexts/FFmpegService";

@injectable()
export class AdaptiveExtractionJob extends FileHashBaseJob<
  MediaInfo,
  AdaptiveExtractionConfig
> {
  protected readonly jobName = "adaptiveExtraction";
  private readonly HASH_SIZE = 32;
  private cosTable: Float32Array | null = null;

  constructor(
    protected config: AdaptiveExtractionConfig,
    private sharpService: SharpService,
    private ffmpegService: FFmpegService,
  ) {
    super();
  }

  protected async processFile(filePath: string): Promise<MediaInfo> {
    const mediaType = getFileType(filePath);
    if (mediaType === FileType.Image) {
      return {
        frames: await this.extractImageFrames(filePath),
        duration: 0,
      };
    } else {
      const duration = await this.getVideoDuration(filePath);
      return {
        frames: await this.extractVideoFrames(filePath, duration),
        duration,
      };
    }
  }

  protected isConfigValid(
    filePath: string,
    cachedConfig: AdaptiveExtractionConfig | undefined,
  ): boolean {
    const fileType = getFileType(filePath);
    if (fileType === FileType.Image) {
      // for images, we only need to check the resolution
      return cachedConfig?.resolution === this.config.resolution;
    } else {
      return super.isConfigValid(filePath, cachedConfig);
    }
  }

  private async extractImageFrames(imagePath: string): Promise<FrameInfo[]> {
    const image = this.sharpService.create(imagePath);
    const data = await image
      .resize(this.config.resolution, this.config.resolution, {
        fit: "fill",
      })
      .grayscale()
      .raw()
      .toBuffer();

    const hash = this.computePerceptualHash(data);
    return [{ hash, timestamp: 0 }];
  }

  private async extractVideoFrames(
    videoPath: string,
    duration: number,
  ): Promise<FrameInfo[]> {
    const minFrameCount = this.config.minFrames;
    const targetFrameCount = Math.ceil(duration * this.config.targetFps);

    let frames: FrameInfo[];

    if (duration <= this.config.shortVideoThreshold) {
      // For short videos, extract frames evenly
      frames = await this.extractFramesEvenly(
        videoPath,
        duration,
        minFrameCount,
      );
    } else {
      // For longer videos, start with scene change detection
      frames = await this.detectSceneChanges(videoPath);

      // If scene changes don't yield enough frames, supplement with evenly spaced frames
      if (frames.length < minFrameCount) {
        const additionalFrames = await this.extractFramesEvenly(
          videoPath,
          duration,
          minFrameCount - frames.length,
        );
        frames = this.mergeAndSortFrames(frames, additionalFrames);
      }

      // If we have more than the target frame count, consider reducing
      if (
        frames.length > targetFrameCount &&
        frames.length > this.config.maxSceneFrames
      ) {
        frames = this.reduceFrames(
          frames,
          Math.max(targetFrameCount, this.config.maxSceneFrames),
        );
      }
    }

    return frames;
  }

  private async extractFramesWithFilter(
    videoPath: string,
    selectFilter: string,
  ): Promise<FrameInfo[]> {
    return new Promise((resolve, reject) => {
      const frames: FrameInfo[] = [];
      let buffer = Buffer.alloc(0);
      const frameSize = this.config.resolution * this.config.resolution;
      let currentTimestamp: number | null = null;

      this.ffmpegService
        .ffmpeg(videoPath)
        .videoFilters([
          selectFilter,
          `scale=${this.config.resolution}:${this.config.resolution}:force_original_aspect_ratio=disable:flags=lanczos`,
          "format=gray",
        ])
        .outputOptions(["-vsync", "vfr", "-f", "rawvideo", "-pix_fmt", "gray"])
        .on("error", reject)
        .on("end", () => {
          // Process any remaining complete frame in the buffer
          if (buffer.length >= frameSize && currentTimestamp !== null) {
            const hash = this.computePerceptualHash(buffer.slice(0, frameSize));
            frames.push({ hash, timestamp: currentTimestamp });
          }
          resolve(frames);
        })
        .on("stderr", (stderrLine: string) => {
          const match = stderrLine.match(/time=(\d{2}:\d{2}:\d{2}\.\d{2})/);
          if (match) {
            currentTimestamp = this.timeToSeconds(match[1]);
          }
        })
        .pipe()
        .on("data", (chunk: Buffer) => {
          buffer = Buffer.concat([buffer, chunk]);

          // Process complete frames
          while (buffer.length >= frameSize) {
            if (currentTimestamp !== null) {
              const frameBuffer = buffer.subarray(0, frameSize);
              const hash = this.computePerceptualHash(frameBuffer);
              frames.push({ hash, timestamp: currentTimestamp });
              currentTimestamp = null;
            }
            buffer = buffer.subarray(frameSize);
          }
        });
    });
  }

  private async extractFramesEvenly(
    videoPath: string,
    duration: number,
    frameCount: number,
  ): Promise<FrameInfo[]> {
    const frameInterval = duration / frameCount;
    const selectFilter = `select=(isnan(prev_selected_t)*gte(t\\,${frameInterval}))+gte(t-prev_selected_t\\,${frameInterval})`;
    return this.extractFramesWithFilter(videoPath, selectFilter);
  }

  private async detectSceneChanges(videoPath: string): Promise<FrameInfo[]> {
    const selectFilter = `select='eq(n,0)+gt(scene,${this.config.sceneChangeThreshold})'`;
    return this.extractFramesWithFilter(videoPath, selectFilter);
  }
  private mergeAndSortFrames(
    frames1: FrameInfo[],
    frames2: FrameInfo[],
  ): FrameInfo[] {
    return [...frames1, ...frames2].sort((a, b) => a.timestamp - b.timestamp);
  }

  private reduceFrames(frames: FrameInfo[], targetCount: number): FrameInfo[] {
    if (frames.length <= targetCount) return frames;

    const step = frames.length / targetCount;
    const reducedFrames: FrameInfo[] = [];

    for (let i = 0; i < frames.length; i += step) {
      reducedFrames.push(frames[Math.floor(i)]);
    }

    return reducedFrames;
  }

  private timeToSeconds(timeString: string): number {
    const [time, fractionalSeconds] = timeString.split(".");
    const [hours, minutes, seconds] = time.split(":").map(Number);

    const totalSeconds = hours * 3600 + minutes * 60 + seconds;
    const milliseconds = Number(fractionalSeconds) / 100;

    return totalSeconds + milliseconds;
  }

  private initializeCosTable(size: number): Float32Array {
    const table = new Float32Array(size * size);
    for (let u = 0; u < size; u++) {
      for (let x = 0; x < size; x++) {
        table[u * size + x] = Math.cos(
          ((2 * x + 1) * u * Math.PI) / (2 * size),
        );
      }
    }
    return table;
  }

  private computePerceptualHash(imageBuffer: Buffer): SharedArrayBuffer {
    const size = this.config.resolution;
    const hashSize = this.HASH_SIZE;
    const hash = new SharedArrayBuffer(hashSize);
    const hashView = new Uint8Array(hash);

    // Ensure cosTable is initialized for the current image size
    if (!this.cosTable || this.cosTable.length !== size * size) {
      this.cosTable = this.initializeCosTable(size);
    }

    // Perform 2D DCT
    const dct = this.fastDCT(imageBuffer, size);

    // Compute median of AC components for thresholding
    const medianAC = this.computeMedianAC(dct, size);

    // Compute hash
    const scaleFactor = size / hashSize;
    for (let i = 0; i < hashSize; i++) {
      hashView[i] = 0;
      for (let j = 0; j < 8; j++) {
        const x = Math.floor((j + 1) * scaleFactor);
        const y = Math.floor((i + 1) * scaleFactor);
        const idx = y * size + x;
        if (dct[idx] > medianAC) {
          hashView[i] |= 1 << j;
        }
      }
    }

    return hash;
  }

  private fastDCT(input: Buffer, size: number): Float32Array {
    const output = new Float32Array(size * size);

    // Row-wise DCT
    for (let y = 0; y < size; y++) {
      this.dct1d(input, y * size, output, y * size, size);
    }

    // Transpose
    for (let i = 0; i < size; i++) {
      for (let j = 0; j < i; j++) {
        const a = i * size + j;
        const b = j * size + i;
        const temp = output[a];
        output[a] = output[b];
        output[b] = temp;
      }
    }

    // Column-wise DCT (now row-wise due to transpose)
    for (let y = 0; y < size; y++) {
      this.dct1d(output, y * size, output, y * size, size);
    }

    // Scale the DC component
    output[0] /= size;

    return output;
  }

  private dct1d(
    input: Buffer | Float32Array,
    inputOffset: number,
    output: Float32Array,
    outputOffset: number,
    size: number,
  ): void {
    const cosTable = this.cosTable!;

    for (let k = 0; k < size; k++) {
      let sum = 0;
      for (let n = 0; n < size; n++) {
        sum +=
          (input instanceof Buffer
            ? input[inputOffset + n]
            : input[inputOffset + n]) * cosTable[k * size + n];
      }
      output[outputOffset + k] = sum * Math.sqrt(2 / size);
    }
  }

  private computeMedianAC(dct: Float32Array, size: number): number {
    const acValues = new Float32Array(size * size - 1);
    let idx = 0;
    for (let i = 0; i < size; i++) {
      for (let j = 0; j < size; j++) {
        if (i !== 0 || j !== 0) {
          acValues[idx++] = dct[i * size + j];
        }
      }
    }
    acValues.sort();
    return acValues[Math.floor(acValues.length / 2)];
  }

  async getDuration(filePath: string): Promise<number> {
    const mediaType = getFileType(filePath);
    if (mediaType === FileType.Image) {
      return 0;
    } else {
      return this.getVideoDuration(filePath);
    }
  }

  private async getVideoDuration(videoPath: string): Promise<number> {
    return new Promise((resolve, reject) => {
      this.ffmpegService.ffprobe(videoPath, (err, metadata) => {
        if (err) reject(err);
        else resolve(metadata.format.duration || 0);
      });
    });
  }
}
