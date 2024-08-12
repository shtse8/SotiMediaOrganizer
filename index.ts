import { readdir, stat, mkdir, rename, copyFile, unlink, readFile, open } from 'fs/promises';
import { join, parse, basename, dirname, extname, relative } from 'path';
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


// Stage 1: File Discovery
async function discoverFiles(sourceDirs: string[], concurrency: number = 10): Promise<string[]> {
  const allFiles: string[] = [];
  let dirCount = 0;
  let fileCount = 0;
  const startTime = Date.now();
  const semaphore = new Semaphore(concurrency);

  async function scanDirectory(dirPath: string): Promise<void> {
    const [_, release] = await semaphore.acquire();
    try {
      dirCount++;
      const entries = await readdir(dirPath, { withFileTypes: true });

      const subDirPromises: Promise<void>[] = [];

      for (const entry of entries) {
        if (entry.isDirectory()) {
          subDirPromises.push(scanDirectory(join(dirPath, entry.name)));
        } else if (ALL_SUPPORTED_EXTENSIONS.includes(extname(entry.name).slice(1).toLowerCase())) {
          allFiles.push(join(dirPath, entry.name));
          fileCount++;
        }
      }

      await Promise.all(subDirPromises);

      // Periodically log progress
      if (dirCount % 100 === 0 || fileCount % 1000 === 0) {
        console.log(chalk.blue(`Processed ${dirCount} directories, found ${fileCount} files...`));
      }
    } finally {
      release();
    }
  }

  await Promise.all(sourceDirs.map(dirPath => scanDirectory(dirPath)));

  const endTime = Date.now();
  const duration = (endTime - startTime) / 1000; // Convert to seconds

  console.log(chalk.green(`\nDiscovery completed in ${duration.toFixed(2)} seconds:`));
  console.log(chalk.cyan(`- Scanned ${dirCount} directories`));
  console.log(chalk.cyan(`- Found ${fileCount} files`));

  return allFiles;
}

// Stage 2: Deduplication
async function deduplicateFiles(
  files: string[],
  resolution: number,
  hammingThreshold: number,
  existingFiles: Map<string, FileInfo>,
  lsh: ThreadSafeLSH
): Promise<{
  uniqueFiles: Map<string, FileInfo>,
  duplicates: Map<string, string>,
  similarFiles: Map<string, string>
}> {
  const uniqueFiles = new Map<string, FileInfo>();
  const duplicates = new Map<string, string>();
  const similarFiles = new Map<string, string>();
  const perceptualHashMap = new Map<string, string>();

  const progressBar = new cliProgress.SingleBar({
    format: 'Deduplicating |' + chalk.cyan('{bar}') + '| {percentage}% || {value}/{total} Files || Duplicates: {duplicates} | Similar: {similar}',
    barCompleteChar: '\u2588',
    barIncompleteChar: '\u2591',
    hideCursor: true
  });

  progressBar.start(files.length, 0, { duplicates: 0, similar: 0 });

  for (let i = 0; i < files.length; i++) {
    const filePath = files[i];
    const fileInfo = await getFileInfo(filePath, resolution);

    if (existingFiles.has(fileInfo.hash) || uniqueFiles.has(fileInfo.hash)) {
      duplicates.set(filePath, existingFiles.get(fileInfo.hash)?.path || uniqueFiles.get(fileInfo.hash)!.path);
    } else if (fileInfo.perceptualHash && isImageFile(filePath)) {
      const candidates = await lsh.getCandidates(fileInfo.perceptualHash);
      let isSimilar = false;
      for (const candidateHash of candidates) {
        const simpleHash = perceptualHashMap.get(candidateHash);
        if (simpleHash) {
          const existingFile = existingFiles.get(simpleHash) || uniqueFiles.get(simpleHash);
          if (existingFile && existingFile.perceptualHash &&
              hammingDistance(fileInfo.perceptualHash, existingFile.perceptualHash, hammingThreshold)) {
            similarFiles.set(filePath, existingFile.path);
            isSimilar = true;
            break;
          }
        }
      }
      if (!isSimilar) {
        uniqueFiles.set(fileInfo.hash, fileInfo);
        await lsh.add(fileInfo.perceptualHash, fileInfo.hash);
        perceptualHashMap.set(fileInfo.perceptualHash, fileInfo.hash);
      }
    } else {
      uniqueFiles.set(fileInfo.hash, fileInfo);
    }

    progressBar.update(i + 1, { duplicates: duplicates.size, similar: similarFiles.size });
  }

  progressBar.stop();
  console.log(chalk.green(`\nDeduplication completed:`));
  console.log(chalk.blue(`- ${uniqueFiles.size} unique files`));
  console.log(chalk.yellow(`- ${duplicates.size} exact duplicates`));
  console.log(chalk.yellow(`- ${similarFiles.size} similar files`));

  return { uniqueFiles, duplicates, similarFiles };
}

// Stage 3: File Transfer
async function transferFiles(
  uniqueFiles: Map<string, FileInfo>,
  duplicates: Map<string, string>,
  similarFiles: Map<string, string>,
  targetDir: string,
  duplicateDir: string | undefined,
  format: string,
  shouldMove: boolean
): Promise<void> {
  const totalFiles = uniqueFiles.size + duplicates.size + similarFiles.size;
  let processed = 0;

  const progressBar = new cliProgress.SingleBar({
    format: 'Transferring |' + chalk.cyan('{bar}') + '| {percentage}% || {value}/{total} Files',
    barCompleteChar: '\u2588',
    barIncompleteChar: '\u2591',
    hideCursor: true
  });

  progressBar.start(totalFiles, 0);

  for (const [, fileInfo] of uniqueFiles) {
    const date = fileInfo.metadata.DateTimeOriginal ? new Date(fileInfo.metadata.DateTimeOriginal) :
                 fileInfo.metadata.CreateDate ? new Date(fileInfo.metadata.CreateDate) :
                 new Date();
    const targetPath = generateTargetPath(format, targetDir, date, basename(fileInfo.path));
    await transferFile(fileInfo.path, targetPath, shouldMove);
    processed++;
    progressBar.update(processed);
  }

  if (duplicateDir) {
    for (const [duplicatePath] of duplicates) {
      const targetPath = join(duplicateDir, basename(duplicatePath));
      await transferFile(duplicatePath, targetPath, shouldMove);
      processed++;
      progressBar.update(processed);
    }

    for (const [similarPath] of similarFiles) {
      const targetPath = join(duplicateDir, basename(similarPath));
      await transferFile(similarPath, targetPath, shouldMove);
      processed++;
      progressBar.update(processed);
    }
  }

  progressBar.stop();
  console.log(chalk.green(`\nFile transfer completed: ${processed} files processed`));
}

// Helper functions
async function calculateFileHash(filePath: string, maxChunkSize = 1024 * 1024 * 2): Promise<string> {
  const hash = createHash('md5');
  const fileHandle = await open(filePath, 'r');

  try {
    const fileSize = (await fileHandle.stat()).size;

    if (fileSize > maxChunkSize) {
      // For large files, use partial hashing (first and last chunk)
      const chunkSize = maxChunkSize / 2;

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
    } else {
      // For small files, hash the entire file
      const fileBuffer = await fileHandle.readFile();
      hash.update(fileBuffer);
    }
  } finally {
    await fileHandle.close();
  }

  return hash.digest('hex');
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

async function convertHeicToJpeg(inputPath: string): Promise<Buffer> {
  const inputBuffer = await readFile(inputPath);
  const arrayBuffer = inputBuffer.buffer.slice(inputBuffer.byteOffset, inputBuffer.byteOffset + inputBuffer.byteLength);
  const convertedBuffer = await heicConvert({
    buffer: arrayBuffer,
    format: 'JPEG',
    quality: 1
  });
  return Buffer.from(convertedBuffer);
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
    fileInfo.perceptualHash = await calculatePerceptualHash(filePath, resolution);
    fileInfo.quality = await getImageQuality(filePath);
  }

  return fileInfo;
}

function generateTargetPath(format: string, targetDir: string, date: Date, fileName: string): string {
  const yearFull = date.getFullYear().toString();
  const yearShort = yearFull.slice(-2);
  const month = (date.getMonth() + 1).toString().padStart(2, '0');
  const day = date.getDate().toString().padStart(2, '0');

  const formatParts = format.split('/');
  const processedParts = formatParts.map(part => {
    return part
      .replace('YYYY', yearFull)
      .replace('YY', yearShort)
      .replace('MM', month)
      .replace('DD', day);
  });

  const path = join(targetDir, ...processedParts);
  return join(path, fileName);
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
    .option('-r, --resolution <number>', 'Resolution for perceptual hashing (default: 8)', '8')
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

  // Stage 1: File Discovery
  console.log(chalk.blue('Stage 1: Discovering files...'));
  const discoveredFiles = await discoverFiles(options.source);

  // Stage 2: Deduplication
  console.log(chalk.blue('\nStage 2: Deduplicating files...'));
  const lsh = new ThreadSafeLSH();
  const existingFiles = new Map<string, FileInfo>(); // In a real scenario, you might want to populate this with files from the target directory
  const { uniqueFiles, duplicates, similarFiles } = await deduplicateFiles(discoveredFiles, resolution, hammingThreshold, existingFiles, lsh);

  // Stage 3: File Transfer
  console.log(chalk.blue('\nStage 3: Transferring files...'));
  await transferFiles(uniqueFiles, duplicates, similarFiles, options.target, options.duplicate, options.format, options.move);

  console.log(chalk.green('\nMedia organization completed'));
  console.log(chalk.cyan(`Total files discovered: ${discoveredFiles.length}`));
  console.log(chalk.cyan(`Unique files: ${uniqueFiles.size}`));
  console.log(chalk.yellow(`Exact duplicates: ${duplicates.size}`));
  console.log(chalk.yellow(`Similar files: ${similarFiles.size}`));

  await exiftool.end();
}

main().catch((error) => {
  console.error(chalk.red('An unexpected error occurred:'), error);
  process.exit(1);
});