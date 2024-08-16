import { ExifDate, ExifDateTime, ExifTool, type Tags } from "exiftool-vendored";
import type {
  FileInfo,
  DuplicateSet,
  DeduplicationResult,
  Stats,
  GatherFileInfoResult,
} from "./types";
import { VPTree } from "./VPTree";
import { mkdir, copyFile, rename, unlink } from "fs/promises";
import { join, basename, dirname, extname, parse } from "path";
import { existsSync } from "fs";
import crypto from "crypto";
import chalk from "chalk";
import { MultiBar, Presets } from "cli-progress";
import { Semaphore } from "async-mutex";
import cliProgress from "cli-progress";
import { readdir } from "fs/promises";
import { stat } from "fs/promises";
import { createHash, type Hash } from "crypto";
import { createReadStream } from "fs";
import sharp from "sharp";
import ffmpeg from "fluent-ffmpeg";
import path from "path";
import { Spinner } from "@topcli/spinner";
import { open, RootDatabase } from "lmdb";

enum FileType {
  Image,
  Video,
}
export class MediaOrganizer {
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
      "gif",
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
    ]),
  };

  static readonly ALL_SUPPORTED_EXTENSIONS = new Set([
    ...MediaOrganizer.SUPPORTED_EXTENSIONS[FileType.Image],
    ...MediaOrganizer.SUPPORTED_EXTENSIONS[FileType.Video],
  ]);

  private exiftool: ExifTool = new ExifTool();
  private db: RootDatabase;

  constructor(dbPath: string = ".mediadb") {
    this.db = open({
      path: dbPath,
      compression: true,
    });
  }

  async discoverFiles(
    sourceDirs: string[],
    concurrency: number = 10,
  ): Promise<string[]> {
    const allFiles: string[] = [];
    let dirCount = 0;
    let fileCount = 0;
    const startTime = Date.now();
    const semaphore = new Semaphore(concurrency);
    const spinner = new Spinner().start("Discovering files...");

    async function scanDirectory(dirPath: string): Promise<void> {
      try {
        dirCount++;
        const entries = await readdir(dirPath, { withFileTypes: true });

        for (const entry of entries) {
          const entryPath = path.join(dirPath, entry.name);
          if (entry.isDirectory()) {
            semaphore.runExclusive(() => scanDirectory(entryPath));
          } else if (
            MediaOrganizer.ALL_SUPPORTED_EXTENSIONS.has(
              path.extname(entry.name).slice(1).toLowerCase(),
            )
          ) {
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
      semaphore.runExclusive(() => scanDirectory(dirPath));
    }

    await semaphore.waitForUnlock(concurrency);

    const duration = (Date.now() - startTime) / 1000;

    spinner.succeed(
      `Discovery completed in ${duration.toFixed(2)} seconds: Found ${fileCount} files in ${dirCount} directories`,
    );

    // print file format statistics
    const formatStats = new Map<string, number>();
    for (const file of allFiles) {
      const ext = path.extname(file).slice(1).toLowerCase();
      formatStats.set(ext, (formatStats.get(ext) ?? 0) + 1);
    }

    console.log(chalk.blue("\nFile Format Statistics:"));
    for (const [format, count] of formatStats.entries()) {
      console.log(
        chalk.white(`${format.padEnd(6)}: ${count.toString().padStart(8)}`),
      );
    }
    console.log(
      chalk.green(`${"Total".padEnd(6)}: ${fileCount.toString().padStart(8)}`),
    );

    return allFiles;
  }

  private formatTime(seconds: number): string {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const remainingSeconds = Math.floor(seconds % 60);

    return `${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}:${remainingSeconds.toString().padStart(2, "0")}`;
  }

  private getBrailleProgressChar(progress: number): string {
    if (progress >= 0.875) return "⣿"; // Fully filled (8 dots)
    if (progress >= 0.75) return "⣷"; // 7 dots
    if (progress >= 0.625) return "⣧"; // 6 dots
    if (progress >= 0.5) return "⣇"; // 5 dots
    if (progress >= 0.375) return "⡇"; // 4 dots
    if (progress >= 0.25) return "⡆"; // 3 dots
    if (progress >= 0.125) return "⡄"; // 2 dots
    if (progress > 0) return "⡀"; // 1 dot
    return " "; // Empty
  }

  async gatherFileInfo(
    files: string[],
    resolution: number,
    frameCount: number,
    concurrency: number = 10,
  ): Promise<GatherFileInfoResult> {
    const fileInfoMap = new Map<string, FileInfo>();
    const formatStats = new Map<string, Stats>();
    const semaphore = new Semaphore(concurrency);
    const errorFiles: string[] = [];

    const multibar = new cliProgress.MultiBar(
      {
        clearOnComplete: false,
        stopOnComplete: true,
        hideCursor: true,
        etaBuffer: 1000,
        barsize: 15,
        etaAsynchronousUpdate: true,

        format: (options, params, payload) => {
          const barSize = options.barsize || 10;

          const completeBars = Math.floor(params.progress * barSize);
          const remainderProgress = params.progress * barSize - completeBars;

          const microProgressChar =
            this.getBrailleProgressChar(remainderProgress);

          const bar =
            "⣿".repeat(completeBars) +
            microProgressChar +
            " ".repeat(barSize - completeBars);

          const percentage = (params.progress * 100).toFixed(2);

          // Determine whether to show ETA or duration
          let timeInfo;
          if (params.stopTime == null) {
            if (params.eta > 0) {
              const eta = this.formatTime(params.eta);
              timeInfo = `ETA: ${chalk.yellow(eta.padStart(9))}`;
            } else {
              timeInfo = " ".repeat(14);
            }
          } else {
            const duration = this.formatTime(
              (params.stopTime! - params.startTime) / 1000,
            );
            timeInfo = `Time: ${chalk.yellow(duration.padStart(8))}`;
          }

          return `${chalk.white(payload.format.padEnd(6))} ${bar} ${chalk.green(percentage.padStart(6))}% | ${chalk.cyan(payload.processedCount.toString().padStart(5))}/${chalk.cyan(payload.totalCount.toString().padStart(5))} | ${timeInfo} | ${chalk.magenta(payload.withImageDateCount.toString().padStart(5))} w/date | ${chalk.magenta(payload.withCameraCount.toString().padStart(5))} w/camera | ${chalk.magenta(payload.withGeoCount.toString().padStart(5))} w/geo | ${chalk.red(payload.errorCount.toString().padStart(5))} errors | ${chalk.yellow(payload.cachedCount.toString().padStart(5))} cached`;
        },
      },
      cliProgress.Presets.shades_classic,
    );

    // Group files by format
    const filesByFormat = new Map<string, string[]>();
    for (const file of files) {
      const ext = path.extname(file).slice(1).toLowerCase();
      if (MediaOrganizer.ALL_SUPPORTED_EXTENSIONS.has(ext)) {
        filesByFormat.set(ext, filesByFormat.get(ext) ?? []);
        filesByFormat.get(ext)!.push(file);
      }
    }

    const bars = new Map<string, cliProgress.Bar>();
    for (const format of MediaOrganizer.ALL_SUPPORTED_EXTENSIONS) {
      if (!filesByFormat.has(format)) continue;

      const formatFiles = filesByFormat.get(format)!;

      const stats: Stats = {
        totalCount: formatFiles.length,
        processedCount: 0,
        withGeoCount: 0,
        withImageDateCount: 0,
        withCameraCount: 0,
        errorCount: 0,
        cachedCount: 0,
      };
      formatStats.set(format, stats);

      const bar = multibar.create(stats.totalCount, 0, {
        format,
        ...stats,
      });
      bars.set(format, bar);
    }

    // Process files format by format
    for (const format of MediaOrganizer.ALL_SUPPORTED_EXTENSIONS) {
      if (!filesByFormat.has(format)) continue;

      const formatFiles = filesByFormat.get(format)!;
      const stats = formatStats.get(format)!;
      const bar = bars.get(format)!;
      bar.start(stats.totalCount, 0, {
        format,
        ...stats,
      });

      for (const file of formatFiles) {
        await semaphore.waitForUnlock();
        semaphore.runExclusive(async () => {
          try {
            let fileInfo: FileInfo | undefined = (await this.db.get(file)) as
              | FileInfo
              | undefined;

            if (fileInfo) {
              stats.cachedCount++;
            } else {
              fileInfo = await this.getFileInfo(file, resolution, frameCount);
              await this.db.put(file, fileInfo);
            }
            fileInfoMap.set(file, fileInfo);

            stats.processedCount++;
            if (fileInfo.geoLocation) stats.withGeoCount++;
            if (fileInfo.imageDate) stats.withImageDateCount++;
            if (fileInfo.cameraModel) stats.withCameraCount++;

            bar.update(stats.processedCount, stats);
          } catch {
            stats.processedCount++;
            stats.errorCount++;
            errorFiles.push(file);
            bar.update(stats.processedCount, stats);

            // if (multibar.log) {
            //   multibar.log(`Error processing file ${file}: ${error}`);
            // }
          }
        });
      }
      await semaphore.waitForUnlock(concurrency);
    }

    multibar.stop();

    return { fileInfoMap, errorFiles };
  }

  async deduplicateFiles(
    fileInfoMap: Map<string, FileInfo>,
    resolution: number,
    frameCount: number,
    similarity: number,
  ): Promise<DeduplicationResult> {
    const imageFiles = new Map<string, FileInfo>();
    const videoFiles = new Map<string, FileInfo>();

    // Separate image and video files
    for (const [path, fileInfo] of fileInfoMap) {
      const fileType = MediaOrganizer.getFileType(path);
      if (fileType === FileType.Image) {
        imageFiles.set(path, fileInfo);
      } else if (fileType === FileType.Video) {
        videoFiles.set(path, fileInfo);
      }
    }

    const [imageResult, videoResult] = await Promise.all([
      this.deduplicateFileType(
        imageFiles,
        resolution,
        1,
        similarity,
        FileType.Image,
      ),
      this.deduplicateFileType(
        videoFiles,
        resolution,
        frameCount,
        similarity,
        FileType.Video,
      ),
    ]);

    // Combine results
    return {
      uniqueFiles: new Map([
        ...imageResult.uniqueFiles,
        ...videoResult.uniqueFiles,
      ]),
      duplicateSets: new Map([
        ...imageResult.duplicateSets,
        ...videoResult.duplicateSets,
      ]),
    };
  }

  private deduplicateFileType(
    fileInfoMap: Map<string, FileInfo>,
    resolution: number,
    frameCount: number,
    similarity: number,
    fileType: FileType,
  ): DeduplicationResult {
    const spinner = new Spinner().start(
      `Deduplicating ${fileInfoMap.size} files...`,
      {
        withPrefix: fileType === FileType.Image ? "Image " : "Video ",
      },
    );

    const uniqueFiles = new Map<string, FileInfo>();
    const duplicateSets = new Map<Buffer, DuplicateSet>();
    const hashLength = resolution * resolution * frameCount;
    const hammingThreshold = Math.floor(hashLength * (1 - similarity));

    // Create VPTree
    const points = Array.from(fileInfoMap.entries()).map(
      ([path, fileInfo]) => ({
        hash: fileInfo.perceptualHash!,
        identifier: path,
      }),
    );
    const vpTree = new VPTree(points, this.hammingDistance.bind(this));

    // Perform deduplication using VPTree traversal
    const processed = new Set<string>();

    for (const [path, fileInfo] of fileInfoMap) {
      if (processed.has(path)) continue;

      const neighbors = vpTree.nearestNeighbors(fileInfo.perceptualHash!, {
        distance: hammingThreshold,
      });
      if (neighbors.length > 1) {
        // Found duplicates
        const duplicateGroup = neighbors.map((n) => n.identifier);
        const bestFile = this.selectBestFile(
          duplicateGroup.map((p) => fileInfoMap.get(p)!),
        );
        const duplicateSet: DuplicateSet = {
          bestFile: bestFile,
          duplicates: new Set(
            duplicateGroup.filter((p) => p !== bestFile.path),
          ),
        };
        duplicateSets.set(bestFile.hash, duplicateSet);
        duplicateGroup.forEach((p) => processed.add(p));
      } else {
        // Unique file
        uniqueFiles.set(path, fileInfo);
        processed.add(path);
      }
    }

    spinner.succeed(
      `Deduplication completed: Found ${duplicateSets.size} duplicate sets, ${Array.from(duplicateSets.values()).reduce((sum, set) => sum + set.duplicates.size, 0)} duplicates`,
    );

    return { uniqueFiles, duplicateSets };
  }

  private hammingDistance(hash1: Buffer, hash2: Buffer): number {
    let distance = 0;
    for (let i = 0; i < hash1.length; i++) {
      distance += this.popcount(hash1[i] ^ hash2[i]);
    }
    return distance;
  }

  private popcount(x: number): number {
    // Counts the number of set bits (1s) in a binary representation of the number
    x -= (x >> 1) & 0x55555555;
    x = (x & 0x33333333) + ((x >> 2) & 0x33333333);
    x = (x + (x >> 4)) & 0x0f0f0f0f;
    x += x >> 8;
    x += x >> 16;
    return x & 0x7f;
  }

  private handleDuplicate(
    fileInfo: FileInfo,
    duplicateSet: DuplicateSet,
  ): boolean {
    const oldBestFile = duplicateSet.bestFile;
    const newBestFile = this.selectBestFile([oldBestFile, fileInfo]);

    if (newBestFile === fileInfo) {
      duplicateSet.duplicates.add(oldBestFile.path);
      duplicateSet.bestFile = fileInfo;
      return true;
    } else {
      duplicateSet.duplicates.add(fileInfo.path);
      return false;
    }
  }

  private selectBestFile(files: FileInfo[]): FileInfo {
    return files.reduce((best, current) => {
      if (current.imageDate && !best.imageDate) return current;
      if (best.imageDate && !current.imageDate) return best;
      if (current.geoLocation && !best.geoLocation) return current;
      if (best.geoLocation && !current.geoLocation) return best;
      if (current.cameraModel && !best.cameraModel) return current;
      if (best.cameraModel && !current.cameraModel) return best;
      if (current.quality !== undefined && best.quality !== undefined) {
        if (current.quality > best.quality) return current;
        if (best.quality > current.quality) return best;
      }
      return current.size > best.size ? current : best;
    });
  }

  async transferFiles(
    gatherFileInfoResult: GatherFileInfoResult,
    deduplicationResult: DeduplicationResult,
    targetDir: string,
    duplicateDir: string | undefined,
    errorDir: string | undefined,
    debugDir: string | undefined,
    format: string,
    shouldMove: boolean,
  ): Promise<void> {
    const multibar = new MultiBar(
      {
        clearOnComplete: false,
        hideCursor: true,
        format:
          "{phase} " +
          chalk.cyan("{bar}") +
          " {percentage}% || {value}/{total} Files",
      },
      Presets.shades_classic,
    );

    // Debug mode: Copy all files in duplicate sets
    if (debugDir) {
      const debugCount = Array.from(
        deduplicationResult.duplicateSets.values(),
      ).reduce((sum, set) => sum + set.duplicates.size + 1, 0);
      const debugBar = multibar.create(debugCount, 0, { phase: "Debug   " });

      for (const [, duplicateSet] of deduplicationResult.duplicateSets) {
        const bestFile = duplicateSet.bestFile;
        const duplicateFolderName = basename(
          bestFile.path,
          extname(bestFile.path),
        );
        const debugSetFolder = join(debugDir, duplicateFolderName);

        await this.transferOrCopyFile(
          bestFile.path,
          join(debugSetFolder, basename(bestFile.path)),
          true,
        );
        debugBar.increment();

        for (const duplicatePath of duplicateSet.duplicates) {
          await this.transferOrCopyFile(
            duplicatePath,
            join(debugSetFolder, basename(duplicatePath)),
            true,
          );
          debugBar.increment();
        }
      }
    }

    // Transfer unique files
    const uniqueBar = multibar.create(deduplicationResult.uniqueFiles.size, 0, {
      phase: "Unique  ",
    });
    for (const [, fileInfo] of deduplicationResult.uniqueFiles) {
      const targetPath = this.generateTargetPath(format, targetDir, fileInfo);
      await this.transferOrCopyFile(fileInfo.path, targetPath, !shouldMove);
      uniqueBar.increment();
    }

    // Handle duplicate files
    if (duplicateDir) {
      const duplicateCount = Array.from(
        deduplicationResult.duplicateSets.values(),
      ).reduce((sum, set) => sum + set.duplicates.size, 0);
      const duplicateBar = multibar.create(duplicateCount, 0, {
        phase: "Duplicate",
      });

      for (const [, duplicateSet] of deduplicationResult.duplicateSets) {
        const bestFile = duplicateSet.bestFile;
        const duplicateFolderName = basename(
          bestFile.path,
          extname(bestFile.path),
        );
        const duplicateSetFolder = join(duplicateDir, duplicateFolderName);

        for (const duplicatePath of duplicateSet.duplicates) {
          await this.transferOrCopyFile(
            duplicatePath,
            join(duplicateSetFolder, basename(duplicatePath)),
            !shouldMove,
          );
          duplicateBar.increment();
        }
      }

      console.log(
        chalk.yellow(
          `Duplicate files have been ${shouldMove ? "moved" : "copied"} to ${duplicateDir}`,
        ),
      );
    } else {
      // If no duplicateDir is specified, we still need to process (move or copy) the best files from each duplicate set
      const bestFileBar = multibar.create(
        deduplicationResult.duplicateSets.size,
        0,
        { phase: "Best File" },
      );
      for (const [, duplicateSet] of deduplicationResult.duplicateSets) {
        const bestFile = duplicateSet.bestFile;
        const targetPath = this.generateTargetPath(format, targetDir, bestFile);
        await this.transferOrCopyFile(bestFile.path, targetPath, !shouldMove);
        bestFileBar.increment();
      }
    }

    // Handle error files
    if (errorDir && gatherFileInfoResult.errorFiles.length > 0) {
      const errorBar = multibar.create(
        gatherFileInfoResult.errorFiles.length,
        0,
        { phase: "Error   " },
      );
      for (const errorFilePath of gatherFileInfoResult.errorFiles) {
        const targetPath = join(errorDir, basename(errorFilePath));
        await this.transferOrCopyFile(errorFilePath, targetPath, !shouldMove);
        errorBar.increment();
      }
    }

    multibar.stop();
    console.log(chalk.green("\nFile transfer completed"));
    if (debugDir && deduplicationResult.duplicateSets.size > 0) {
      console.log(
        chalk.yellow(
          `Debug mode: All files in duplicate sets have been copied to ${debugDir} for verification.`,
        ),
      );
    }
  }

  static getFileType(filePath: string): FileType {
    const ext = extname(filePath).slice(1).toLowerCase();
    if (MediaOrganizer.SUPPORTED_EXTENSIONS[FileType.Image].has(ext)) {
      return FileType.Image;
    } else if (MediaOrganizer.SUPPORTED_EXTENSIONS[FileType.Video].has(ext)) {
      return FileType.Video;
    } else {
      throw new Error(`Unsupported file type for file ${filePath}`);
    }
  }

  private async transferOrCopyFile(
    sourcePath: string,
    targetPath: string,
    isCopy: boolean,
  ): Promise<void> {
    await mkdir(dirname(targetPath), { recursive: true });
    if (isCopy) {
      await copyFile(sourcePath, targetPath);
    } else {
      try {
        await rename(sourcePath, targetPath);
      } catch (error) {
        if (
          error instanceof Error &&
          "code" in error &&
          error.code === "EXDEV"
        ) {
          // Cross-device move, fallback to copy-then-delete
          await copyFile(sourcePath, targetPath);
          await unlink(sourcePath);
        } else {
          throw error;
        }
      }
    }
  }

  private generateTargetPath(
    format: string,
    targetDir: string,
    fileInfo: FileInfo,
  ): string {
    const mixedDate = fileInfo.imageDate || fileInfo.fileDate;
    const { name, ext } = parse(fileInfo.path);

    function generateRandomId(): string {
      return crypto.randomBytes(4).toString("hex");
    }

    const data: { [key: string]: string } = {
      "I.YYYY": this.formatDate(fileInfo.imageDate, "YYYY"),
      "I.YY": this.formatDate(fileInfo.imageDate, "YY"),
      "I.MMMM": this.formatDate(fileInfo.imageDate, "MMMM"),
      "I.MMM": this.formatDate(fileInfo.imageDate, "MMM"),
      "I.MM": this.formatDate(fileInfo.imageDate, "MM"),
      "I.M": this.formatDate(fileInfo.imageDate, "M"),
      "I.DD": this.formatDate(fileInfo.imageDate, "DD"),
      "I.D": this.formatDate(fileInfo.imageDate, "D"),
      "I.DDDD": this.formatDate(fileInfo.imageDate, "DDDD"),
      "I.DDD": this.formatDate(fileInfo.imageDate, "DDD"),
      "I.HH": this.formatDate(fileInfo.imageDate, "HH"),
      "I.H": this.formatDate(fileInfo.imageDate, "H"),
      "I.hh": this.formatDate(fileInfo.imageDate, "hh"),
      "I.h": this.formatDate(fileInfo.imageDate, "h"),
      "I.mm": this.formatDate(fileInfo.imageDate, "mm"),
      "I.m": this.formatDate(fileInfo.imageDate, "m"),
      "I.ss": this.formatDate(fileInfo.imageDate, "ss"),
      "I.s": this.formatDate(fileInfo.imageDate, "s"),
      "I.a": this.formatDate(fileInfo.imageDate, "a"),
      "I.A": this.formatDate(fileInfo.imageDate, "A"),
      "I.WW": this.formatDate(fileInfo.imageDate, "WW"),

      "F.YYYY": this.formatDate(fileInfo.fileDate, "YYYY"),
      "F.YY": this.formatDate(fileInfo.fileDate, "YY"),
      "F.MMMM": this.formatDate(fileInfo.fileDate, "MMMM"),
      "F.MMM": this.formatDate(fileInfo.fileDate, "MMM"),
      "F.MM": this.formatDate(fileInfo.fileDate, "MM"),
      "F.M": this.formatDate(fileInfo.fileDate, "M"),
      "F.DD": this.formatDate(fileInfo.fileDate, "DD"),
      "F.D": this.formatDate(fileInfo.fileDate, "D"),
      "F.DDDD": this.formatDate(fileInfo.fileDate, "DDDD"),
      "F.DDD": this.formatDate(fileInfo.fileDate, "DDD"),
      "F.HH": this.formatDate(fileInfo.fileDate, "HH"),
      "F.H": this.formatDate(fileInfo.fileDate, "H"),
      "F.hh": this.formatDate(fileInfo.fileDate, "hh"),
      "F.h": this.formatDate(fileInfo.fileDate, "h"),
      "F.mm": this.formatDate(fileInfo.fileDate, "mm"),
      "F.m": this.formatDate(fileInfo.fileDate, "m"),
      "F.ss": this.formatDate(fileInfo.fileDate, "ss"),
      "F.s": this.formatDate(fileInfo.fileDate, "s"),
      "F.a": this.formatDate(fileInfo.fileDate, "a"),
      "F.A": this.formatDate(fileInfo.fileDate, "A"),
      "F.WW": this.formatDate(fileInfo.fileDate, "WW"),

      "D.YYYY": this.formatDate(mixedDate, "YYYY"),
      "D.YY": this.formatDate(mixedDate, "YY"),
      "D.MMMM": this.formatDate(mixedDate, "MMMM"),
      "D.MMM": this.formatDate(mixedDate, "MMM"),
      "D.MM": this.formatDate(mixedDate, "MM"),
      "D.M": this.formatDate(mixedDate, "M"),
      "D.DD": this.formatDate(mixedDate, "DD"),
      "D.D": this.formatDate(mixedDate, "D"),
      "D.DDDD": this.formatDate(mixedDate, "DDDD"),
      "D.DDD": this.formatDate(mixedDate, "DDD"),
      "D.HH": this.formatDate(mixedDate, "HH"),
      "D.H": this.formatDate(mixedDate, "H"),
      "D.hh": this.formatDate(mixedDate, "hh"),
      "D.h": this.formatDate(mixedDate, "h"),
      "D.mm": this.formatDate(mixedDate, "mm"),
      "D.m": this.formatDate(mixedDate, "m"),
      "D.ss": this.formatDate(mixedDate, "ss"),
      "D.s": this.formatDate(mixedDate, "s"),
      "D.a": this.formatDate(mixedDate, "a"),
      "D.A": this.formatDate(mixedDate, "A"),
      "D.WW": this.formatDate(mixedDate, "WW"),

      NAME: name,
      "NAME.L": name.toLowerCase(),
      "NAME.U": name.toUpperCase(),
      EXT: ext.slice(1).toLowerCase(),
      RND: generateRandomId(),
      GEO: fileInfo.geoLocation || "",
      CAM: fileInfo.cameraModel || "",
      TYPE: fileInfo.quality !== undefined ? "Image" : "Other",
      "HAS.GEO": fileInfo.geoLocation ? "GeoTagged" : "NoGeo",
      "HAS.CAM": fileInfo.cameraModel ? "WithCamera" : "NoCamera",
      "HAS.DATE":
        fileInfo.imageDate && !isNaN(fileInfo.imageDate.getTime())
          ? "Dated"
          : "NoDate",
    };

    let formattedPath = format.replace(/\{([^{}]+)\}/g, (match, key) => {
      return data[key] || "";
    });

    formattedPath = formattedPath.split("/").filter(Boolean).join("/");

    if (!formattedPath) {
      formattedPath = "NoDate";
    }

    const parts = formattedPath.split("/");
    const lastPart = parts[parts.length - 1];
    let directory, filename;

    if (lastPart.includes(".") && lastPart.split(".").pop() === data["EXT"]) {
      directory = parts.slice(0, -1).join("/");
      filename = lastPart;
    } else {
      directory = formattedPath;
      filename = `${name}${ext}`;
    }

    let fullPath = join(targetDir, directory, filename);

    while (existsSync(fullPath)) {
      const { name: conflictName, ext: conflictExt } = parse(fullPath);
      fullPath = join(
        dirname(fullPath),
        `${conflictName}_${generateRandomId()}${conflictExt}`,
      );
    }

    return fullPath;
  }

  private formatDate(date: Date | undefined, format: string): string {
    if (!date || isNaN(date.getTime())) {
      return "";
    }

    const pad = (num: number) => num.toString().padStart(2, "0");

    const formatters: { [key: string]: () => string } = {
      YYYY: () => date.getFullYear().toString(),
      YY: () => date.getFullYear().toString().slice(-2),
      MMMM: () => date.toLocaleString("default", { month: "long" }),
      MMM: () => date.toLocaleString("default", { month: "short" }),
      MM: () => pad(date.getMonth() + 1),
      M: () => (date.getMonth() + 1).toString(),
      DD: () => pad(date.getDate()),
      D: () => date.getDate().toString(),
      DDDD: () => date.toLocaleString("default", { weekday: "long" }),
      DDD: () => date.toLocaleString("default", { weekday: "short" }),
      HH: () => pad(date.getHours()),
      H: () => date.getHours().toString(),
      hh: () => pad(date.getHours() % 12 || 12),
      h: () => (date.getHours() % 12 || 12).toString(),
      mm: () => pad(date.getMinutes()),
      m: () => date.getMinutes().toString(),
      ss: () => pad(date.getSeconds()),
      s: () => date.getSeconds().toString(),
      a: () => (date.getHours() < 12 ? "am" : "pm"),
      A: () => (date.getHours() < 12 ? "AM" : "PM"),
      WW: () => pad(this.getWeekNumber(date)),
    };

    return format.replace(/(\w+)/g, (match) => {
      const formatter = formatters[match];
      return formatter ? formatter() : match;
    });
  }

  private getWeekNumber(date: Date): number {
    const d = new Date(
      Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()),
    );
    const dayNum = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    return Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  }

  async cleanup() {
    await this.exiftool.end();
  }

  private async getFileInfo(
    filePath: string,
    resolution: number,
    frameCount: number,
  ): Promise<FileInfo> {
    const fileTypeInfo = MediaOrganizer.getFileType(filePath);
    let perceptualHashPromise: Promise<Buffer>;
    switch (fileTypeInfo) {
      case FileType.Image:
        perceptualHashPromise = this.getImagePerceptualHash(
          filePath,
          resolution,
        );
        break;
      case FileType.Video:
        perceptualHashPromise = this.getVideoPerceptualHash(
          filePath,
          frameCount,
          resolution,
        );
        break;
      default:
        throw new Error("Unsupported file type for file " + filePath);
    }

    const [fileStat, hash, metadata, perceptualHash] = await Promise.all([
      stat(filePath),
      this.calculateFileHash(filePath),
      this.getMetadata(filePath),
      perceptualHashPromise,
    ]);

    const imageDate =
      this.toDate(metadata.DateTimeOriginal) ??
      this.toDate(metadata.MediaCreateDate);

    const fileInfo: FileInfo = {
      path: filePath,
      size: fileStat.size,
      hash,
      imageDate: imageDate,
      fileDate: fileStat.mtime,
      perceptualHash: perceptualHash,
      quality: (metadata.ImageHeight ?? 0) * (metadata.ImageWidth ?? 0),
      geoLocation:
        metadata.GPSLatitude && metadata.GPSLongitude
          ? `${metadata.GPSLatitude},${metadata.GPSLongitude}`
          : undefined,
      cameraModel: metadata.Model,
    };

    return fileInfo;
  }

  private async calculateFileHash(
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

  private getMetadata(path: string): Promise<Tags> {
    return this.exiftool.read(path);
  }

  private async getImagePerceptualHash(
    filePath: string,
    resolution: number,
  ): Promise<Buffer> {
    const image = sharp(filePath, { failOnError: true });

    try {
      const perceptualHashData = await image
        .resize(resolution, resolution, { fit: "fill" })
        .greyscale()
        .raw()
        .toBuffer({ resolveWithObject: false });

      return this.getPerceptualHash(perceptualHashData, resolution);
    } finally {
      image.destroy();
    }
  }

  private getVideoPerceptualHash(
    filePath: string,
    numFrames: number = 10,
    resolution: number = 8,
  ): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      ffmpeg.ffprobe(filePath, (err, metadata) => {
        if (err) {
          return reject(err);
        }

        const duration = metadata.format.duration;
        if (!duration) {
          return reject(new Error("Could not determine video duration."));
        }

        const interval = Math.max(1, duration / (numFrames + 1));
        const frameBuffers: Buffer[] = [];

        ffmpeg(filePath)
          .on("error", (err) => {
            return reject(err);
          })
          .on("end", async () => {
            try {
              if (frameBuffers.length <= 0) {
                return reject(new Error("No frames extracted from video."));
              }
              const combinedHash = await this.combineFrameHashes(
                frameBuffers,
                resolution,
                numFrames,
              );
              resolve(combinedHash);
            } catch (error) {
              reject(error);
            }
          })
          .videoFilters(
            `select='(isnan(prev_selected_t)*gte(t\\,${interval}))+gte(t-prev_selected_t\\,${interval})',scale=${resolution}:${resolution},format=gray`,
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
          .pipe()
          .on("data", (chunk) => {
            frameBuffers.push(chunk);
          });
      });
    });
  }

  private async combineFrameHashes(
    frameBuffers: Buffer[],
    resolution: number,
    numFrames: number,
  ): Promise<Buffer> {
    const combinedHash = Buffer.alloc(resolution * resolution * numFrames);

    // Combine perceptual hashes from each frame
    for (let i = 0; i < frameBuffers.length; i++) {
      const frameHash = this.getPerceptualHash(frameBuffers[i], resolution);
      frameHash.copy(combinedHash, i * frameHash.length);
    }

    return combinedHash;
  }

  private getPerceptualHash(imageBuffer: Buffer, resolution: number): Buffer {
    const pixelCount = resolution * resolution;
    const pixels = new Uint8Array(pixelCount);
    const hash = Buffer.alloc(Math.ceil(pixelCount / 8));

    // Convert to grayscale and resize
    for (let i = 0; i < pixelCount; i++) {
      pixels[i] = imageBuffer[i];
    }

    // Calculate average
    const average = pixels.reduce((sum, pixel) => sum + pixel, 0) / pixelCount;

    // Calculate hash
    for (let i = 0; i < pixelCount; i++) {
      if (pixels[i] > average) {
        hash[Math.floor(i / 8)] |= 1 << i % 8;
      }
    }

    return hash;
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
}