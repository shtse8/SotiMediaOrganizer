import { readdir, stat, mkdir, rename, copyFile } from 'fs/promises';
import { join, parse, basename, dirname, extname } from 'path';
import { Semaphore, Mutex } from 'async-mutex';
import { ExifTool } from 'exiftool-vendored';
import { Command } from 'commander';
import sharp from 'sharp';
import { createHash } from 'crypto';

// Initialize ExifTool
const exiftool = new ExifTool();

// Define the supported file extensions
const SUPPORTED_EXTENSIONS = {
  images: ['jpg', 'jpeg', 'jpe', 'jif', 'jfif', 'jfi', 'jp2', 'j2c', 'jpf', 'jpx', 'jpm', 'mj2', 
           'png', 'gif', 'webp', 'tif', 'tiff', 'bmp', 'dib', 'heic', 'heif', 'avif'],
  rawImages: ['cr2', 'cr3', 'nef', 'nrw', 'arw', 'srf', 'sr2', 'dng', 'orf', 'ptx', 'pef', 'rw2', 'raf', 'raw', 'x3f', 'srw'],
  videos: ['mp4', 'm4v', 'mov', '3gp', '3g2', 'avi', 'mpg', 'mpeg', 'mpe', 'mpv', 'm2v', 'm2p', 
           'm2ts', 'mts', 'ts', 'qt', 'wmv', 'asf', 'flv', 'f4v', 'webm', 'divx']
};

const ALL_SUPPORTED_EXTENSIONS = [
  ...SUPPORTED_EXTENSIONS.images,
  ...SUPPORTED_EXTENSIONS.rawImages,
  ...SUPPORTED_EXTENSIONS.videos
];

interface FileInfo {
  path: string;
  size: number;
  hash: string;
  metadata: any;
  quality?: number;
}

interface ProgramOptions {
  source: string[];
  target: string;
  error?: string;
  duplicate?: string;
  workers: string;
  move: boolean;
}

class LSH {
  private bands: Map<string, Set<string>>[];
  private bandSize: number;
  private numBands: number;

  constructor(hashSize: number = 64, numBands: number = 8) {
    this.bandSize = hashSize / numBands;
    this.numBands = numBands;
    this.bands = Array.from({ length: numBands }, () => new Map<string, Set<string>>());
  }

  add(hash: string, identifier: string) {
    for (let i = 0; i < this.numBands; i++) {
      const bandHash = hash.slice(i * this.bandSize, (i + 1) * this.bandSize);
      if (!this.bands[i].has(bandHash)) {
        this.bands[i].set(bandHash, new Set());
      }
      this.bands[i].get(bandHash)!.add(identifier);
    }
  }

  getCandidates(hash: string): Set<string> {
    const candidates = new Set<string>();
    for (let i = 0; i < this.numBands; i++) {
      const bandHash = hash.slice(i * this.bandSize, (i + 1) * this.bandSize);
      const bandCandidates = this.bands[i].get(bandHash);
      if (bandCandidates) {
        for (const candidate of bandCandidates) {
          candidates.add(candidate);
        }
      }
    }
    return candidates;
  }
}

class ThreadSafeLSH {
  private lsh: LSH;
  private mutex: Mutex;

  constructor(hashSize: number = 64, numBands: number = 8) {
    this.lsh = new LSH(hashSize, numBands);
    this.mutex = new Mutex();
  }

  async add(hash: string, identifier: string) {
    const release = await this.mutex.acquire();
    try {
      this.lsh.add(hash, identifier);
    } finally {
      release();
    }
  }

  async getCandidates(hash: string): Promise<Set<string>> {
    const release = await this.mutex.acquire();
    try {
      return this.lsh.getCandidates(hash);
    } finally {
      release();
    }
  }
}

async function calculateFileHash(filePath: string): Promise<string> {
  try {
    if (isImageFile(filePath)) {
      return await calculatePerceptualHash(filePath);
    }
  } catch (error) {
    console.warn(`Warning: Could not process ${filePath} with Sharp. Falling back to file hash.`);
  }
  return calculateSimpleFileHash(filePath);
}

async function calculatePerceptualHash(filePath: string): Promise<string> {
  const { data } = await sharp(filePath, { failOnError: false })
    .resize(8, 8, { fit: 'fill' })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  let hash = '';
  const pixelCount = 8 * 8;
  const totalBrightness = data.reduce((sum: number, pixel: number) => sum + pixel, 0);
  const averageBrightness = totalBrightness / pixelCount;

  for (let i = 0; i < pixelCount; i++) {
    hash += data[i] < averageBrightness ? '0' : '1';
  }

  return hash;
}

async function calculateSimpleFileHash(filePath: string): Promise<string> {
  const fileBuffer = await Bun.file(filePath).arrayBuffer();
  return createHash('md5').update(Buffer.from(fileBuffer)).digest('hex');
}

function isImageFile(filePath: string): boolean {
  const ext = extname(filePath).slice(1).toLowerCase();
  return SUPPORTED_EXTENSIONS.images.includes(ext) || SUPPORTED_EXTENSIONS.rawImages.includes(ext);
}

function hammingDistance(str1: string, str2: string): number {
  if (str1.length !== str2.length) {
    throw new Error('Strings must be of equal length');
  }
  return str1.split('').reduce((count, char, i) => count + (char !== str2[i] ? 1 : 0), 0);
}

async function getMetadata(path: string): Promise<any> {
  try {
    return await exiftool.read(path);
  } catch (error) {
    console.error(`Error getting metadata for ${path}: ${error}`);
    return {};
  }
}

async function getImageQuality(filePath: string): Promise<number> {
  try {
    const { width, height } = await sharp(filePath).metadata();
    return (width || 0) * (height || 0);
  } catch (error) {
    console.warn(`Could not determine image quality for ${filePath}: ${error}`);
    return 0;
  }
}

async function getFileInfo(filePath: string): Promise<FileInfo> {
  const [fileStat, hash, metadata] = await Promise.all([
    stat(filePath),
    calculateFileHash(filePath),
    getMetadata(filePath)
  ]);

  const fileInfo: FileInfo = {
    path: filePath,
    size: fileStat.size,
    hash,
    metadata
  };

  if (isImageFile(filePath)) {
    fileInfo.quality = await getImageQuality(filePath);
  }

  return fileInfo;
}

async function scanTargetFolder(targetDir: string): Promise<[Map<string, FileInfo>, ThreadSafeLSH]> {
  const processedFiles = new Map<string, FileInfo>();
  const lsh = new ThreadSafeLSH();

  async function scanDirectory(dir: string) {
    const files = await readdir(dir);
    for (const file of files) {
      const filePath = join(dir, file);
      const fileStat = await stat(filePath);
      if (fileStat.isDirectory()) {
        await scanDirectory(filePath);
      } else if (ALL_SUPPORTED_EXTENSIONS.includes(extname(file).slice(1).toLowerCase())) {
        const fileInfo = await getFileInfo(filePath);
        processedFiles.set(fileInfo.hash, fileInfo);
        if (isImageFile(filePath)) {
          lsh.add(fileInfo.hash, fileInfo.hash);
        }
      }
    }
  }

  await scanDirectory(targetDir);
  return [processedFiles, lsh];
}

async function* getMediaFiles(dirPath: string): AsyncGenerator<string> {
  const files = await readdir(dirPath);
  for (const file of files) {
    const filePath = join(dirPath, file);
    const fileStat = await stat(filePath);
    if (fileStat.isDirectory()) {
      yield* getMediaFiles(filePath);
    } else if (ALL_SUPPORTED_EXTENSIONS.includes(extname(file).slice(1).toLowerCase())) {
      yield filePath;
    }
  }
}

function selectBestFile(files: FileInfo[]): FileInfo {
  return files.reduce((best, current) => {
    // Prioritize files with geolocation data
    if (current.metadata.GPSLatitude && !best.metadata.GPSLatitude) return current;
    if (best.metadata.GPSLatitude && !current.metadata.GPSLatitude) return best;

    // Prioritize files with more metadata
    const currentMetadataCount = Object.keys(current.metadata).length;
    const bestMetadataCount = Object.keys(best.metadata).length;
    if (currentMetadataCount > bestMetadataCount) return current;
    if (bestMetadataCount > currentMetadataCount) return best;

    // For images, prioritize higher quality
    if (current.quality && best.quality) {
      if (current.quality > best.quality) return current;
      if (best.quality > current.quality) return best;
    }

    // If all else is equal, choose the larger file
    return current.size > best.size ? current : best;
  });
}

async function processMediaFile(
  mediaFile: string, 
  targetDir: string, 
  errorDir: string | undefined, 
  duplicateDir: string | undefined, 
  shouldMove: boolean,
  processedFiles: Map<string, FileInfo>,
  lsh: ThreadSafeLSH,
  mutex: Mutex
): Promise<void> {
  let fileInfo: FileInfo;
  try {
    fileInfo = await getFileInfo(mediaFile);
  } catch (e) {
    console.error(`${mediaFile}: Error processing file - ${e}`);
    if (errorDir) {
      const errorPath = join(errorDir, basename(mediaFile));
      await transferFile(mediaFile, errorPath, shouldMove);
      console.log(`${mediaFile}: Moved to error directory ${errorPath}`);
    } else {
      console.log(`${mediaFile}: Error occurred, but no error directory specified. Skipping file.`);
    }
    return;
  }

  console.log(`Processing ${mediaFile}`);

  const release = await mutex.acquire();
  try {
    if (processedFiles.has(fileInfo.hash)) {
      const existingFile = processedFiles.get(fileInfo.hash)!;
      console.log(`${mediaFile}: Exact duplicate of ${existingFile.path}. Skipping.`);
      if (duplicateDir) {
        const duplicateTargetPath = join(duplicateDir, basename(mediaFile));
        await transferFile(mediaFile, duplicateTargetPath, shouldMove);
        console.log(`${mediaFile}: Moved to duplicate directory ${duplicateTargetPath}`);
      }
      return;
    }

    // Check for similar images
    if (isImageFile(mediaFile)) {
      const candidates = await lsh.getCandidates(fileInfo.hash);
      for (const candidateHash of candidates) {
        const existingFile = processedFiles.get(candidateHash)!;
        if (hammingDistance(fileInfo.hash, existingFile.hash) <= 10) {
          const bestFile = selectBestFile([existingFile, fileInfo]);
          if (bestFile.path === mediaFile) {
            // Current file is better, replace the existing one
            console.log(`${mediaFile}: Better quality than existing file ${existingFile.path}. Replacing.`);
            await transferFile(mediaFile, existingFile.path, true);
            processedFiles.set(fileInfo.hash, { ...fileInfo, path: existingFile.path });
            await lsh.add(fileInfo.hash, fileInfo.hash);
          } else {
            console.log(`${mediaFile}: Similar to ${existingFile.path}, but lower quality. Skipping.`);
            if (duplicateDir) {
              const duplicateTargetPath = join(duplicateDir, basename(mediaFile));
              await transferFile(mediaFile, duplicateTargetPath, shouldMove);
              console.log(`${mediaFile}: Moved to duplicate directory ${duplicateTargetPath}`);
            }
          }
          return;
        }
      }
    }

    const date = fileInfo.metadata.DateTimeOriginal ? new Date(fileInfo.metadata.DateTimeOriginal) :
                 fileInfo.metadata.CreateDate ? new Date(fileInfo.metadata.CreateDate) :
                 new Date();

    const targetPath = await findUniquePath(join(targetDir, date.getFullYear().toString(), basename(mediaFile)));
    await transferFile(mediaFile, targetPath, shouldMove);
    console.log(`${mediaFile}: Successfully ${shouldMove ? 'moved' : 'copied'} to ${targetPath}`);

    // Update processedFiles with the new file information
    processedFiles.set(fileInfo.hash, { ...fileInfo, path: targetPath });
    if (isImageFile(mediaFile)) {
      await lsh.add(fileInfo.hash, fileInfo.hash);
    }
  } finally {
    release();
  }
}


async function transferFile(source: string, target: string, shouldMove: boolean): Promise<void> {
  await mkdir(dirname(target), { recursive: true });
  if (shouldMove) {
    await rename(source, target);
  } else {
    await copyFile(source, target);
  }
}

async function findUniquePath(basePath: string): Promise<string> {
  let targetPath = basePath;
  let counter = 1;
  const { name, ext, dir } = parse(basePath);
  while (true) {
    try {
      await stat(targetPath);
      targetPath = join(dir, `${name}_${counter}${ext}`);
      counter++;
    } catch {
      return targetPath;
    }
  }
}

async function main() {
  const program = new Command();

  program
    .name('media-organizer')
    .description('Organize photos and videos based on their creation date')
    .version('1.0.0')
    .requiredOption('-s, --source <paths...>', 'Source directories to process')
    .requiredOption('-t, --target <path>', 'Target directory for organized media')
    .option('-e, --error <path>', 'Directory for files that couldn\'t be processed')
    .option('-d, --duplicate <path>', 'Directory for duplicate files')
    .option('-w, --workers <number>', 'Number of concurrent workers', '5')
    .option('-m, --move', 'Move files instead of copying them', false)
    .parse(process.argv);

  const options = program.opts() as ProgramOptions;

  // Create necessary directories
  await mkdir(options.target, { recursive: true });
  if (options.error) await mkdir(options.error, { recursive: true });
  if (options.duplicate) await mkdir(options.duplicate, { recursive: true });

  console.log('Scanning target folder for existing files...');
  const [processedFiles, lsh] = await scanTargetFolder(options.target);
  console.log(`Found ${processedFiles.size} existing files in the target folder.`);

  const promises: Promise<void>[] = [];
  const semaphore = new Semaphore(parseInt(options.workers, 10));
  const mutex = new Mutex();

  for (const dirPath of options.source) {
    for await (const mediaFile of getMediaFiles(dirPath)) {
      const [, release] = await semaphore.acquire();
      const promise = processMediaFile(mediaFile, options.target, options.error, options.duplicate, options.move, processedFiles, lsh, mutex)
        .then(() => {
          release();
        })
        .catch((error) => {
          console.error(`Unexpected error processing ${mediaFile}: ${error}`);
          release();
        });
      promises.push(promise);
    }
  }

  await Promise.all(promises);
  console.log('Media organization completed');

  await exiftool.end();
}

main().catch((error) => {
  console.error('An unexpected error occurred:', error);
  process.exit(1);
});