import { ExifDate, ExifDateTime } from "exiftool-vendored";
import {
  type FileInfo,
  type DeduplicationResult,
  type Stats,
  type GatherFileInfoResult,
  type PathEntry,
  type ProcessingConfig,
  FileType,
} from "./types";
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
import path from "path";
import { Spinner } from "@topcli/spinner";
import { Database, open, RootDatabase } from "lmdb";
import type { MediaComparator } from "./MediaComparator";
import { MediaProcessor } from "./MediaProcessor";

export class MediaOrganizer {
  private db: RootDatabase;
  private fileInfoDb: Database;
  private pathDb: Database;

  constructor(
    private processor: MediaProcessor,
    private comparator: MediaComparator,
    dbPath: string = ".mediadb",
  ) {
    this.db = open({
      path: dbPath,
      compression: true,
    });
    this.fileInfoDb = this.db.openDB<FileInfo>({ name: "fileInfo" });
    this.pathDb = this.db.openDB<PathEntry>({ name: "paths" });
  }

  private getConfigHash(config: ProcessingConfig): string {
    return createHash("md5").update(JSON.stringify(config)).digest("hex");
  }

  private getFileInfoKey(fileHash: Buffer, config: ProcessingConfig): string {
    return `${fileHash.toString("hex")}-${this.getConfigHash(config)}`;
  }

  async getFileInfo(
    filePath: string,
    config: ProcessingConfig,
  ): Promise<FileInfo | undefined> {
    const pathEntry = await this.pathDb.get(filePath);
    if (!pathEntry) return undefined;
    const fileInfoKey = this.getFileInfoKey(pathEntry.hash, config);
    return this.fileInfoDb.get(fileInfoKey);
  }

  async setFileInfo(
    filePath: string,
    fileInfo: FileInfo,
    fileDate: Date,
  ): Promise<void> {
    const fileInfoKey = this.getFileInfoKey(
      fileInfo.hash,
      fileInfo.processingConfig,
    );
    await this.fileInfoDb.put(fileInfoKey, fileInfo);
    await this.pathDb.put(filePath, { hash: fileInfo.hash, fileDate });
  }

  async discoverFiles(
    sourceDirs: string[],
    concurrency: number = 10,
  ): Promise<string[]> {
    const allFiles: string[] = [];
    let dirCount = 0;
    let fileCount = 0;
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
            MediaProcessor.ALL_SUPPORTED_EXTENSIONS.has(
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

    spinner.succeed(
      `Discovery completed in ${(spinner.elapsedTime / 1000).toFixed(2)} seconds: Found ${fileCount} files in ${dirCount} directories`,
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
    concurrency: number = 10,
  ): Promise<GatherFileInfoResult> {
    const formatStats = new Map<string, Stats>();
    const semaphore = new Semaphore(concurrency);
    const errorFiles: string[] = [];
    const validFiles: string[] = [];

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

          const stats = payload.stats as Stats;

          return (
            `${chalk.white(payload.format.padEnd(6))} ${bar} ${chalk.green(percentage.padStart(6))}% | ` +
            `${chalk.cyan(params.value.toString().padStart(7))}/${chalk.cyan(params.total.toString().padStart(7))} | ` +
            `${timeInfo} | ` +
            `${chalk.magenta(stats.withImageDateCount.toString().padStart(5))} w/date | ` +
            `${chalk.magenta(stats.withCameraCount.toString().padStart(5))} w/camera | ` +
            `${chalk.magenta(stats.withGeoCount.toString().padStart(5))} w/geo | ` +
            `${chalk.red(stats.errorCount.toString().padStart(5))} errors | ` +
            `${chalk.yellow(stats.cachedCount.toString().padStart(5))} cached`
          );
        },
      },
      cliProgress.Presets.shades_classic,
    );

    // Group files by format
    const filesByFormat = new Map<string, string[]>();
    for (const file of files) {
      const ext = path.extname(file).slice(1).toLowerCase();
      if (MediaProcessor.ALL_SUPPORTED_EXTENSIONS.has(ext)) {
        filesByFormat.set(ext, filesByFormat.get(ext) ?? []);
        filesByFormat.get(ext)!.push(file);
      }
    }

    const sortedFormats = Array.from(filesByFormat.keys()).sort(
      (a, b) =>
        MediaOrganizer.getFileTypeByExt(a) -
          MediaOrganizer.getFileTypeByExt(b) ||
        filesByFormat.get(b)!.length - filesByFormat.get(a)!.length,
    );

    const bars = new Map<string, cliProgress.Bar>();
    for (const format of sortedFormats) {
      const formatFiles = filesByFormat.get(format)!;

      const stats: Stats = {
        withGeoCount: 0,
        withImageDateCount: 0,
        withCameraCount: 0,
        errorCount: 0,
        cachedCount: 0,
      };
      formatStats.set(format, stats);

      const bar = multibar.create(formatFiles.length, 0, {
        format,
        stats,
      });
      bars.set(format, bar);
    }

    // Process files format by format
    for (const format of sortedFormats) {
      const formatFiles = filesByFormat.get(format)!;
      const stats = formatStats.get(format)!;
      const bar = bars.get(format)!;
      bar.start(bar.getTotal(), 0, {
        format,
        stats: stats,
      });

      for (const file of formatFiles) {
        await semaphore.waitForUnlock();
        semaphore.runExclusive(async () => {
          try {
            let fileInfo = await this.getFileInfo(file, this.processor.config);
            if (
              fileInfo &&
              this.isConfigMatch(
                fileInfo.processingConfig,
                this.processor.config,
              )
            ) {
              stats.cachedCount++;
            } else {
              const hash = await this.processor.calculateFileHash(file);
              fileInfo = await this.processor.processFile(file, hash);
              const fileStat = await stat(file);
              await this.setFileInfo(file, fileInfo, fileStat.mtime);
            }

            if (fileInfo.geoLocation) stats.withGeoCount++;
            if (fileInfo.imageDate) stats.withImageDateCount++;
            if (fileInfo.cameraModel) stats.withCameraCount++;
            validFiles.push(file);
          } catch {
            stats.errorCount++;
            errorFiles.push(file);
          } finally {
            bar.increment();
          }
        });
      }
      await semaphore.waitForUnlock(concurrency);
    }

    multibar.stop();

    return { validFiles, errorFiles };
  }

  private isConfigMatch(
    config1: ProcessingConfig,
    config2: ProcessingConfig,
  ): boolean {
    return (
      config1.resolution === config2.resolution &&
      config1.framesPerSecond === config2.framesPerSecond &&
      config1.maxFrames === config2.maxFrames
    );
  }

  async deduplicateFiles(files: string[]): Promise<DeduplicationResult> {
    const spinner = new Spinner().start("Deduplicating files...");

    const fileInfoMap = new Map<string, FileInfo>();
    for (const file of files) {
      const fileInfo = await this.getFileInfo(file, this.processor.config);
      if (!fileInfo) {
        throw new Error(`File info not found for file ${file}`);
      }
      fileInfoMap.set(file, fileInfo);
    }

    const { uniqueFiles, duplicateSets } = this.comparator.deduplicateFiles(
      files,
      (file) => fileInfoMap.get(file)!,
    );

    const duplicateCount = duplicateSets.reduce(
      (sum, set) => sum + set.duplicates.size,
      0,
    );
    spinner.succeed(
      `Deduplication completed in ${(spinner.elapsedTime / 1000).toFixed(2)} seconds: Found ${duplicateSets.length} duplicate sets, ${uniqueFiles.size} unique files, ${duplicateCount} duplicates`,
    );

    // print top 5 duplicate sets
    const featuredDuplicates = duplicateSets
      .sort(
        (a, b) =>
          b.duplicates.size +
          b.representatives.size -
          a.duplicates.size -
          a.representatives.size,
      )
      .slice(0, 5);

    console.log(chalk.blue("\nTop 5 Duplicate Sets:"));
    if (featuredDuplicates.length === 0) {
      console.log(chalk.white("No duplicate sets found"));
    }
    for (let i = 0; i < featuredDuplicates.length; i++) {
      const duplicateSet = featuredDuplicates[i];
      console.log(
        chalk.white(`Duplicate Set ${i + 1}: ${duplicateSet.bestFile}`),
      );
      console.log(
        chalk.white(`  ${duplicateSet.representatives.size} representatives`),
      );
      console.log(chalk.white(`  ${duplicateSet.duplicates.size} duplicates`));
    }

    // print mixed format duplicate sets
    const mixedFormatDuplicates = duplicateSets
      .filter((set) => {
        const files = Array.from(set.representatives).concat(
          Array.from(set.duplicates),
        );
        const formats = new Set(
          files.map((file) => MediaOrganizer.getFileType(file)),
        );
        return formats.size > 1;
      })
      .sort(
        (a, b) =>
          b.duplicates.size +
          b.representatives.size -
          a.duplicates.size -
          a.representatives.size,
      )
      .slice(0, 5);

    console.log(chalk.blue("\nTop 5 Mixed Format Duplicate Sets:"));
    if (mixedFormatDuplicates.length === 0) {
      console.log(chalk.white("No mixed format duplicate sets found"));
    }
    for (let i = 0; i < mixedFormatDuplicates.length; i++) {
      const duplicateSet = mixedFormatDuplicates[i];
      console.log(
        chalk.white(`Duplicate Set ${i + 1}: ${duplicateSet.bestFile}`),
      );
      console.log(
        chalk.white(`  ${duplicateSet.representatives.size} representatives`),
      );
      console.log(chalk.white(`  ${duplicateSet.duplicates.size} duplicates`));
    }

    // print multiple representative duplicate sets
    const multipleRepresentatives = duplicateSets.filter(
      (set) => set.representatives.size > 1,
    );
    console.log(chalk.blue("\nDuplicate Sets with Multiple Representatives:"));
    if (multipleRepresentatives.length === 0) {
      console.log(
        chalk.white("No duplicate sets with multiple representatives found"),
      );
    }
    for (let i = 0; i < multipleRepresentatives.length; i++) {
      const duplicateSet = multipleRepresentatives[i];
      console.log(
        chalk.white(`Duplicate Set ${i + 1}: ${duplicateSet.bestFile}`),
      );
      console.log(
        chalk.white(`  ${duplicateSet.representatives.size} representatives`),
      );
      console.log(chalk.white(`  ${duplicateSet.duplicates.size} duplicates`));
    }

    return { uniqueFiles, duplicateSets };
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
      ).reduce(
        (sum, set) => sum + set.duplicates.size + set.representatives.size,
        0,
      );
      const debugBar = multibar.create(debugCount, 0, { phase: "Debug   " });

      for (const duplicateSet of deduplicationResult.duplicateSets) {
        const bestFile = duplicateSet.bestFile;
        const duplicateFolderName = basename(bestFile, extname(bestFile));
        const debugSetFolder = join(debugDir, duplicateFolderName);

        const representatives = duplicateSet.representatives;
        for (const representativePath of representatives) {
          // modify the filename to indicate it's a representative
          const filename = "#" + basename(representativePath);
          await this.transferOrCopyFile(
            representativePath,
            join(debugSetFolder, filename),
            true,
          );
          debugBar.increment();
        }

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
    for (const filePath of deduplicationResult.uniqueFiles) {
      const pathEntry = await this.pathDb.get(filePath);
      const fileInfo = await this.getFileInfo(filePath, this.processor.config);
      if (!fileInfo) {
        throw new Error(`File info not found for file ${filePath}`);
      }
      const targetPath = this.generateTargetPath(
        format,
        targetDir,
        fileInfo,
        pathEntry,
        filePath,
      );
      await this.transferOrCopyFile(filePath, targetPath, !shouldMove);
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

      for (const duplicateSet of deduplicationResult.duplicateSets) {
        const bestFile = duplicateSet.bestFile;
        const duplicateFolderName = basename(bestFile, extname(bestFile));
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
      const representativeCount = Array.from(
        deduplicationResult.duplicateSets.values(),
      ).reduce((sum, set) => sum + set.representatives.size, 0);
      const bestFileBar = multibar.create(representativeCount, 0, {
        phase: "Best File",
      });
      for (const duplicateSet of deduplicationResult.duplicateSets) {
        const representatives = duplicateSet.representatives;
        for (const representativePath of representatives) {
          const pathEntry = await this.pathDb.get(representativePath);
          const fileInfo = await this.getFileInfo(
            representativePath,
            this.processor.config,
          );
          if (!fileInfo) {
            throw new Error(
              `File info not found for file ${representativePath}`,
            );
          }
          const targetPath = this.generateTargetPath(
            format,
            targetDir,
            fileInfo,
            pathEntry,
            representativePath,
          );
          await this.transferOrCopyFile(
            representativePath,
            targetPath,
            !shouldMove,
          );
          bestFileBar.increment();
        }
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
    if (debugDir && deduplicationResult.duplicateSets.length > 0) {
      console.log(
        chalk.yellow(
          `Debug mode: All files in duplicate sets have been copied to ${debugDir} for verification.`,
        ),
      );
    }
  }

  static getFileType(filePath: string): FileType {
    const ext = extname(filePath).slice(1).toLowerCase();
    return MediaOrganizer.getFileTypeByExt(ext);
  }

  static getFileTypeByExt(ext: string): FileType {
    for (const fileType of [FileType.Image, FileType.Video]) {
      if (MediaProcessor.SUPPORTED_EXTENSIONS[fileType].has(ext)) {
        return fileType;
      }
    }
    throw new Error(`Unsupported file type for file ${ext}`);
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
    pathEntry: PathEntry,
    sourcePath: string,
  ): string {
    const mixedDate = fileInfo.imageDate || pathEntry.fileDate;
    const { name, ext } = parse(sourcePath);

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

      "F.YYYY": this.formatDate(pathEntry.fileDate, "YYYY"),
      "F.YY": this.formatDate(pathEntry.fileDate, "YY"),
      "F.MMMM": this.formatDate(pathEntry.fileDate, "MMMM"),
      "F.MMM": this.formatDate(pathEntry.fileDate, "MMM"),
      "F.MM": this.formatDate(pathEntry.fileDate, "MM"),
      "F.M": this.formatDate(pathEntry.fileDate, "M"),
      "F.DD": this.formatDate(pathEntry.fileDate, "DD"),
      "F.D": this.formatDate(pathEntry.fileDate, "D"),
      "F.DDDD": this.formatDate(pathEntry.fileDate, "DDDD"),
      "F.DDD": this.formatDate(pathEntry.fileDate, "DDD"),
      "F.HH": this.formatDate(pathEntry.fileDate, "HH"),
      "F.H": this.formatDate(pathEntry.fileDate, "H"),
      "F.hh": this.formatDate(pathEntry.fileDate, "hh"),
      "F.h": this.formatDate(pathEntry.fileDate, "h"),
      "F.mm": this.formatDate(pathEntry.fileDate, "mm"),
      "F.m": this.formatDate(pathEntry.fileDate, "m"),
      "F.ss": this.formatDate(pathEntry.fileDate, "ss"),
      "F.s": this.formatDate(pathEntry.fileDate, "s"),
      "F.a": this.formatDate(pathEntry.fileDate, "a"),
      "F.A": this.formatDate(pathEntry.fileDate, "A"),
      "F.WW": this.formatDate(pathEntry.fileDate, "WW"),

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
