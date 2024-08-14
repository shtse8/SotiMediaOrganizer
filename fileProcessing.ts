import { stat } from 'fs/promises';
import { createHash, type Hash } from 'crypto';
import { createReadStream } from 'fs';
import sharp from 'sharp';
import ffmpeg from 'fluent-ffmpeg';
import { ExifDate, ExifDateTime, ExifTool, type Tags } from 'exiftool-vendored';
import { type FileInfo } from './types';
import { MediaOrganizer } from './MediaOrganizer';
import path from 'path';

const exiftool = new ExifTool();

async function getFileInfo(filePath: string, resolution: number, frameCount: number): Promise<FileInfo> {
  const [fileStat, hash, metadata, perceptualHash] = await Promise.all([
    stat(filePath),
    calculateFileHash(filePath),
    getMetadata(filePath),
    isImageFile(filePath) 
      ? getImagePerceptualHash(filePath, resolution)
      : isVideoFile(filePath)
      ? getVideoPerceptualHash(filePath, frameCount, resolution)
      : Promise.resolve(undefined)
  ]);

  const imageDate = toDate(metadata.DateTimeOriginal) ?? toDate(metadata.MediaCreateDate);

  const fileInfo: FileInfo = {
    path: filePath,
    size: fileStat.size,
    hash,
    imageDate: imageDate,
    fileDate: fileStat.mtime,
    perceptualHash: perceptualHash,
    quality: (metadata.ImageHeight ?? 0) * (metadata.ImageWidth ?? 0),
    geoLocation: metadata.GPSLatitude && metadata.GPSLongitude ? `${metadata.GPSLatitude},${metadata.GPSLongitude}` : undefined,
    cameraModel: metadata.Model
  };

  return fileInfo;
}

async function calculateFileHash(filePath: string, maxChunkSize = 1024 * 1024): Promise<string> {
  const hash = createHash('md5');
  const fileSize = (await stat(filePath)).size;

  if (fileSize > maxChunkSize) {
    const chunkSize = maxChunkSize / 2;
    await hashFile(filePath, hash, 0, chunkSize);
    await hashFile(filePath, hash, fileSize - chunkSize, chunkSize);
  } else {
    await hashFile(filePath, hash);
  }

  return hash.digest('hex');
}

function hashFile(filePath: string, hash: Hash, start: number = 0, size?: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const stream = createReadStream(filePath, { start, end: size ? start + size - 1 : undefined});
    stream.on('data', (chunk: Buffer) => hash.update(chunk));
    stream.on('end', resolve);
    stream.on('error', reject);
  });
}

function getMetadata(path: string): Promise<Tags> {
  return exiftool.read(path);
}

async function getImagePerceptualHash(filePath: string, resolution: number): Promise<string> {
  const image = sharp(filePath, { failOnError: false });

  try {
    const perceptualHashData = await image
        .resize(resolution, resolution, { fit: 'fill' })
        .greyscale()
        .raw()
        .toBuffer({ resolveWithObject: false });

    return getPerceptualHash(perceptualHashData, resolution);
  } finally {
    image.destroy();
  }
}

function getVideoPerceptualHash(filePath: string, numFrames: number = 10, resolution: number = 8): Promise<string> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) {
        return reject(err);
      }

      const duration = metadata.format.duration;
      if (!duration) {
        return reject(new Error('Could not determine video duration.'));
      }

      const interval = Math.max(1, duration / (numFrames + 1));
      const frameBuffers: Buffer[] = [];

      ffmpeg(filePath)
        .on('error', (err) => {
          return reject(err);
        })
        .on('end', async () => {
          try {
            if (frameBuffers.length <= 0) {
              return reject(new Error('No frames extracted from video.'));
            }
            const combinedHash = await combineFrameHashes(frameBuffers, resolution);
            resolve(combinedHash);
          } catch (error) {
            reject(error);
          }
        })
        .videoFilters(
          `select='(isnan(prev_selected_t)*gte(t\\,${interval}))+gte(t-prev_selected_t\\,${interval})',scale=${resolution}:${resolution},format=gray`
        )
        .outputOptions('-vsync', 'vfr', '-vcodec', 'rawvideo', '-f', 'rawvideo', '-pix_fmt', 'gray')
        .pipe()
        .on('data', (chunk) => {
          frameBuffers.push(chunk);
        });
    });
  });
}

async function combineFrameHashes(frameBuffers: Buffer[], resolution: number): Promise<string> {
  const pixelCount = resolution * resolution;
  const frameCount = frameBuffers.length;
  const averageBuffer = Buffer.alloc(pixelCount);

  // Calculate average pixel values across all frames
  for (let i = 0; i < pixelCount; i++) {
    let sum = 0;
    for (const frameBuffer of frameBuffers) {
      sum += frameBuffer[i];
    }
    averageBuffer[i] = Math.round(sum / frameCount);
  }

  // Calculate perceptual hash from the average frame
  return getPerceptualHash(averageBuffer, resolution);
}

function getPerceptualHash(imageBuffer: Buffer, resolution: number): string {
  const pixelCount = resolution * resolution;
  const totalBrightness = imageBuffer.reduce((sum, pixel) => sum + pixel, 0);
  const averageBrightness = totalBrightness / pixelCount;

  let hash = '';
  for (let i = 0; i < pixelCount; i++) {
    hash += imageBuffer[i] < averageBrightness ? '0' : '1';
  }

  return hash;
}

function toDate(value: string | ExifDateTime | ExifDate | undefined): Date | undefined {
  if (!value) return undefined;
  if (typeof value === 'string') return new Date(value);
  if (value instanceof ExifDateTime || value instanceof ExifDate) {
    return value.toDate();
  }
  return undefined;
}

function isImageFile(filePath: string): boolean {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  return MediaOrganizer.SUPPORTED_EXTENSIONS.images.includes(ext) || MediaOrganizer.SUPPORTED_EXTENSIONS.rawImages.includes(ext);
}

function isVideoFile(filePath: string): boolean {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  return MediaOrganizer.SUPPORTED_EXTENSIONS.videos.includes(ext);
}

// Make sure to export any functions that need to be accessed from other files
export {
  getFileInfo,
  calculateFileHash,
  getMetadata,
  getImagePerceptualHash,
  getVideoPerceptualHash,
  isImageFile,
  isVideoFile
};