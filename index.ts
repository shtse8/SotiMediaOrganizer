import { readdir, stat, mkdir, rename, copyFile, unlink, readFile, open } from 'fs/promises';
import { join, parse, basename, dirname, extname, relative } from 'path';
import { Semaphore, Mutex } from 'async-mutex';
import { ExifTool } from 'exiftool-vendored';
import { Command } from 'commander';
import sharp from 'sharp';
import crypto, { createHash } from 'crypto';
import cliProgress from 'cli-progress';
import chalk from 'chalk';
import { Buffer } from 'buffer';
import ora from 'ora';
import { createReadStream } from 'fs';

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

const ALL_SUPPORTED_EXTENSIONS = Object.values(SUPPORTED_EXTENSIONS).flat();

interface FileInfo {
  path: string;
  size: number;
  hash: string;
  perceptualHash?: string;
  imageDate: Date;
  hasGeolocation: boolean;
  hasBasicMetadata: boolean;
  quality?: number;
}

interface DuplicateSet {
  bestFile: FileInfo;
  duplicates: Set<string>;
}

interface ProgramOptions {
  source: string[];
  target: string;
  error?: string;
  duplicate?: string;
  debug?: string;
  workers: string;
  move: boolean;
  resolution: string;
  hamming: string;
  format: string;
}

interface FormatStats {
  count: number;
  processedCount: number;
  duplicates: number;
  errors: number;
  picked: number;
  pickedWithGeo: number;
  pickedWithMetadata: number;
}

interface OverallStats {
  processedCount: number;
  pickedFiles: number;
  pickedWithGeo: number;
  pickedWithMetadata: number;
  duplicates: number;
  errors: number;
}

interface DeduplicationResult {
  uniqueFiles: Map<string, FileInfo>;
  duplicateSets: Map<string, DuplicateSet>;
  formatStats: Map<string, FormatStats>;
  stats: {
    totalFiles: number;
    pickedFiles: number;
    pickedWithGeo: number;
    pickedWithMetadata: number;
    duplicateSets: number;
    totalDuplicates: number;
  };
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


// Stage 1: File Discovery
async function discoverFiles(sourceDirs: string[], concurrency: number = 10, logInterval: number = 10000): Promise<string[]> {
  const allFiles: string[] = [];
  let dirCount = 0;
  let fileCount = 0;
  const startTime = Date.now();
  const semaphore = new Semaphore(concurrency);
  const supportedExtensions = new Set(ALL_SUPPORTED_EXTENSIONS);
  const spinner = ora('Discovering files...').start();

  async function scanDirectory(dirPath: string): Promise<void> {
    try {
      dirCount++;
      const entries = await readdir(dirPath, { withFileTypes: true });

      for (const entry of entries) {
        const entryPath = join(dirPath, entry.name);
        if (entry.isDirectory()) {
          semaphore.runExclusive(() => scanDirectory(entryPath));
        } else if (supportedExtensions.has(extname(entry.name).slice(1).toLowerCase())) {
          allFiles.push(entryPath);
          fileCount++;
        }
      }
      spinner.text = `Processed ${dirCount} directories, found ${fileCount} files...`;
    } catch (error) {
      console.error(chalk.red(`Error scanning directory ${dirPath}:`, error));
    }
  }

  // Start scanning all source directories
  sourceDirs.forEach((dirPath) => semaphore.runExclusive(() => scanDirectory(dirPath)));

  await semaphore.waitForUnlock(concurrency);

  const duration = (Date.now() - startTime) / 1000;

  spinner.succeed(`Discovery completed in ${duration.toFixed(2)} seconds: Found ${fileCount} files in ${dirCount} directories`);

  return allFiles;
}

async function deduplicateFiles(
  files: string[],
  resolution: number,
  hammingThreshold: number,
  concurrency: number = 3
): Promise<DeduplicationResult> {
  const uniqueFiles = new Map<string, FileInfo>();
  const duplicateSets = new Map<string, DuplicateSet>();
  const perceptualHashMap = new Map<string, string>();
  const formatStats = new Map<string, FormatStats>();
  const overallStats: OverallStats = {
    processedCount: 0,
    pickedFiles: 0,
    pickedWithGeo: 0,
    pickedWithMetadata: 0,
    duplicates: 0,
    errors: 0
  };

  const lsh = new LSH();

  // Count the number of files for each format
  for (const file of files) {
    const ext = extname(file).slice(1).toLowerCase();
    if (!formatStats.has(ext)) {
      formatStats.set(ext, {
        count: 1,
        processedCount: 0,
        duplicates: 0,
        errors: 0,
        picked: 0,
        pickedWithGeo: 0,
        pickedWithMetadata: 0
      });
    } else {
      formatStats.get(ext)!.count++;
    }
  }

  // Initialize MultiBar
  const multibar = new cliProgress.MultiBar({
    hideCursor: true,
    format: '{format} {bar} {percentage}% | {value}/{total} | P:{picked} G:{geo} M:{meta} D:{dup} E:{err}',
    autopadding: true,
  }, cliProgress.Presets.shades_classic);

  // Initialize individual progress bars for each format
  const formatBars: Map<string, cliProgress.SingleBar> = new Map();

  for (const [ext, stats] of formatStats.entries()) {
    formatBars.set(ext, multibar.create(stats.count, 0, { 
      format: ext.padEnd(10), 
      picked: stats.picked,
      geo: stats.pickedWithGeo,
      meta: stats.pickedWithMetadata,
      dup: stats.duplicates,
      err: stats.errors
    }));
  }

  // Initialize overall progress bar with ETA
  const totalFiles = files.length;
  const overallBar = multibar.create(totalFiles, 0, {
    format: 'Total'.padEnd(10),
    picked: 0,
    geo: 0,
    meta: 0,
    dup: 0,
    err: 0
  }, {
    format: '{format} {bar} {percentage}% | {value}/{total} | P:{picked} G:{geo} M:{meta} D:{dup} E:{err} | ETA: {eta_formatted}',
  });

  // Initialize semaphore for concurrency control
  const semaphore = new Semaphore(concurrency);
  const fileMutex = new Mutex();

  function updateFormatStats(ext: string, updates: Partial<FormatStats>) {
    const stats = formatStats.get(ext)!;
    Object.assign(stats, updates);
    formatBars.get(ext)?.update(stats.processedCount, {
      picked: stats.picked,
      geo: stats.pickedWithGeo,
      meta: stats.pickedWithMetadata,
      dup: stats.duplicates,
      err: stats.errors
    });
  }

  function updateOverallStats(updates: Partial<OverallStats>) {
    Object.assign(overallStats, updates);
    overallBar.update(overallStats.processedCount, {
      picked: overallStats.pickedFiles,
      geo: overallStats.pickedWithGeo,
      meta: overallStats.pickedWithMetadata,
      dup: overallStats.duplicates,
      err: overallStats.errors
    });
  }

  function handleDuplicate(fileInfo: FileInfo, duplicateSet: DuplicateSet): boolean {
    const oldBestFile = duplicateSet.bestFile;
    const newBestFile = selectBestFile([oldBestFile, fileInfo]);
    
    if (newBestFile === fileInfo) {
      const oldExt = extname(oldBestFile.path).slice(1).toLowerCase();
      const newExt = extname(fileInfo.path).slice(1).toLowerCase();
      
      // Decrease stats for old best file
      updateFormatStats(oldExt, {
        picked: formatStats.get(oldExt)!.picked - 1,
        pickedWithGeo: formatStats.get(oldExt)!.pickedWithGeo - (oldBestFile.hasGeolocation ? 1 : 0),
        pickedWithMetadata: formatStats.get(oldExt)!.pickedWithMetadata - (oldBestFile.hasBasicMetadata ? 1 : 0),
        duplicates: formatStats.get(oldExt)!.duplicates + 1
      });

      // Increase stats for new best file
      updateFormatStats(newExt, {
        picked: formatStats.get(newExt)!.picked + 1,
        pickedWithGeo: formatStats.get(newExt)!.pickedWithGeo + (fileInfo.hasGeolocation ? 1 : 0),
        pickedWithMetadata: formatStats.get(newExt)!.pickedWithMetadata + (fileInfo.hasBasicMetadata ? 1 : 0)
      });

      uniqueFiles.delete(oldBestFile.hash);
      duplicateSet.duplicates.add(oldBestFile.path);
      duplicateSet.bestFile = fileInfo;
      uniqueFiles.set(fileInfo.hash, fileInfo);

      if (fileInfo.perceptualHash) {
        lsh.add(fileInfo.perceptualHash, fileInfo.hash);
        perceptualHashMap.set(fileInfo.perceptualHash, fileInfo.hash);
      }

      return true;
    } else {
      duplicateSet.duplicates.add(fileInfo.path);
      return false;
    }
  }

  async function processFile(filePath: string) {
    const ext = extname(filePath).slice(1).toLowerCase();
    try {
      const fileInfo = await getFileInfo(filePath, resolution);

      await fileMutex.runExclusive(async () => {
        let isDuplicate = false;
        let bestHash = fileInfo.hash;

        // Check for exact duplicates in uniqueFiles and duplicateSets
        if (uniqueFiles.has(fileInfo.hash)) {
          isDuplicate = true;
          bestHash = fileInfo.hash;
        } else if (duplicateSets.has(fileInfo.hash)) {
          isDuplicate = true;
          bestHash = fileInfo.hash;
        } 

        // Check for perceptually similar images
        if (!isDuplicate && fileInfo.perceptualHash && isImageFile(filePath)) {
          const candidates = lsh.getCandidates(fileInfo.perceptualHash);
          for (const candidateHash of candidates) {
            const simpleHash = perceptualHashMap.get(candidateHash);
            if (simpleHash) {
              let existingFile: FileInfo | undefined;
              if (uniqueFiles.has(simpleHash)) {
                existingFile = uniqueFiles.get(simpleHash);
              } else if (duplicateSets.has(simpleHash)) {
                existingFile = duplicateSets.get(simpleHash)!.bestFile;
              }

              if (existingFile && existingFile.perceptualHash &&
                hammingDistance(fileInfo.perceptualHash, existingFile.perceptualHash) <= hammingThreshold) {
                isDuplicate = true;
                bestHash = simpleHash;
                break;
              }
            }
          }
        }

        const stats = formatStats.get(ext)!;
        if (isDuplicate) {
          let duplicateSet = duplicateSets.get(bestHash);
          if (!duplicateSet) {
            duplicateSet = {
              bestFile: uniqueFiles.get(bestHash)!,
              duplicates: new Set()
            };
            duplicateSets.set(bestHash, duplicateSet);
          }

          const isNewBest = handleDuplicate(fileInfo, duplicateSet);
          if (!isNewBest) {
            updateFormatStats(ext, {
              processedCount: stats.processedCount + 1,
              duplicates: stats.duplicates + 1
            });
          }
        } else {
          uniqueFiles.set(fileInfo.hash, fileInfo);
          updateFormatStats(ext, {
            processedCount: stats.processedCount + 1,
            picked: stats.picked + 1,
            pickedWithGeo: stats.pickedWithGeo + (fileInfo.hasGeolocation ? 1 : 0),
            pickedWithMetadata: stats.pickedWithMetadata + (fileInfo.hasBasicMetadata ? 1 : 0)
          });
          if (fileInfo.perceptualHash) {
            lsh.add(fileInfo.perceptualHash, fileInfo.hash);
            perceptualHashMap.set(fileInfo.perceptualHash, fileInfo.hash);
          }
        }
      });

      updateOverallStats({
        processedCount: overallStats.processedCount + 1,
        pickedFiles: uniqueFiles.size,
        pickedWithGeo: Array.from(uniqueFiles.values()).filter(f => f.hasGeolocation).length,
        pickedWithMetadata: Array.from(uniqueFiles.values()).filter(f => f.hasBasicMetadata).length,
        duplicates: Array.from(duplicateSets.values()).reduce((sum, set) => sum + set.duplicates.size, 0)
      });

    } catch (error) {
      const stats = formatStats.get(ext)!;
      updateFormatStats(ext, {
        processedCount: stats.processedCount + 1,
        errors: stats.errors + 1
      });
      updateOverallStats({
        processedCount: overallStats.processedCount + 1,
        errors: overallStats.errors + 1
      });
    }
  }

  // Process all files
  await Promise.all(files.map(filePath => semaphore.runExclusive(() => processFile(filePath))));

  multibar.stop();

  // Updated final console output
  console.log(chalk.green(`\nDeduplication completed:`));
  console.log(chalk.cyan(`- Total files processed: ${overallStats.processedCount}`));
  console.log(chalk.cyan(`- Picked files (unique + best from duplicates): ${overallStats.pickedFiles}`));
  console.log(chalk.cyan(`- Picked files with geolocation data: ${overallStats.pickedWithGeo}`));
  console.log(chalk.cyan(`- Picked files with basic metadata (capture date or camera model): ${overallStats.pickedWithMetadata}`));
  console.log(chalk.yellow(`- Duplicate sets: ${duplicateSets.size}`));
  console.log(chalk.yellow(`- Total duplicates: ${overallStats.duplicates}`));
  console.log(chalk.red(`- Errors encountered: ${overallStats.errors}`));

  console.log(chalk.blue('\nFormat Statistics:'));
  for (const [format, stats] of formatStats) {
    console.log(chalk.white(`${format.padEnd(10)}: ${stats.count.toString().padStart(5)} total, ${stats.picked.toString().padStart(5)} picked, ${stats.pickedWithGeo.toString().padStart(5)} w/geo, ${stats.pickedWithMetadata.toString().padStart(5)} w/metadata, ${stats.duplicates.toString().padStart(5)} duplicates, ${stats.errors.toString().padStart(5)} errors`));
  }

  return {
    uniqueFiles,
    duplicateSets,
    formatStats,
    stats: {
      totalFiles: files.length,
      pickedFiles: overallStats.pickedFiles,
      pickedWithGeo: overallStats.pickedWithGeo,
      pickedWithMetadata: overallStats.pickedWithMetadata,
      duplicateSets: duplicateSets.size,
      totalDuplicates: overallStats.duplicates
    }
  };
}

function selectBestFile(files: FileInfo[]): FileInfo {
  return files.reduce((best, current) => {
    // Prioritize files with basic metadata
    if (current.hasBasicMetadata && !best.hasBasicMetadata) return current;
    if (best.hasBasicMetadata && !current.hasBasicMetadata) return best;

    // If both have basic metadata or both don't, prioritize files with geolocation data
    if (current.hasGeolocation && !best.hasGeolocation) return current;
    if (best.hasGeolocation && !current.hasGeolocation) return best;

    // If both have the same metadata status, prefer higher quality for images
    if (current.quality && best.quality) {
      if (current.quality > best.quality) return current;
      if (best.quality > current.quality) return best;
    }

    // If quality is the same or not applicable (e.g., for non-image files),
    // choose the larger file
    return current.size > best.size ? current : best;
  });
}

// Stage 3: File Transfer
async function transferFiles(
  uniqueFiles: Map<string, FileInfo>,
  duplicateSets: Map<string, DuplicateSet>,
  targetDir: string,
  duplicateDir: string | undefined,
  debugDir: string | undefined,
  format: string,
  shouldMove: boolean
): Promise<void> {
  const multibar = new cliProgress.MultiBar({
    clearOnComplete: false,
    hideCursor: true,
    format: '{phase} ' + chalk.cyan('{bar}') + ' {percentage}% || {value}/{total} Files'
  }, cliProgress.Presets.shades_classic);


  // Debug mode: Copy all files in duplicate sets
  if (debugDir) {
    const debugCount = Array.from(duplicateSets.values()).reduce((sum, set) => sum + set.duplicates.size + 1, 0);
    const debugBar = multibar.create(debugCount, 0, { phase: 'Debug   ' });
    
    for (const [, duplicateSet] of duplicateSets) {
      const bestFile = duplicateSet.bestFile;
      const duplicateFolderName = basename(bestFile.path, extname(bestFile.path));
      const debugSetFolder = join(debugDir, duplicateFolderName);

      await transferOrCopyFile(bestFile.path, join(debugSetFolder, basename(bestFile.path)), true);
      debugBar.increment();

      for (const duplicatePath of duplicateSet.duplicates) {
        await transferOrCopyFile(duplicatePath, join(debugSetFolder, basename(duplicatePath)), true);
        debugBar.increment();
      }
    }
    
    console.log(chalk.yellow(`Debug mode: All files in duplicate sets have been copied to ${debugDir} for verification.`));
  }

  // Transfer unique files
  const uniqueBar = multibar.create(uniqueFiles.size, 0, { phase: 'Unique  ' });
  for (const [, fileInfo] of uniqueFiles) {
    const targetPath = generateTargetPath(format, targetDir, fileInfo.imageDate, basename(fileInfo.path));
    await transferOrCopyFile(fileInfo.path, targetPath, !shouldMove);
    uniqueBar.increment();
  }

  // Handle duplicate files
  if (duplicateDir) {
    const duplicateCount = Array.from(duplicateSets.values()).reduce((sum, set) => sum + set.duplicates.size, 0);
    const duplicateBar = multibar.create(duplicateCount, 0, { phase: 'Duplicate' });
    
    for (const [, duplicateSet] of duplicateSets) {
      const bestFile = duplicateSet.bestFile;
      const duplicateFolderName = basename(bestFile.path, extname(bestFile.path));
      const duplicateSetFolder = join(duplicateDir, duplicateFolderName);

      for (const duplicatePath of duplicateSet.duplicates) {
        await transferOrCopyFile(duplicatePath, join(duplicateSetFolder, basename(duplicatePath)), !shouldMove);
        duplicateBar.increment();
      }
    }
    
    console.log(chalk.yellow(`Duplicate files have been ${shouldMove ? 'moved' : 'copied'} to ${duplicateDir}`));
  } else {
    // If no duplicateDir is specified, we still need to process (move or copy) the best files from each duplicate set
    const bestFileBar = multibar.create(duplicateSets.size, 0, { phase: 'Best File' });
    for (const [, duplicateSet] of duplicateSets) {
      const bestFile = duplicateSet.bestFile;
      const targetPath = generateTargetPath(format, targetDir, bestFile.imageDate, basename(bestFile.path));
      await transferOrCopyFile(bestFile.path, targetPath, !shouldMove);
      bestFileBar.increment();
    }
  }

  multibar.stop();
  console.log(chalk.green('\nFile transfer completed'));
}


// Helper functions
async function calculateFileHash(filePath: string, maxChunkSize = 1024 * 1024): Promise<string> {
  const hash = createHash('md5');
  const fileSize = (await stat(filePath)).size;

  if (fileSize > maxChunkSize) {
    const chunkSize = maxChunkSize / 2;
    // For large files, use partial hashing (first and last chunk)
    await hashFile(filePath, hash, 0, chunkSize);
    await hashFile(filePath, hash, fileSize - chunkSize, chunkSize);
  } else {
    // For small files, hash the entire file
    await hashFile(filePath, hash);
  }

  return hash.digest('hex');
}

function hashFile(filePath: string, hash: crypto.Hash, start: number = 0, size?: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const stream = createReadStream(filePath, { start, end: size ? start + size - 1 : undefined});
    stream.on('data', (chunk: Buffer) => hash.update(chunk));
    stream.on('end', resolve);
    stream.on('error', reject);
  });
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

async function processImageFile(filePath: string, resolution: number): Promise<{
  perceptualHash: string;
  quality: number;
}> {
  const image = sharp(filePath, { failOnError: false });

  try {
    const [perceptualHashData, metadata] = await Promise.all([
      image
        .jpeg()
        .resize(resolution, resolution, { fit: 'fill' })
        .greyscale()
        .raw()
        .toBuffer({ resolveWithObject: true }),
      image.metadata()
    ]);

    // Calculate perceptual hash
    let hash = '';
    const pixelCount = resolution * resolution;
    const totalBrightness = perceptualHashData.data.reduce((sum: number, pixel: number) => sum + pixel, 0);
    const averageBrightness = totalBrightness / pixelCount;

    for (let i = 0; i < pixelCount; i++) {
      hash += perceptualHashData.data[i] < averageBrightness ? '0' : '1';
    }

    // Calculate image quality
    const quality = (metadata.width || 0) * (metadata.height || 0);

    return { perceptualHash: hash, quality };
  } finally {
    image.destroy();
  }
}

async function getFileInfo(filePath: string, resolution: number): Promise<FileInfo> {
  const [fileStat, hash, metadata, imageInfo] = await Promise.all([
    stat(filePath),
    calculateFileHash(filePath),
    getMetadata(filePath),
    isImageFile(filePath) 
      ? processImageFile(filePath, resolution).catch(error => {
          // console.warn(`Could not process image file ${filePath}: ${error}`);
          return { perceptualHash: undefined, quality: undefined };
        })
      : Promise.resolve({ perceptualHash: undefined, quality: undefined })
  ]);

  const hasBasicMetadata = !!(metadata.DateTimeOriginal || metadata.CreateDate || metadata.Model);

  const fileInfo: FileInfo = {
    path: filePath,
    size: fileStat.size,
    hash,
    imageDate: metadata.DateTimeOriginal ? new Date(metadata.DateTimeOriginal) :
      metadata.CreateDate ? new Date(metadata.CreateDate) :
      new Date(),
    hasGeolocation: !!(metadata.GPSLatitude && metadata.GPSLongitude),
    hasBasicMetadata,
    perceptualHash: imageInfo.perceptualHash,
    quality: imageInfo.quality
  };

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

async function transferOrCopyFile(sourcePath: string, targetPath: string, isCopy: boolean): Promise<void> {
  await mkdir(dirname(targetPath), { recursive: true });
  if (isCopy) {
    await copyFile(sourcePath, targetPath);
  } else {
    try {
      await rename(sourcePath, targetPath);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'EXDEV') {
        // Cross-device move, fallback to copy-then-delete
        await copyFile(sourcePath, targetPath);
        await unlink(sourcePath);
      } else {
        throw error;
      }
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
    .option('--debug <path>', 'Debug directory for storing all files in duplicate sets')
    .option('-w, --workers <number>', 'Number of concurrent workers', '5')
    .option('-m, --move', 'Move files instead of copying them', false)
    .option('-r, --resolution <number>', 'Resolution for perceptual hashing (default: 64)', '64')
    .option('-h, --hamming <number>', 'Hamming distance threshold (default: 10)', '10')
    .option('-f, --format <string>', 'Format for target directory (default: YYYY/MM)', 'YYYY/MM')
    .parse(process.argv);

  const options = program.opts() as ProgramOptions;

  // Create necessary directories
  await Promise.all([
    mkdir(options.target, { recursive: true }),
    options.error ? mkdir(options.error, { recursive: true }) : Promise.resolve(),
    options.duplicate ? mkdir(options.duplicate, { recursive: true }) : Promise.resolve(),
    options.debug ? mkdir(options.debug, { recursive: true }) : Promise.resolve()
  ]);

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
  const { uniqueFiles, duplicateSets } = await deduplicateFiles(discoveredFiles, resolution, hammingThreshold);

  // Stage 3: File Transfer
  console.log(chalk.blue('\nStage 3: Transferring files...'));
  await transferFiles(uniqueFiles, duplicateSets, options.target, options.duplicate, options.debug, options.format, options.move);

  console.log(chalk.green('\nMedia organization completed'));
  console.log(chalk.cyan(`Total files discovered: ${discoveredFiles.length}`));
  console.log(chalk.cyan(`Unique files: ${uniqueFiles.size}`));
  console.log(chalk.yellow(`Duplicate sets: ${duplicateSets.size}`));
  console.log(chalk.yellow(`Total duplicates: ${Array.from(duplicateSets.values()).reduce((sum, set) => sum + set.duplicates.size, 0)}`));

  if (options.debug) {
    console.log(chalk.yellow('Debug mode: All files in duplicate sets have been copied to the debug directory for verification.'));
  }

  await exiftool.end();
}

main().catch((error) => {
  console.error(chalk.red('An unexpected error occurred:'), error);
  process.exit(1);
});