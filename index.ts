import { readdir, stat, mkdir, rename, copyFile, unlink, readFile, open } from 'fs/promises';
import { join, parse, basename, dirname, extname } from 'path';
import { Semaphore, Mutex } from 'async-mutex';
import { ExifTool } from 'exiftool-vendored';
import { Command } from 'commander';
import sharp from 'sharp';
import { createHash } from 'crypto';
import cliProgress from 'cli-progress';
import chalk from 'chalk';
import heicConvert from 'heic-convert';
import { Buffer } from 'buffer';

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
  perceptualHash?: string;
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
  resolution: string;
  hamming: string;
  format: string;
}

interface ProcessingStats {
  processed: number;
  duplicates: number;
  errors: number;
  replaced: number;
}

const stats: ProcessingStats = {
  processed: 0,
  duplicates: 0,
  errors: 0,
  replaced: 0,
};

const perceptualHashMap = new Map<string, string>(); // Maps perceptualHash -> simpleHash

const progressBar = new cliProgress.SingleBar({
  format: 'Processing |' + chalk.cyan('{bar}') + '| {percentage}% || {value}/{total} Files || Duplicates: {duplicates} | Errors: {errors} | Replaced: {replaced}',
  barCompleteChar: '\u2588',
  barIncompleteChar: '\u2591',
  hideCursor: true
});

function logMessage(message: string) {
  console.log(message);
  progressBar.updateETA();
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

  remove(hash: string, identifier: string) {
    for (let i = 0; i < this.numBands; i++) {
      const bandHash = hash.slice(i * this.bandSize, (i + 1) * this.bandSize);
      const bandCandidates = this.bands[i].get(bandHash);
      if (bandCandidates) {
        bandCandidates.delete(identifier);
        if (bandCandidates.size === 0) {
          this.bands[i].delete(bandHash);
        }
      }
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

  async remove(hash: string, identifier: string) {
    const release = await this.mutex.acquire();
    try {
      this.lsh.remove(hash, identifier);
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
async function calculatePartialFileHash(filePath: string, chunkSize = 1024 * 1024): Promise<string> {
  const hash = createHash('md5');
  const fileHandle = await open(filePath, 'r');

  try {
    const fileSize = (await fileHandle.stat()).size;

    // Read first chunk
    const bufferStart = Buffer.alloc(chunkSize);
    await fileHandle.read(bufferStart, 0, chunkSize, 0);
    hash.update(bufferStart);

    // Read last chunk if the file is larger than the chunk size
    if (fileSize > chunkSize) {
      const bufferEnd = Buffer.alloc(chunkSize);
      await fileHandle.read(bufferEnd, 0, chunkSize, fileSize - chunkSize);
      hash.update(bufferEnd);
    }
  } finally {
    await fileHandle.close();
  }

  return hash.digest('hex');
}

async function calculateFileHashes(filePath: string, resolution: number): Promise<{ hash: string, perceptualHash?: string }> {
  // Use partial hash for large files
  const fileStat = await stat(filePath);
  let hash;
  if (fileStat.size > 1024 * 1024 * 100) { // e.g., files larger than 100MB
    hash = await calculatePartialFileHash(filePath);
  } else {
    hash = await calculateSimpleFileHash(filePath); // Full hash for smaller files
  }

  let perceptualHash;
  if (isImageFile(filePath)) {
    try {
      perceptualHash = await calculatePerceptualHash(filePath, resolution);
    } catch (error) {
      console.warn(`Warning: Could not process ${filePath} with perceptual hashing.`);
    }
  }

  return { hash, perceptualHash };
}


async function convertHeicToJpeg(inputPath: string): Promise<Buffer> {
  const inputBuffer = await readFile(inputPath);
  
  // Convert Buffer to ArrayBuffer
  const arrayBuffer = inputBuffer.buffer.slice(
    inputBuffer.byteOffset,
    inputBuffer.byteOffset + inputBuffer.byteLength
  );

  const convertedBuffer = await heicConvert({
    buffer: arrayBuffer, // Pass the ArrayBuffer here
    format: 'JPEG',
    quality: 1
  });
  
  return Buffer.from(convertedBuffer); // Convert the ArrayBuffer back to Buffer if needed
}

async function calculatePerceptualHash(filePath: string, resolution: number): Promise<string> {
  let inputBuffer: Buffer;
  
  if (extname(filePath).toLowerCase() === '.heic') {
    inputBuffer = await convertHeicToJpeg(filePath);
  } else {
    inputBuffer = await readFile(filePath);
  }

  const { data } = await sharp(inputBuffer, { failOnError: false })
    .resize(resolution, resolution, { fit: 'fill' })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  let hash = '';
  const pixelCount = resolution * resolution;
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

function hammingDistance(str1: string, str2: string, threshold: number): boolean {
  if (str1.length !== str2.length) {
    throw new Error('Strings must be of equal length');
  }
  const distance = str1.split('').reduce((count, char, i) => count + (char !== str2[i] ? 1 : 0), 0);
  return distance <= threshold;
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
    let metadata;
    if (extname(filePath).toLowerCase() === '.heic') {
      const jpegBuffer = await convertHeicToJpeg(filePath);
      metadata = await sharp(jpegBuffer).metadata();
    } else {
      metadata = await sharp(filePath).metadata();
    }
    return (metadata.width || 0) * (metadata.height || 0);
  } catch (error) {
    console.warn(`Could not determine image quality for ${filePath}: ${error}`);
    return 0;
  }
}

async function getFileInfo(filePath: string, resolution: number): Promise<FileInfo> {
  const [fileStat, hashes, metadata] = await Promise.all([
    stat(filePath),
    calculateFileHashes(filePath, resolution),
    getMetadata(filePath)
  ]);

  const { hash, perceptualHash } = hashes;

  const fileInfo: FileInfo = {
    path: filePath,
    size: fileStat.size,
    hash,
    perceptualHash,
    metadata
  };

  if (isImageFile(filePath)) {
    fileInfo.quality = await getImageQuality(filePath);
  }

  return fileInfo;
}

async function scanTargetFolder(targetDir: string, resolution: number): Promise<[Map<string, FileInfo>, ThreadSafeLSH]> {
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
        const fileInfo = await getFileInfo(filePath, resolution);
        processedFiles.set(fileInfo.hash, fileInfo);
        if (isImageFile(filePath)) {
          await lsh.add(fileInfo.hash, fileInfo.hash);
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

async function transferFile(source: string, target: string, shouldMove: boolean): Promise<void> {
  await mkdir(dirname(target), { recursive: true });
  
  if (shouldMove) {
    try {
      await rename(source, target);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'EXDEV') {
        // Cross-device move, fallback to copy-then-delete
        await copyFile(source, target);
        await unlink(source);
      } else {
        throw error; // Re-throw if it's a different error
      }
    }
  } else {
    await copyFile(source, target);
  }
}

async function processMediaFile(
  mediaFile: string, 
  targetDir: string, 
  errorDir: string | undefined, 
  duplicateDir: string | undefined, 
  shouldMove: boolean,
  processedFiles: Map<string, FileInfo>,
  lsh: ThreadSafeLSH,
  mutex: Mutex,
  resolution: number,
  hammingThreshold: number,
  format: string
): Promise<void> {
  let fileInfo: FileInfo;
  try {
    fileInfo = await getFileInfo(mediaFile, resolution);
  } catch (error) {
    stats.errors++;
    logMessage(chalk.red(`Error processing ${mediaFile}: ${error}`));
    if (errorDir) {
      const errorPath = join(errorDir, basename(mediaFile));
      try {
        await transferFile(mediaFile, errorPath, shouldMove);
        logMessage(chalk.yellow(`Moved to error directory: ${errorPath}`));
      } catch (transferError) {
        logMessage(chalk.red(`Failed to move to error directory: ${transferError}`));
      }
    }
    return;
  }

  const release = await mutex.acquire();
  try {
    if (processedFiles.has(fileInfo.hash)) {
      stats.duplicates++;
      if (duplicateDir) {
        const duplicateTargetPath = join(duplicateDir, basename(mediaFile));
        await transferFile(mediaFile, duplicateTargetPath, shouldMove);
        logMessage(chalk.yellow(`Duplicate found: ${mediaFile} -> ${duplicateTargetPath}`));
      } else {
        logMessage(chalk.yellow(`Duplicate found: ${mediaFile} (skipped)`));
      }
      return;
    }

    if (fileInfo.perceptualHash && isImageFile(mediaFile)) {
      const candidates = await lsh.getCandidates(fileInfo.perceptualHash);
      for (const candidateHash of candidates) {
        const simpleHash = perceptualHashMap.get(candidateHash);
        if (!simpleHash) {
          logMessage(chalk.red(`Internal error: Missing simpleHash for perceptualHash ${candidateHash}`));
          throw new Error(`Missing simpleHash for perceptualHash ${candidateHash}`);
        }
    
        const existingFile = processedFiles.get(simpleHash);
        if (!existingFile) {
          logMessage(chalk.red(`Internal error: Missing FileInfo for simpleHash ${simpleHash}`));
          throw new Error(`Missing FileInfo for simpleHash ${simpleHash}`);
        }

        if (existingFile.perceptualHash && hammingDistance(fileInfo.perceptualHash, existingFile.perceptualHash, hammingThreshold)) {
          const bestFile = selectBestFile([existingFile, fileInfo]);
          if (bestFile.path === mediaFile) {
            // Handle the best file scenario
            stats.replaced++;
            await unlink(existingFile.path);

            // Remove the hash from LSH
            await lsh.remove(existingFile.perceptualHash, existingFile.perceptualHash);

            logMessage(chalk.yellow(`Similar file replaced: ${existingFile.path} -> ${mediaFile}`));
          } else {
            stats.duplicates++;
            if (duplicateDir) {
              const duplicateTargetPath = join(duplicateDir, basename(mediaFile));
              await transferFile(mediaFile, duplicateTargetPath, shouldMove);
              logMessage(chalk.yellow(`Similar file moved: ${mediaFile} -> ${duplicateTargetPath}`));
            } else {
              logMessage(chalk.yellow(`Similar file found: ${mediaFile} (skipped), bestFile.path = ${bestFile.path}`));
            }
            return;
          }
        }
      }
    }

    const date = fileInfo.metadata.DateTimeOriginal ? new Date(fileInfo.metadata.DateTimeOriginal) :
                 fileInfo.metadata.CreateDate ? new Date(fileInfo.metadata.CreateDate) :
                 new Date();

    // Generate target path using the format provided
    let targetPath = await findUniquePath(generateTargetPath(format, targetDir, date, basename(mediaFile)));

    await transferFile(mediaFile, targetPath, shouldMove);
    
    logMessage(chalk.green(`Successfully ${shouldMove ? 'moved' : 'copied'} ${mediaFile} to ${targetPath}`));
    
    processedFiles.set(fileInfo.hash, { ...fileInfo, path: targetPath });
    if (fileInfo.perceptualHash && isImageFile(mediaFile)) {
      await lsh.add(fileInfo.perceptualHash, fileInfo.perceptualHash);
      perceptualHashMap.set(fileInfo.perceptualHash, fileInfo.hash);
    }

    stats.processed++;
  } catch (error) {
    stats.errors++;
    logMessage(chalk.red(`Error processing ${mediaFile}: ${error}`));
  } finally {
    release();
  }

  progressBar.increment({
    duplicates: stats.duplicates,
    errors: stats.errors,
    replaced: stats.replaced
  });
}

function generateTargetPath(format: string, targetDir: string, date: Date, fileName: string): string {
  const yearFull = date.getFullYear().toString();
  const yearShort = yearFull.slice(-2);
  const month = (date.getMonth() + 1).toString().padStart(2, '0');
  const day = date.getDate().toString().padStart(2, '0');

  // Split the format string into components
  const formatParts = format.split('/');

  // Replace placeholders in each part
  const processedParts = formatParts.map(part => {
    return part
      .replace('YYYY', yearFull)
      .replace('YY', yearShort)
      .replace('MM', month)
      .replace('DD', day);
  });

  // Join the processed parts to form the directory structure
  const path = join(targetDir, ...processedParts);

  // Return the final path including the file name
  return join(path, fileName);
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
    .option('-r, --resolution <number>', 'Resolution for perceptual hashing (default: 64)', '64')
    .option('-h, --hamming <number>', 'Hamming distance threshold (default: 10)', '10')
    .option('-f, --format <string>', 'Format for target directory (default: YYYY/MM)', 'YYYY/MM')
    .parse(process.argv);

  const options = program.opts() as ProgramOptions;

  // Create necessary directories
  await mkdir(options.target, { recursive: true });
  if (options.error) await mkdir(options.error, { recursive: true });
  if (options.duplicate) await mkdir(options.duplicate, { recursive: true });

  const resolution = parseInt(options.resolution, 10);
  if (resolution <= 0) {
    throw new Error('Resolution must be a positive number');
  }

  const hammingThreshold = parseInt(options.hamming, 10);
  if (hammingThreshold < 0) {
    throw new Error('Hamming threshold must be a non-negative number');
  }

  console.log(chalk.blue('Scanning target folder for existing files...'));
  const [processedFiles, lsh] = await scanTargetFolder(options.target, resolution);
  console.log(chalk.green(`Found ${processedFiles.size} existing files in the target folder.`));

  const promises: Promise<void>[] = [];
  const semaphore = new Semaphore(parseInt(options.workers, 10));
  const mutex = new Mutex();

  let totalFiles = 0;
  // for (const dirPath of options.source) {
  //   for await (const mediaFile of getMediaFiles(dirPath)) {
  //     totalFiles++;
  //   }
  // }

  progressBar.start(totalFiles, 0, {
    duplicates: 0,
    errors: 0,
    replaced: 0
  });

  for (const dirPath of options.source) {
    for await (const mediaFile of getMediaFiles(dirPath)) {
      const [, release] = await semaphore.acquire();
      const promise = processMediaFile(mediaFile, options.target, options.error, options.duplicate, options.move, processedFiles, lsh, mutex, resolution, hammingThreshold, options.format)
        .then(() => {
          release();
        })
        .catch((error) => {
          logMessage(chalk.red(`Unexpected error processing ${mediaFile}: ${error}`));
          stats.errors++;
          release();
        });
      promises.push(promise);
    }
  }

  await Promise.all(promises);
  progressBar.stop();

  console.log(chalk.green('\nMedia organization completed'));
  console.log(chalk.cyan(`Total files processed: ${stats.processed}`));
  console.log(chalk.yellow(`Duplicates found: ${stats.duplicates}`));
  console.log(chalk.green(`Files replaced: ${stats.replaced}`));
  console.log(chalk.red(`Errors encountered: ${stats.errors}`));

  await exiftool.end();
}

main().catch((error) => {
  console.error(chalk.red('An unexpected error occurred:'), error);
  process.exit(1);
});