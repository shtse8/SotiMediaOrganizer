import ffmpeg from 'fluent-ffmpeg';
import { readdir, stat, mkdir, rename, copyFile, unlink, readFile, open } from 'fs/promises';
import { join, parse, basename, dirname, extname, relative } from 'path';
import { Semaphore, Mutex } from 'async-mutex';
import { ExifDate, ExifDateTime, ExifTool, type Tags } from 'exiftool-vendored';
import { Command } from 'commander';
import sharp from 'sharp';
import crypto, { createHash } from 'crypto';
import cliProgress from 'cli-progress';
import chalk from 'chalk';
import { Buffer } from 'buffer';
import ora from 'ora';
import { createReadStream } from 'fs';
import os from 'os';
import { existsSync } from 'fs';


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
  imageDate?: Date;
  fileDate: Date;
  quality?: number;
  geoLocation?: string; 
  cameraModel?: string;
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
  frameCount: string;
  hamming: string;
  format: string;
}

interface Stats {
  totalCount: number;
  processedCount: number;
  pickedCount: number;
  withGeoCount: number;
  withImageDateCount: number;
  withCameraCount: number;
  duplicateCount: number;
  errorCount: number;
}

interface DeduplicationResult {
  uniqueFiles: Map<string, FileInfo>;
  duplicateSets: Map<string, DuplicateSet>;
  formatStats: Map<string, Stats>;
  overallStats: Stats;
  errorFiles: string[];
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
          const [_, release] = await semaphore.acquire();
          scanDirectory(entryPath).finally(() => release());
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
  for (const dirPath of sourceDirs) {
    const [_, release] = await semaphore.acquire();
    await scanDirectory(dirPath).finally(() => release());
  }

  await semaphore.waitForUnlock(concurrency);

  const duration = (Date.now() - startTime) / 1000;

  spinner.succeed(`Discovery completed in ${duration.toFixed(2)} seconds: Found ${fileCount} files in ${dirCount} directories`);

  return allFiles;
}

async function deduplicateFiles(
  files: string[],
  resolution: number,
  frameCount: number,
  hammingThreshold: number,
  concurrency: number = 3
): Promise<DeduplicationResult> {
  const uniqueFiles = new Map<string, FileInfo>();
  const duplicateSets = new Map<string, DuplicateSet>();
  const perceptualHashMap = new Map<string, string>();
  const formatStats = new Map<string, Stats>();
  const errorFiles: string[] = [];
  const overallStats: Stats = {
    totalCount: files.length,
    processedCount: 0,
    pickedCount: 0,
    withGeoCount: 0,
    withImageDateCount: 0,
    withCameraCount: 0,
    duplicateCount: 0,
    errorCount: 0
  };

  const lsh = new LSH();

  // Count the number of files for each format
  for (const file of files) {
    const ext = extname(file).slice(1).toLowerCase();
    if (!formatStats.has(ext)) {
      formatStats.set(ext, {
        totalCount: 1,
        processedCount: 0,
        pickedCount: 0,
        withGeoCount: 0,
        withImageDateCount: 0,
        withCameraCount: 0,
        duplicateCount: 0,
        errorCount: 0
      });
    } else {
      formatStats.get(ext)!.totalCount++;
    }
  }

  // Initialize MultiBar
  const multibar = new cliProgress.MultiBar({
    hideCursor: true,
    format: '{format} {bar} {percentage}% | {value}/{total} | P:{picked} G:{geo} D:{dated} C:{camera} Dup:{dup} E:{err}',
    autopadding: true,
  }, cliProgress.Presets.shades_classic);

  // Initialize individual progress bars for each format
  const formatBars: Map<string, cliProgress.SingleBar> = new Map();

  for (const [ext, stats] of formatStats.entries()) {
    formatBars.set(ext, multibar.create(stats.totalCount, 0, { 
      format: ext.padEnd(10), 
      picked: stats.pickedCount,
      geo: stats.withGeoCount,
      dated: stats.withImageDateCount,
      camera: stats.withCameraCount,
      dup: stats.duplicateCount,
      err: stats.errorCount
    }));
  }

  // Initialize overall progress bar with ETA
  const overallBar = multibar.create(overallStats.totalCount, 0, {
    format: 'Total'.padEnd(10),
    picked: 0,
    geo: 0,
    dated: 0,
    camera: 0,
    dup: 0,
    err: 0
  }, {
    format: '{format} {bar} {percentage}% | {value}/{total} | P:{picked} G:{geo} D:{dated} C:{camera} Dup:{dup} E:{err} | ETA: {eta_formatted}',
  });

  // Initialize semaphore for concurrency control
  const semaphore = new Semaphore(concurrency);
  const fileMutex = new Mutex();

  function updateStats(stats: Stats, updates: Partial<Stats>) {
    Object.assign(stats, updates);
    return stats;
  }

  function updateFormatStats(ext: string, updates: Partial<Stats>) {
    const stats = updateStats(formatStats.get(ext)!, updates);
    formatBars.get(ext)?.update(stats.processedCount, {
      picked: stats.pickedCount,
      geo: stats.withGeoCount,
      dated: stats.withImageDateCount,
      camera: stats.withCameraCount,
      dup: stats.duplicateCount,
      err: stats.errorCount
    });
  }

  function updateOverallStats(updates: Partial<Stats>) {
    updateStats(overallStats, updates);
    overallBar.update(overallStats.processedCount, {
      picked: overallStats.pickedCount,
      geo: overallStats.withGeoCount,
      dated: overallStats.withImageDateCount,
      camera: overallStats.withCameraCount,
      dup: overallStats.duplicateCount,
      err: overallStats.errorCount
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
        pickedCount: formatStats.get(oldExt)!.pickedCount - 1,
        withGeoCount: formatStats.get(oldExt)!.withGeoCount - (oldBestFile.geoLocation ? 1 : 0),
        withImageDateCount: formatStats.get(oldExt)!.withImageDateCount - (oldBestFile.imageDate ? 1 : 0),
        withCameraCount: formatStats.get(oldExt)!.withCameraCount - (oldBestFile.cameraModel ? 1 : 0),
        duplicateCount: formatStats.get(oldExt)!.duplicateCount + 1
      });

      // Increase stats for new best file
      updateFormatStats(newExt, {
        pickedCount: formatStats.get(newExt)!.pickedCount + 1,
        withGeoCount: formatStats.get(newExt)!.withGeoCount + (fileInfo.geoLocation ? 1 : 0),
        withImageDateCount: formatStats.get(newExt)!.withImageDateCount + (fileInfo.imageDate ? 1 : 0),
        withCameraCount: formatStats.get(newExt)!.withCameraCount + (fileInfo.cameraModel ? 1 : 0)
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
      const fileInfo = await getFileInfo(filePath, resolution, frameCount);

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
              processedCount: formatStats.get(ext)!.processedCount + 1,
              duplicateCount: formatStats.get(ext)!.duplicateCount + 1
            });
          }
        } else {
          uniqueFiles.set(fileInfo.hash, fileInfo);
          updateFormatStats(ext, {
            processedCount: formatStats.get(ext)!.processedCount + 1,
            pickedCount: formatStats.get(ext)!.pickedCount + 1,
            withGeoCount: formatStats.get(ext)!.withGeoCount + (fileInfo.geoLocation ? 1 : 0),
            withImageDateCount: formatStats.get(ext)!.withImageDateCount + (fileInfo.imageDate ? 1 : 0),
            withCameraCount: formatStats.get(ext)!.withCameraCount + (fileInfo.cameraModel ? 1 : 0)
          });
          if (fileInfo.perceptualHash) {
            lsh.add(fileInfo.perceptualHash, fileInfo.hash);
            perceptualHashMap.set(fileInfo.perceptualHash, fileInfo.hash);
          }
        }
      });

      updateOverallStats({
        processedCount: overallStats.processedCount + 1,
        pickedCount: uniqueFiles.size,
        withGeoCount: Array.from(uniqueFiles.values()).filter(f => f.geoLocation).length,
        withImageDateCount: Array.from(uniqueFiles.values()).filter(f => f.imageDate).length,
        withCameraCount: Array.from(uniqueFiles.values()).filter(f => f.cameraModel).length,
        duplicateCount: Array.from(duplicateSets.values()).reduce((sum, set) => sum + set.duplicates.size, 0)
      });

    } catch (error) {
      errorFiles.push(filePath);
      updateFormatStats(ext, {
        processedCount: formatStats.get(ext)!.processedCount + 1,
        errorCount: formatStats.get(ext)!.errorCount + 1
      });
      updateOverallStats({
        processedCount: overallStats.processedCount + 1,
        errorCount: overallStats.errorCount + 1
      });
    }
  }

  // Process all files
  for (const file of files) {
    const [_, release] = await semaphore.acquire();
    processFile(file).finally(() => release());
  }

  await semaphore.waitForUnlock(concurrency);

  multibar.stop();

  // Updated final console output
  console.log(chalk.green(`\nDeduplication completed:`));
  console.log(chalk.cyan(`- Total files processed: ${overallStats.processedCount}`));
  console.log(chalk.cyan(`- Picked files (unique + best from duplicates): ${overallStats.pickedCount}`));
  console.log(chalk.cyan(`- Files with geolocation data: ${overallStats.withGeoCount}`));
  console.log(chalk.cyan(`- Files with image date: ${overallStats.withImageDateCount}`));
  console.log(chalk.cyan(`- Files with camera information: ${overallStats.withCameraCount}`));
  console.log(chalk.yellow(`- Duplicate sets: ${duplicateSets.size}`));
  console.log(chalk.yellow(`- Total duplicates: ${overallStats.duplicateCount}`));
  console.log(chalk.red(`- Errors encountered: ${overallStats.errorCount}`));

  console.log(chalk.blue('\nFormat Statistics:'));
  for (const [format, stats] of formatStats) {
    console.log(chalk.white(`${format.padEnd(10)}: ${stats.totalCount.toString().padStart(5)} total, ${stats.pickedCount.toString().padStart(5)} picked, ${stats.withGeoCount.toString().padStart(5)} w/geo, ${stats.withImageDateCount.toString().padStart(5)} w/date, ${stats.withCameraCount.toString().padStart(5)} w/camera, ${stats.duplicateCount.toString().padStart(5)} duplicates, ${stats.errorCount.toString().padStart(5)} errors`));
  }

  return {
    uniqueFiles,
    duplicateSets,
    formatStats,
    overallStats,
    errorFiles
  };
}

function selectBestFile(files: FileInfo[]): FileInfo {
  return files.reduce((best, current) => {
    // Prioritize files with image date
    if (current.imageDate && !best.imageDate) return current;
    if (best.imageDate && !current.imageDate) return best;

    // If both have image date or both don't, prioritize files with geolocation data
    if (current.geoLocation && !best.geoLocation) return current;
    if (best.geoLocation && !current.geoLocation) return best;

    // If geolocation is the same, prioritize files with camera information
    if (current.cameraModel && !best.cameraModel) return current;
    if (best.cameraModel && !current.cameraModel) return best;

    // If all metadata is the same, prefer higher quality for images
    if (current.quality !== undefined && best.quality !== undefined) {
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
  errorFiles: string[],
  targetDir: string,
  duplicateDir: string | undefined,
  errorDir: string | undefined,
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
    const targetPath = generateTargetPath(format, targetDir, fileInfo);
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
      const targetPath = generateTargetPath(format, targetDir, bestFile);
      await transferOrCopyFile(bestFile.path, targetPath, !shouldMove);
      bestFileBar.increment();
    }
  }

  // Handle error files
  if (errorDir && errorFiles.length > 0) {
    const errorBar = multibar.create(errorFiles.length, 0, { phase: 'Error   ' });
    for (const errorFilePath of errorFiles) {
      const targetPath = join(errorDir, basename(errorFilePath));
      await transferOrCopyFile(errorFilePath, targetPath, !shouldMove);
      errorBar.increment();
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

function isVideoFile(filePath: string): boolean {
  const ext = extname(filePath).slice(1).toLowerCase();
  return SUPPORTED_EXTENSIONS.videos.includes(ext);
}

function hammingDistance(str1: string, str2: string): number {
  if (str1.length !== str2.length) {
    throw new Error('Strings must be of equal length');
  }
  return str1.split('').reduce((count, char, i) => count + (char !== str2[i] ? 1 : 0), 0);
}

// Create a single instance of ExifTool with optimized options
const exiftool = new ExifTool({ 
  useMWG: true,
  maxProcs: os.cpus().length, // Use all available CPU cores
  maxTasksPerProcess: 1000, // Increased from default 500
  taskTimeoutMillis: 5000,
  minDelayBetweenSpawnMillis: 0, // No delay between spawning processes
  streamFlushMillis: 100, // Reduced from default; adjust if you see noTaskData events
});


function getMetadata(path: string): Promise<Tags> {
  const tagsToExtract = [
    'DateTimeOriginal',
    'CreateDate',
    'DateCreated',
    'DigitalCreationDate',
    'Model',
    'GPSLatitude',
    'GPSLongitude',
    'Resolution'
  ];
 return  exiftool.read<Tags>(path, ['-fast', '-n', ...tagsToExtract.map(tag => `-${tag}`)]);
}

async function getImagePerceptualHash(filePath: string, resolution: number): Promise<string> {
  const image = sharp(filePath, { failOnError: false });

  try {
    const perceptualHashData = await image
        .jpeg()
        .resize(resolution, resolution, { fit: 'fill' })
        .greyscale()
        .raw()
        .toBuffer({ resolveWithObject: true });

    // Calculate perceptual hash
    return getPerceptualHash(perceptualHashData.data, resolution);
  } finally {
    image.destroy();
  }
}

async function getVideoPerceptualHash(filePath: string, numFrames: number = 10, resolution: number = 8): Promise<string> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) {
        return reject(err);
      }

      const duration = metadata.format.duration;
      if (!duration) {
        return reject(new Error('Could not determine video duration.'));
      }

      // Calculate the interval for frame selection
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
  if (value instanceof ExifDateTime) {
    return value.toDate();
  } else if (value instanceof ExifDate) {
    return value.toDate();
  }
  return undefined;
}

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
    imageDate:imageDate,
    fileDate: fileStat.mtime,  // Added
    perceptualHash: perceptualHash,
    quality: (metadata.ImageHeight ?? 0) * (metadata.ImageWidth ?? 0),
    geoLocation: metadata.GPSLatitude && metadata.GPSLongitude ? `${metadata.GPSLatitude},${metadata.GPSLongitude}` : undefined,
    cameraModel: metadata.Model
  };

  return fileInfo;
}

function formatDate(date: Date | undefined, format: string): string {
  if (!date || isNaN(date.getTime())) {
    return '';
  }
  
  const pad = (num: number) => num.toString().padStart(2, '0');
  
  const formatters: { [key: string]: () => string } = {
    'YYYY': () => date.getFullYear().toString(),
    'YY': () => date.getFullYear().toString().slice(-2),
    'MMMM': () => date.toLocaleString('default', { month: 'long' }),
    'MMM': () => date.toLocaleString('default', { month: 'short' }),
    'MM': () => pad(date.getMonth() + 1),
    'M': () => (date.getMonth() + 1).toString(),
    'DD': () => pad(date.getDate()),
    'D': () => date.getDate().toString(),
    'DDDD': () => date.toLocaleString('default', { weekday: 'long' }),
    'DDD': () => date.toLocaleString('default', { weekday: 'short' }),
    'HH': () => pad(date.getHours()),
    'H': () => date.getHours().toString(),
    'hh': () => pad(date.getHours() % 12 || 12),
    'h': () => (date.getHours() % 12 || 12).toString(),
    'mm': () => pad(date.getMinutes()),
    'm': () => date.getMinutes().toString(),
    'ss': () => pad(date.getSeconds()),
    's': () => date.getSeconds().toString(),
    'a': () => date.getHours() < 12 ? 'am' : 'pm',
    'A': () => date.getHours() < 12 ? 'AM' : 'PM',
    'WW': () => pad(getWeekNumber(date)),
  };

  return format.replace(/(\w+)/g, (match) => {
    const formatter = formatters[match];
    return formatter ? formatter() : match;
  });
}

function getWeekNumber(date: Date): number {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(),0,1));
  return Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1)/7);
}

function generateTargetPath(format: string, targetDir: string, fileInfo: FileInfo): string {
  const mixedDate = fileInfo.imageDate || fileInfo.fileDate;
  const { name, ext } = parse(fileInfo.path);
  
  function generateRandomId(): string {
    return crypto.randomBytes(4).toString('hex');
  }
  
  const data: { [key: string]: string } = {
    'I.YYYY': formatDate(fileInfo.imageDate, 'YYYY'),
    'I.YY': formatDate(fileInfo.imageDate, 'YY'),
    'I.MMMM': formatDate(fileInfo.imageDate, 'MMMM'),
    'I.MMM': formatDate(fileInfo.imageDate, 'MMM'),
    'I.MM': formatDate(fileInfo.imageDate, 'MM'),
    'I.M': formatDate(fileInfo.imageDate, 'M'),
    'I.DD': formatDate(fileInfo.imageDate, 'DD'),
    'I.D': formatDate(fileInfo.imageDate, 'D'),
    'I.DDDD': formatDate(fileInfo.imageDate, 'DDDD'),
    'I.DDD': formatDate(fileInfo.imageDate, 'DDD'),
    'I.HH': formatDate(fileInfo.imageDate, 'HH'),
    'I.H': formatDate(fileInfo.imageDate, 'H'),
    'I.hh': formatDate(fileInfo.imageDate, 'hh'),
    'I.h': formatDate(fileInfo.imageDate, 'h'),
    'I.mm': formatDate(fileInfo.imageDate, 'mm'),
    'I.m': formatDate(fileInfo.imageDate, 'm'),
    'I.ss': formatDate(fileInfo.imageDate, 'ss'),
    'I.s': formatDate(fileInfo.imageDate, 's'),
    'I.a': formatDate(fileInfo.imageDate, 'a'),
    'I.A': formatDate(fileInfo.imageDate, 'A'),
    'I.WW': formatDate(fileInfo.imageDate, 'WW'),
    
    'F.YYYY': formatDate(fileInfo.fileDate, 'YYYY'),
    'F.YY': formatDate(fileInfo.fileDate, 'YY'),
    'F.MMMM': formatDate(fileInfo.fileDate, 'MMMM'),
    'F.MMM': formatDate(fileInfo.fileDate, 'MMM'),
    'F.MM': formatDate(fileInfo.fileDate, 'MM'),
    'F.M': formatDate(fileInfo.fileDate, 'M'),
    'F.DD': formatDate(fileInfo.fileDate, 'DD'),
    'F.D': formatDate(fileInfo.fileDate, 'D'),
    'F.DDDD': formatDate(fileInfo.fileDate, 'DDDD'),
    'F.DDD': formatDate(fileInfo.fileDate, 'DDD'),
    'F.HH': formatDate(fileInfo.fileDate, 'HH'),
    'F.H': formatDate(fileInfo.fileDate, 'H'),
    'F.hh': formatDate(fileInfo.fileDate, 'hh'),
    'F.h': formatDate(fileInfo.fileDate, 'h'),
    'F.mm': formatDate(fileInfo.fileDate, 'mm'),
    'F.m': formatDate(fileInfo.fileDate, 'm'),
    'F.ss': formatDate(fileInfo.fileDate, 'ss'),
    'F.s': formatDate(fileInfo.fileDate, 's'),
    'F.a': formatDate(fileInfo.fileDate, 'a'),
    'F.A': formatDate(fileInfo.fileDate, 'A'),
    'F.WW': formatDate(fileInfo.fileDate, 'WW'),
    
    'D.YYYY': formatDate(mixedDate, 'YYYY'),
    'D.YY': formatDate(mixedDate, 'YY'),
    'D.MMMM': formatDate(mixedDate, 'MMMM'),
    'D.MMM': formatDate(mixedDate, 'MMM'),
    'D.MM': formatDate(mixedDate, 'MM'),
    'D.M': formatDate(mixedDate, 'M'),
    'D.DD': formatDate(mixedDate, 'DD'),
    'D.D': formatDate(mixedDate, 'D'),
    'D.DDDD': formatDate(mixedDate, 'DDDD'),
    'D.DDD': formatDate(mixedDate, 'DDD'),
    'D.HH': formatDate(mixedDate, 'HH'),
    'D.H': formatDate(mixedDate, 'H'),
    'D.hh': formatDate(mixedDate, 'hh'),
    'D.h': formatDate(mixedDate, 'h'),
    'D.mm': formatDate(mixedDate, 'mm'),
    'D.m': formatDate(mixedDate, 'm'),
    'D.ss': formatDate(mixedDate, 'ss'),
    'D.s': formatDate(mixedDate, 's'),
    'D.a': formatDate(mixedDate, 'a'),
    'D.A': formatDate(mixedDate, 'A'),
    'D.WW': formatDate(mixedDate, 'WW'),
    
    'NAME': name,
    'NAME.L': name.toLowerCase(),
    'NAME.U': name.toUpperCase(),
    'EXT': ext.slice(1).toLowerCase(),
    'RND': generateRandomId(),
    'GEO': fileInfo.geoLocation || '',
    'CAM': fileInfo.cameraModel || '',
    'TYPE': fileInfo.quality !== undefined ? 'Image' : 'Other',
    'HAS.GEO': fileInfo.geoLocation ? 'GeoTagged' : 'NoGeo',
    'HAS.CAM': fileInfo.cameraModel ? 'WithCamera' : 'NoCamera',
    'HAS.DATE': fileInfo.imageDate && !isNaN(fileInfo.imageDate.getTime()) ? 'Dated' : 'NoDate',
  };

  let formattedPath = format.replace(/\{([^{}]+)\}/g, (match, key) => {
    return data[key] || '';
  });

  // Remove any empty path segments
  formattedPath = formattedPath.split('/').filter(Boolean).join('/');

  // If the path is empty after removing empty segments, use 'NoDate'
  if (!formattedPath) {
    formattedPath = 'NoDate';
  }

  // Split the path into directory and filename
  const parts = formattedPath.split('/');
  const lastPart = parts[parts.length - 1];
  let directory, filename;

  if (lastPart.includes('.') && lastPart.split('.').pop() === data['EXT']) {
    // If the last part contains a dot and ends with the correct extension, it's a filename
    directory = parts.slice(0, -1).join('/');
    filename = lastPart;
  } else {
    // Otherwise, treat the whole path as a directory
    directory = formattedPath;
    filename = `${name}${ext}`; // Use the original filename
  }

  let fullPath = join(targetDir, directory, filename);

  // Handle file name conflicts
  while (existsSync(fullPath)) {
    const { name: conflictName, ext: conflictExt } = parse(fullPath);
    fullPath = join(dirname(fullPath), `${conflictName}_${generateRandomId()}${conflictExt}`);
  }

  return fullPath;
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
    .description('Organize photos and videos based on their metadata')
    .version('1.0.0')
    .requiredOption('-s, --source <paths...>', 'Source directories to process')
    .requiredOption('-t, --target <path>', 'Target directory for organized media')
    .option('-e, --error <path>', 'Directory for files that couldn\'t be processed')
    .option('-d, --duplicate <path>', 'Directory for duplicate files')
    .option('--debug <path>', 'Debug directory for storing all files in duplicate sets')
    .option('-w, --workers <number>', 'Number of concurrent workers', '5')
    .option('-m, --move', 'Move files instead of copying them', false)
    .option('-r, --resolution <number>', 'Resolution for perceptual hashing (default: 64)', '64')
    .option('--frame-count <number>', 'Number of frames to extract from videos for perceptual hashing (default: 5)', '5')
    .option('-h, --hamming <number>', 'Hamming distance threshold (default: 10)', '10')
    .option('-f, --format <string>', 'Format for target directory (default: {D.YYYY}/{D.MM}/{D.DD}/{NAME}.{EXT})', '{D.YYYY}/{D.MM}/{D.DD}/{NAME}.{EXT}')
    .addHelpText('after', `
Format string placeholders:
  Image date (I.), File date (F.), Mixed date (D.):
    {*.YYYY} - Year (4 digits)       {*.YY} - Year (2 digits)
    {*.MMMM} - Month (full name)     {*.MMM} - Month (short name)
    {*.MM} - Month (2 digits)        {*.M} - Month (1-2 digits)
    {*.DD} - Day (2 digits)          {*.D} - Day (1-2 digits)
    {*.DDDD} - Day (full name)       {*.DDD} - Day (short name)
    {*.HH} - Hour, 24h (2 digits)    {*.H} - Hour, 24h (1-2 digits)
    {*.hh} - Hour, 12h (2 digits)    {*.h} - Hour, 12h (1-2 digits)
    {*.mm} - Minute (2 digits)       {*.m} - Minute (1-2 digits)
    {*.ss} - Second (2 digits)       {*.s} - Second (1-2 digits)
    {*.a} - am/pm                    {*.A} - AM/PM
    {*.WW} - Week of year (2 digits)

  Filename:
    {NAME} - Original filename (without extension)
    {NAME.L} - Lowercase filename
    {NAME.U} - Uppercase filename
    {EXT} - File extension (without dot)
    {RND} - Random 8-character hexadecimal string (for unique filenames)

  Other:
    {GEO} - Geolocation              {CAM} - Camera model
    {TYPE} - 'Image' or 'Other'
    {HAS.GEO} - 'GeoTagged' or 'NoGeo'
    {HAS.CAM} - 'WithCamera' or 'NoCamera'
    {HAS.DATE} - 'Dated' or 'NoDate'

Example format strings:
  "{D.YYYY}/{D.MM}/{D.DD}/{NAME}.{EXT}"
  "{HAS.GEO}/{HAS.CAM}/{D.YYYY}/{D.MM}/{NAME}_{D.HH}{D.mm}.{EXT}"
  "{TYPE}/{D.YYYY}/{D.WW}/{CAM}/{D.YYYY}{D.MM}{D.DD}_{NAME.L}.{EXT}"
  "{HAS.DATE}/{D.YYYY}/{D.MMMM}/{D.D}-{D.DDDD}/{D.h}{D.mm}{D.a}_{NAME}.{EXT}"
  "{TYPE}/{CAM}/{D.YYYY}/{D.MM}/{D.DD}_{D.HH}{D.mm}_{NAME.U}.{EXT}"
    `)
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

  const frameCount = parseInt(options.frameCount, 10);
  if (frameCount <= 0) {
    throw new Error('Frame count must be a positive number');
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
  const { uniqueFiles, duplicateSets, errorFiles } = await deduplicateFiles(discoveredFiles, resolution, frameCount, hammingThreshold);

  // Stage 3: File Transfer
  console.log(chalk.blue('\nStage 3: Transferring files...'));
  await transferFiles(
    uniqueFiles, 
    duplicateSets, 
    errorFiles, 
    options.target, 
    options.duplicate, 
    options.error, 
    options.debug, 
    options.format, 
    options.move
  );

  console.log(chalk.green('\nMedia organization completed'));
  console.log(chalk.cyan(`Total files discovered: ${discoveredFiles.length}`));
  console.log(chalk.cyan(`Unique files: ${uniqueFiles.size}`));
  console.log(chalk.yellow(`Duplicate sets: ${duplicateSets.size}`));
  console.log(chalk.yellow(`Total duplicates: ${Array.from(duplicateSets.values()).reduce((sum, set) => sum + set.duplicates.size, 0)}`));
  console.log(chalk.red(`Files with errors: ${errorFiles.length}`));

  if (options.debug) {
    console.log(chalk.yellow('Debug mode: All files in duplicate sets have been copied to the debug directory for verification.'));
  }

  await exiftool.end();
}

main().catch((error) => {
  console.error(chalk.red('An unexpected error occurred:'), error);
  process.exit(1);
});