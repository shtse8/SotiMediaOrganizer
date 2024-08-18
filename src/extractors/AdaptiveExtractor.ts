import sharp from "sharp";
import ffmpeg from "fluent-ffmpeg";
import { AdaptiveExtractionConfig, FileType, FrameInfo } from "../types";
import { Injectable } from "@tsed/di";
import { MediaOrganizer } from "../../MediaOrganizer";

@Injectable()
export class AdaptiveExtractor {
  constructor(private config: AdaptiveExtractionConfig) {}

  extractFrames(filePath: string): Promise<FrameInfo[]> {
    const mediaType = MediaOrganizer.getFileType(filePath);
    if (mediaType === FileType.Image) {
      return this.extractImageFrames(filePath);
    } else {
      return this.extractVideoFrames(filePath);
    }
  }

  private async extractImageFrames(imagePath: string): Promise<FrameInfo[]> {
    const image = sharp(imagePath);
    const data = await image
      .resize(this.config.resolution, this.config.resolution, { fit: "fill" })
      .grayscale()
      .raw()
      .toBuffer();

    const hash = this.computePerceptualHash(data);
    return [FrameInfo.create({ hash, timestamp: 0 })];
  }

  private async extractVideoFrames(videoPath: string): Promise<FrameInfo[]> {
    const sceneChanges = await this.detectSceneChanges(videoPath);
    const keyFrames = await Promise.all(
      sceneChanges.map(async (timestamp) => {
        const frameData = await this.extractVideoFrame(videoPath, timestamp);
        const hash = this.computePerceptualHash(frameData);
        return FrameInfo.create({ hash, timestamp });
      }),
    );
    return keyFrames;
  }

  private async detectSceneChanges(videoPath: string): Promise<number[]> {
    return new Promise((resolve, reject) => {
      const sceneChanges: number[] = [];
      let lastSceneChange = 0;
      ffmpeg(videoPath)
        .videoFilters(`select='gt(scene,${this.config.sceneChangeThreshold})'`)
        .outputOptions("-f null")
        .on("stderr", (stderrLine: string) => {
          const match = stderrLine.match(/time=(\d{2}:\d{2}:\d{2}\.\d{2})/);
          if (match) {
            const timeInSeconds = this.timeToSeconds(match[1]);
            if (timeInSeconds > lastSceneChange) {
              lastSceneChange = timeInSeconds;
              sceneChanges.push(timeInSeconds);
            }
          }
        })
        .on("end", () => resolve(sceneChanges))
        .on("error", reject)
        .output("/dev/null")
        .run();
    });
  }

  private timeToSeconds(timeString: string): number {
    const [time, fractionalSeconds] = timeString.split(".");
    const [hours, minutes, seconds] = time.split(":").map(Number);

    const totalSeconds = hours * 3600 + minutes * 60 + seconds;
    const milliseconds = Number(fractionalSeconds) / 100;

    return totalSeconds + milliseconds;
  }

  public getAdaptiveVideoFrames(
    keyFrames: FrameInfo[],
    duration: number,
  ): FrameInfo[] {
    const frameCount = Math.min(
      Math.ceil(duration * this.config.baseFrameRate),
      this.config.maxFrames,
    );
    const interval = duration / (frameCount + 1);

    const frames: FrameInfo[] = [];
    let nextSceneChange = 0;

    for (let i = 0; i < frameCount; i++) {
      const timestamp = i * interval;

      while (
        nextSceneChange < keyFrames.length &&
        keyFrames[nextSceneChange].timestamp < timestamp
      ) {
        nextSceneChange++;
      }

      frames.push(
        FrameInfo.create({
          hash: keyFrames[nextSceneChange].hash,
          timestamp: timestamp,
        }),
      );
    }

    return frames;
  }

  private async extractVideoFrame(
    videoPath: string,
    timestamp: number,
  ): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const buffers: Buffer[] = [];
      ffmpeg(videoPath)
        .seekInput(timestamp)
        .frames(1)
        .size(`${this.config.resolution}x${this.config.resolution}`)
        .outputOptions("-pix_fmt gray")
        .outputFormat("rawvideo")
        .on("error", reject)
        .on("end", () => resolve(Buffer.concat(buffers)))
        .pipe()
        .on("data", (chunk) => buffers.push(chunk));
    });
  }

  private computePerceptualHash(imageBuffer: Buffer): Buffer {
    const pixelCount = this.config.resolution * this.config.resolution;
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

  async getDuration(filePath: string): Promise<number> {
    const mediaType = MediaOrganizer.getFileType(filePath);
    if (mediaType === FileType.Image) {
      return 0;
    } else {
      return this.getVideoDuration(filePath);
    }
  }

  private async getVideoDuration(videoPath: string): Promise<number> {
    return new Promise((resolve, reject) => {
      ffmpeg.ffprobe(videoPath, (err, metadata) => {
        if (err) reject(err);
        else resolve(metadata.format.duration || 0);
      });
    });
  }
}
