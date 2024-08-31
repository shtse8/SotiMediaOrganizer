import {
  type FileInfo,
  type DeduplicationResult,
  type Stats,
  type GatherFileInfoResult,
  type DuplicateSet,
} from "./src/types";
import {
  mkdir,
  copyFile,
  rename,
  unlink,
  writeFile,
  readdir,
} from "fs/promises";
import { join, basename, dirname, extname, parse } from "path";
import { existsSync } from "fs";
import crypto from "crypto";
import chalk from "chalk";
import { MultiBar, Presets } from "cli-progress";
import cliProgress from "cli-progress";
import path from "path";
import { Spinner } from "@topcli/spinner";
import { MediaComparator } from "./MediaComparator";
import { MediaProcessor } from "./src/MediaProcessor";
import { ALL_SUPPORTED_EXTENSIONS, getFileTypeByExt } from "./src/utils";
import { injectable } from "inversify";
import { Semaphore } from "async-mutex";

@injectable()
export class MediaOrganizer {
  constructor(
    private processor: MediaProcessor,
    private comparator: MediaComparator,
  ) {
    console.log("MediaOrganizer created", !!processor, !!comparator);
  }

  async discoverFiles(
    sourceDirs: string[],
    concurrency: number = 10,
  ): Promise<Map<string, string[]>> {
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
            ALL_SUPPORTED_EXTENSIONS.has(
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
    const result = new Map<string, string[]>();
    for (const file of allFiles) {
      const ext = path.extname(file).slice(1).toLowerCase();
      result.set(ext, result.get(ext) ?? []);
      result.get(ext)!.push(file);
    }

    console.log(chalk.blue("\nFile Format Statistics:"));
    for (const [format, count] of result.entries()) {
      console.log(
        chalk.white(
          `${format.padEnd(6)}: ${count.length.toString().padStart(8)}`,
        ),
      );
    }
    console.log(
      chalk.green(`${"Total".padEnd(6)}: ${fileCount.toString().padStart(8)}`),
    );

    return result;
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
    files: Map<string, string[]>,
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
          let timeInfo: string;
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
            `${chalk.red(stats.errorCount.toString().padStart(5))} errors`
          );
        },
      },
      cliProgress.Presets.shades_classic,
    );

    const sortedFormats = Array.from(files.keys()).sort(
      (a, b) =>
        getFileTypeByExt(a) - getFileTypeByExt(b) ||
        files.get(b)!.length - files.get(a)!.length,
    );

    const bars = new Map<string, cliProgress.Bar>();
    for (const format of sortedFormats) {
      const formatFiles = files.get(format)!;

      const stats: Stats = {
        withGeoCount: 0,
        withImageDateCount: 0,
        withCameraCount: 0,
        errorCount: 0,
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
      const formatFiles = files.get(format)!;
      const stats = formatStats.get(format)!;
      const bar = bars.get(format)!;
      bar.start(bar.getTotal(), 0, {
        format,
        stats: stats,
      });

      for (const file of formatFiles) {
        const [, release] = await semaphore.acquire();
        (async () => {
          try {
            const fileInfo = await this.processor.processFile(file);

            if (fileInfo.metadata.gpsLatitude && fileInfo.metadata.gpsLongitude)
              stats.withGeoCount++;
            if (fileInfo.metadata.imageDate) stats.withImageDateCount++;
            if (fileInfo.metadata.cameraModel) stats.withCameraCount++;
            validFiles.push(file);
          } catch {
            stats.errorCount++;
            errorFiles.push(file);
          } finally {
            bar.increment();
            release();
          }
        })();
      }
      await semaphore.waitForUnlock(concurrency);
    }

    multibar.stop();

    return { validFiles, errorFiles };
  }

  async deduplicateFiles(files: string[]): Promise<DeduplicationResult> {
    const spinner = new Spinner().start("Deduplicating files...");

    const { uniqueFiles, duplicateSets } =
      await this.comparator.deduplicateFiles(
        files,
        (file) => this.processor.processFile(file),
        (progress) => (spinner.text = `Deduplicating files... ${progress}`),
      );

    const duplicateCount = duplicateSets.reduce(
      (sum, set) => sum + set.duplicates.size,
      0,
    );
    spinner.succeed(
      `Deduplication completed in ${(spinner.elapsedTime / 1000).toFixed(2)} seconds: Found ${duplicateSets.length} duplicate sets, ${uniqueFiles.size} unique files, ${duplicateCount} duplicates`,
    );

    return { uniqueFiles, duplicateSets };
  }
  private async generateReports(
    duplicateSets: DuplicateSet[],
    debugDir: string,
  ): Promise<string[]> {
    const reports = [];
    const batchSize = 1000;

    for (let i = 0; i < duplicateSets.length; i += batchSize) {
      const batch = duplicateSets.slice(i, i + batchSize);

      const totalSets = batch.length;
      let totalRepresentatives = 0;
      let totalDuplicates = 0;

      batch.forEach((set) => {
        totalRepresentatives += set.representatives.size;
        totalDuplicates += set.duplicates.size;
      });

      const formatFileSize = (size: number) =>
        `${(size / (1024 * 1024)).toFixed(2)} MB`;
      const formatDate = (date?: Date) => {
        if (!date) return "Unknown";
        // if invalid date, return "Invalid Date"
        if (isNaN(date.getTime())) {
          console.log("Invalid Date", date);
          return "Invalid Date";
        }
        return date.toDateString();
      };
      const formatDuration = (duration: number) => {
        const seconds = Math.floor(duration % 60);
        const minutes = Math.floor((duration / 60) % 60);
        const hours = Math.floor((duration / (60 * 60)) % 24);
        return `${hours ? `${hours}:` : ""}${minutes ? `${minutes}:` : ""}${seconds}s`;
      };

      const generateFileDetails = (fileInfo: FileInfo, score: number) => {
        const resolution =
          fileInfo.metadata.width && fileInfo.metadata.height
            ? `${fileInfo.metadata.width}x${fileInfo.metadata.height}`
            : "Unknown";
        return `
                <p><strong style="font-size: 16px; color: #ff5722;">Score:</strong> <span style="font-size: 16px; color: #ff5722;">${score.toFixed(2)}</span></p>
                <p><strong>Size:</strong> ${formatFileSize(fileInfo.fileStats.size)}</p>
                ${fileInfo.metadata.width && fileInfo.metadata.height ? `<p><strong>Resolution:</strong> ${resolution}</p>` : ""}
                ${fileInfo.media.duration ? `<p><strong>Duration:</strong> ${formatDuration(fileInfo.media.duration)}</p>` : ""}
                ${fileInfo.metadata.imageDate ? `<p><strong>Date:</strong> ${formatDate(fileInfo.metadata.imageDate)}</p>` : ""}
                ${fileInfo.metadata.gpsLatitude && fileInfo.metadata.gpsLongitude ? `<p><strong>Geo-location:</strong> ${fileInfo.metadata.gpsLatitude.toFixed(2)}, ${fileInfo.metadata.gpsLongitude.toFixed(2)}</p>` : ""}
                ${fileInfo.metadata.cameraModel ? `<p><strong>Camera:</strong> ${fileInfo.metadata.cameraModel}</p>` : ""}
            `;
      };

      const convertToRelativePath = (sourcePath: string): string => {
        const relativePath = path.relative(debugDir, sourcePath);
        return relativePath.replace(/\\/g, "/"); // Convert backslashes to forward slashes for web compatibility
      };

      const isVideoFile = (path: string): boolean => {
        return /\.(mp4|mov|avi|wmv|flv|mkv)$/i.test(path);
      };

      const generateMediaElement = (
        relativePath: string,
        isRepresentative: boolean,
      ): string => {
        const className = isRepresentative ? "representative" : "duplicate";
        if (isVideoFile(relativePath)) {
          const placeholder =
            "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==";
          return `
                    <video class="${className}" src="${placeholder}" data-src="${relativePath}" controls muted playsinline preload="none">
                        Your browser does not support the video tag.
                    </video>`;
        } else {
          return `<img src="${relativePath}" alt="${relativePath}" loading="lazy" class="${className}"/>`;
        }
      };

      const generateSetSection = async (
        setIndex: number,
        representatives: Set<string>,
        duplicates: Set<string>,
      ) => {
        const allMedia = await Promise.all([
          ...Array.from(representatives).map(async (sourcePath) => {
            const info = await this.processor.processFile(sourcePath);
            const score = this.comparator.calculateEntryScore(info!);
            const relativePath = convertToRelativePath(sourcePath);
            return { isRepresentative: true, relativePath, info, score };
          }),
          ...Array.from(duplicates).map(async (sourcePath) => {
            const info = await this.processor.processFile(sourcePath);
            const score = this.comparator.calculateEntryScore(info!);
            const relativePath = convertToRelativePath(sourcePath);
            return { isRepresentative: false, relativePath, info, score };
          }),
        ]);

        allMedia.sort((a, b) => b.score - a.score);

        const mediaTags = allMedia
          .map(
            ({ isRepresentative, relativePath, info, score }) => `
                    <div class="media-container">
                        <a href="${relativePath}" target="_blank" title="Click to view full size">
                            ${generateMediaElement(relativePath, isRepresentative)}
                        </a>
                        ${generateFileDetails(info!, score)}
                    </div>`,
          )
          .join("\n");

        return `
                <div class="set">
                    <h2>Duplicate Set ${i + setIndex + 1}</h2>
                    <div class="media-row">
                        ${mediaTags}
                    </div>
                </div>`;
      };

      const setsHtml = await Promise.all(
        Array.from(batch).map((set, index) =>
          generateSetSection(index, set.representatives, set.duplicates),
        ),
      );

      const reportContent = `
            <!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>Deduplication Debug Report</title>
                <style>
                    body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; padding: 20px; background-color: #f9f9f9; color: #333; }
                    h1 { color: #444; font-size: 24px; margin-bottom: 20px; text-align: center; }
                    h2 { color: #555; font-size: 20px; margin-top: 30px; }
                    .summary { text-align: center; margin-bottom: 30px; }
                    .summary p { font-size: 18px; margin: 5px 0; }
                    .set { background-color: #fff; padding: 15px; border-radius: 8px; box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1); margin-bottom: 20px; }
                    .media-row { display: flex; flex-wrap: wrap; justify-content: space-around; }
                    .media-container { text-align: center; margin-bottom: 20px; max-width: 220px; }
                    img, video { max-width: 200px; max-height: 200px; border-width: 3px; border-style: solid; border-radius: 8px; }
                    img.representative, video.representative { border-color: #007bff; } /* Blue border for representatives */
                    img.duplicate, video.duplicate { border-color: #ccc; } /* Light grey border for duplicates */
                    p { font-size: 14px; margin: 5px 0; }
                </style>
                <script>
                    document.addEventListener("DOMContentLoaded", function() {
                        let lazyVideos = [].slice.call(document.querySelectorAll("video[data-src]"));
                        if ("IntersectionObserver" in window) {
                            let lazyVideoObserver = new IntersectionObserver(function(entries, observer) {
                                entries.forEach(function(video) {
                                    if (video.isIntersecting) {
                                        let lazyVideo = video.target;
                                        lazyVideo.src = lazyVideo.dataset.src;
                                        lazyVideoObserver.unobserve(lazyVideo);
                                    }
                                });
                            });

                            lazyVideos.forEach(function(lazyVideo) {
                                lazyVideoObserver.observe(lazyVideo);
                            });
                        }
                    });
                </script>
            </head>
            <body>
                <h1>Deduplication Debug Report</h1>
                <div class="summary">
                    <p><strong>Total Duplicate Sets:</strong> ${totalSets}</p>
                    <p><strong>Total Representatives:</strong> ${totalRepresentatives}</p>
                    <p><strong>Total Duplicates:</strong> ${totalDuplicates}</p>
                </div>
                ${setsHtml.join("\n")}
            </body>
            </html>
        `;

      const reportFileName = `debug-report-${reports.length + 1}.html`;
      const reportPath = join(debugDir, reportFileName);
      await writeFile(reportPath, reportContent, "utf8");
      reports.push(reportFileName);
    }

    return reports;
  }

  private async generateIndex(reportFiles: string[], debugDir: string) {
    const indexContent = `
      <!DOCTYPE html>
      <html lang="en">
      <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Deduplication Report Index</title>
          <style>
              body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; padding: 20px; background-color: #f9f9f9; color: #333; }
              h1 { color: #444; font-size: 24px; margin-bottom: 20px; text-align: center; }
              ul { list-style-type: none; padding: 0; }
              li { margin-bottom: 15px; }
              a { color: #007bff; text-decoration: none; font-size: 18px; font-weight: bold; }
              a:hover { text-decoration: underline; }
              .report-link { padding: 10px; background-color: #e0f7fa; border-radius: 5px; box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1); display: block; text-align: center; }
              .report-link:hover { background-color: #b2ebf2; }
          </style>
      </head>
      <body>
          <h1>Deduplication Report Index</h1>
          <ul>
              ${reportFiles.map((file, index) => `<li><a class="report-link" href="${file}" target="_blank">Report ${index + 1}</a></li>`).join("\n")}
          </ul>
      </body>
      </html>
  `;

    const indexPath = join(debugDir, "index.html");
    await writeFile(indexPath, indexContent, "utf8");
    console.log(
      chalk.yellow(`Deduplication report index has been saved to ${indexPath}`),
    );
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
    // Debug mode: Copy all files in duplicate sets
    if (debugDir) {
      await mkdir(debugDir, { recursive: true });

      // clear the debug directory
      const debugFiles = await readdir(debugDir);
      for (const file of debugFiles) {
        await unlink(join(debugDir, file));
      }

      if (deduplicationResult.duplicateSets.length > 0) {
        // Generate HTML content for all sets
        const reportFiles = await this.generateReports(
          deduplicationResult.duplicateSets,
          debugDir,
        );
        await this.generateIndex(reportFiles, debugDir);

        console.log(
          chalk.yellow(
            `Debug mode: Duplicate set reports have been saved to ${debugDir}`,
          ),
        );
      } else {
        console.log(chalk.yellow("Debug mode: No duplicate sets found"));
      }
    }

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

    // Transfer unique files
    const uniqueBar = multibar.create(deduplicationResult.uniqueFiles.size, 0, {
      phase: "Unique  ",
    });
    for (const filePath of deduplicationResult.uniqueFiles) {
      const fileInfo = await this.processor.processFile(filePath);
      if (!fileInfo) {
        throw new Error(`File info not found for file ${filePath}`);
      }
      const targetPath = this.generateTargetPath(
        format,
        targetDir,
        fileInfo,
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
          const fileInfo = await this.processor.processFile(representativePath);
          if (!fileInfo) {
            throw new Error(
              `File info not found for file ${representativePath}`,
            );
          }
          const targetPath = this.generateTargetPath(
            format,
            targetDir,
            fileInfo,
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
    sourcePath: string,
  ): string {
    const mixedDate =
      fileInfo.metadata.imageDate || fileInfo.fileStats.createdAt;
    const { name, ext } = parse(sourcePath);

    function generateRandomId(): string {
      return crypto.randomBytes(4).toString("hex");
    }

    const data: { [key: string]: string } = {
      "I.YYYY": this.formatDate(fileInfo.metadata.imageDate, "YYYY"),
      "I.YY": this.formatDate(fileInfo.metadata.imageDate, "YY"),
      "I.MMMM": this.formatDate(fileInfo.metadata.imageDate, "MMMM"),
      "I.MMM": this.formatDate(fileInfo.metadata.imageDate, "MMM"),
      "I.MM": this.formatDate(fileInfo.metadata.imageDate, "MM"),
      "I.M": this.formatDate(fileInfo.metadata.imageDate, "M"),
      "I.DD": this.formatDate(fileInfo.metadata.imageDate, "DD"),
      "I.D": this.formatDate(fileInfo.metadata.imageDate, "D"),
      "I.DDDD": this.formatDate(fileInfo.metadata.imageDate, "DDDD"),
      "I.DDD": this.formatDate(fileInfo.metadata.imageDate, "DDD"),
      "I.HH": this.formatDate(fileInfo.metadata.imageDate, "HH"),
      "I.H": this.formatDate(fileInfo.metadata.imageDate, "H"),
      "I.hh": this.formatDate(fileInfo.metadata.imageDate, "hh"),
      "I.h": this.formatDate(fileInfo.metadata.imageDate, "h"),
      "I.mm": this.formatDate(fileInfo.metadata.imageDate, "mm"),
      "I.m": this.formatDate(fileInfo.metadata.imageDate, "m"),
      "I.ss": this.formatDate(fileInfo.metadata.imageDate, "ss"),
      "I.s": this.formatDate(fileInfo.metadata.imageDate, "s"),
      "I.a": this.formatDate(fileInfo.metadata.imageDate, "a"),
      "I.A": this.formatDate(fileInfo.metadata.imageDate, "A"),
      "I.WW": this.formatDate(fileInfo.metadata.imageDate, "WW"),

      "F.YYYY": this.formatDate(fileInfo.fileStats.createdAt, "YYYY"),
      "F.YY": this.formatDate(fileInfo.fileStats.createdAt, "YY"),
      "F.MMMM": this.formatDate(fileInfo.fileStats.createdAt, "MMMM"),
      "F.MMM": this.formatDate(fileInfo.fileStats.createdAt, "MMM"),
      "F.MM": this.formatDate(fileInfo.fileStats.createdAt, "MM"),
      "F.M": this.formatDate(fileInfo.fileStats.createdAt, "M"),
      "F.DD": this.formatDate(fileInfo.fileStats.createdAt, "DD"),
      "F.D": this.formatDate(fileInfo.fileStats.createdAt, "D"),
      "F.DDDD": this.formatDate(fileInfo.fileStats.createdAt, "DDDD"),
      "F.DDD": this.formatDate(fileInfo.fileStats.createdAt, "DDD"),
      "F.HH": this.formatDate(fileInfo.fileStats.createdAt, "HH"),
      "F.H": this.formatDate(fileInfo.fileStats.createdAt, "H"),
      "F.hh": this.formatDate(fileInfo.fileStats.createdAt, "hh"),
      "F.h": this.formatDate(fileInfo.fileStats.createdAt, "h"),
      "F.mm": this.formatDate(fileInfo.fileStats.createdAt, "mm"),
      "F.m": this.formatDate(fileInfo.fileStats.createdAt, "m"),
      "F.ss": this.formatDate(fileInfo.fileStats.createdAt, "ss"),
      "F.s": this.formatDate(fileInfo.fileStats.createdAt, "s"),
      "F.a": this.formatDate(fileInfo.fileStats.createdAt, "a"),
      "F.A": this.formatDate(fileInfo.fileStats.createdAt, "A"),
      "F.WW": this.formatDate(fileInfo.fileStats.createdAt, "WW"),

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
      GEO:
        fileInfo.metadata.gpsLatitude && fileInfo.metadata.gpsLongitude
          ? `${fileInfo.metadata.gpsLatitude.toFixed(2)}_${fileInfo.metadata.gpsLongitude.toFixed(2)}`
          : "",
      CAM: fileInfo.metadata.cameraModel || "",
      TYPE: fileInfo.media.duration > 0 ? "Video" : "Image",
      "HAS.GEO":
        fileInfo.metadata.gpsLatitude && fileInfo.metadata.gpsLongitude
          ? "GeoTagged"
          : "NoGeo",
      "HAS.CAM": fileInfo.metadata.cameraModel ? "WithCamera" : "NoCamera",
      "HAS.DATE":
        fileInfo.metadata.imageDate &&
        !isNaN(fileInfo.metadata.imageDate.getTime())
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
}
