import {
  AdaptiveExtractionConfig,
  MediaInfo,
  FileType,
  FrameInfo,
} from "../types";
import { FileHashBaseJob } from "./FileHashBaseJob";
import { getFileType } from "../utils";
import { inject, injectable } from "inversify";
import { SharpService } from "../contexts/SharpService";
import { FFmpegService } from "../contexts/FFmpegService";
import { Types, type WorkerPool } from "../contexts/types";

@injectable()
export class AdaptiveExtractionJob extends FileHashBaseJob<
  MediaInfo,
  AdaptiveExtractionConfig
> {
  protected readonly jobName = "adaptiveExtraction";

  constructor(
    protected config: AdaptiveExtractionConfig,
    private sharpService: SharpService,
    private ffmpegService: FFmpegService,
    @inject(Types.WorkerPool) private workerPool: WorkerPool,
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

    const hash = await this.computePerceptualHash(data);
    return [{ hash, timestamp: 0 }];
  }

  private async extractVideoFrames(
    videoPath: string,
    duration: number,
  ): Promise<FrameInfo[]> {
    const targetFrameCount = Math.ceil(duration * this.config.targetFps);

    const frameInterval =
      duration / Math.min(targetFrameCount, this.config.minFrames);
    const minInterval = 1 / this.config.targetFps;
    // eq(n,0) is used to select the first frame
    // gt(scene,threshold) is used to detect scene changes
    // gte(t-prev_selected_t,minInterval) is used to select frames at a minimum interval
    // gte(t-prev_selected_t,frameInterval) is used to select frames at regular intervals
    const selectFilter = `select='eq(n,0)+gt(scene,${this.config.sceneChangeThreshold})*gte(t-prev_selected_t\\,${minInterval})+gte(t-prev_selected_t\\,${frameInterval})'`;
    let frames = await this.extractFramesWithFilter(videoPath, selectFilter);

    if (frames.length < 1) {
      throw new Error(`No frames extracted from ${videoPath}`);
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

    return frames;
  }

  private extractFramesWithFilter(
    videoPath: string,
    selectFilter: string,
  ): Promise<FrameInfo[]> {
    return new Promise((resolve, reject) => {
      let buffer = Buffer.alloc(0);
      const frameSize = this.config.resolution * this.config.resolution;
      const pendingTimestamps: number[] = [];
      const frameProcessingPromises: Promise<FrameInfo>[] = [];

      const processFrames = () => {
        while (pendingTimestamps.length > 0 && buffer.length >= frameSize) {
          const timestamp = pendingTimestamps.shift()!;
          const frameBuffer = buffer.subarray(0, frameSize);
          buffer = buffer.subarray(frameSize);

          const framePromise = this.computePerceptualHash(
            Uint8Array.from(frameBuffer),
          ).then((hash) => {
            return { hash, timestamp };
          });
          frameProcessingPromises.push(framePromise);
        }
      };

      this.ffmpegService
        .ffmpeg(videoPath)
        .videoFilters([
          selectFilter,
          `showinfo`,
          `scale=${this.config.resolution}:${this.config.resolution}:force_original_aspect_ratio=disable:flags=lanczos`,
          "format=gray",
        ])
        .outputOptions(["-vsync", "vfr", "-f", "rawvideo"])
        .on("error", (error) => {
          reject(new Error(`FFmpeg error: ${error.message}`));
        })
        .on("end", async () => {
          processFrames();
          resolve(Promise.all(frameProcessingPromises));
        })
        .on("stderr", (stderrLine: string) => {
          const timeMatch = stderrLine.match(/pts_time:([0-9.]+)/);
          if (timeMatch) {
            const timestamp = parseFloat(timeMatch[1]);
            pendingTimestamps.push(timestamp);
            processFrames();
          }
        })
        .pipe()
        .on("data", (chunk: Buffer) => {
          buffer = Buffer.concat([buffer, chunk]);
          processFrames();
        });
    });
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

  private async computePerceptualHash(
    imageBuffer: Uint8Array,
  ): Promise<SharedArrayBuffer> {
    const buffer = await this.workerPool.computePerceptualHash(
      imageBuffer,
      this.config.resolution,
    );
    const sharedBuffer = new SharedArrayBuffer(buffer.byteLength);
    new Uint8Array(sharedBuffer).set(new Uint8Array(buffer));
    return sharedBuffer;
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
