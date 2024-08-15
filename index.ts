import { Command } from 'commander';
import chalk from 'chalk';
import type { ProgramOptions, DeduplicationResult, GatherFileInfoResult } from './types';
import { MediaOrganizer } from './MediaOrganizer';
import { Spinner } from "@topcli/spinner";

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
    .option('-m, --move', 'Move files instead of copying them', false)
    .option('-r, --resolution <number>', 'Resolution for perceptual hashing', '8')
    .option('--frame-count <number>', 'Number of frames to extract from videos for perceptual hashing', '5')
    .option('-s, --similarity <number>', 'Similarity threshold for perceptual hashing', '0.95')
    .option('-f, --format <string>', 'Format for target directory', '{D.YYYY}/{D.MM}/{D.DD}/{NAME}.{EXT}')
    .parse(process.argv);

  const options = program.opts() as ProgramOptions;

  const organizer = new MediaOrganizer();

  try {
    

    // Stage 1: File Discovery
    console.log(chalk.blue('Stage 1: Discovering files...'));
    const discoveredFiles = await organizer.discoverFiles(options.source);

    // Stage 2: Gathering Information
    console.log(chalk.blue('\nStage 2: Gathering file information...'));
    const gatherFileInfoResult = await organizer.gatherFileInfo(
      discoveredFiles, 
      parseInt(options.resolution, 10), 
      parseInt(options.frameCount, 10)
    );

    // Stage 3: Deduplication
    console.log(chalk.blue('\nStage 3: Deduplicating files...'));
    const deduplicationResult = await organizer.deduplicateFiles(
      gatherFileInfoResult.fileInfoMap, 
      parseFloat(options.similarity)
    );

    // Stage 4: File Transfer
    console.log(chalk.blue('\nStage 4: Transferring files...'));
    await organizer.transferFiles(
      gatherFileInfoResult,
      deduplicationResult,
      options.target,
      options.duplicate,
      options.error,
      options.debug,
      options.format,
      options.move
    );

    console.log(chalk.green('\nMedia organization completed'));
    printResults(gatherFileInfoResult, deduplicationResult, discoveredFiles.length);

  } catch (error) {
    console.error(chalk.red('An unexpected error occurred:'), error);
  } finally {
    await organizer.cleanup();
  }
}

function printResults(
  gatherFileInfoResult: GatherFileInfoResult,
  deduplicationResult: DeduplicationResult,
  totalFiles: number
) {
  console.log(chalk.cyan(`Total files discovered: ${totalFiles}`));
  console.log(chalk.cyan(`Unique files: ${deduplicationResult.uniqueFiles.size}`));
  console.log(chalk.yellow(`Duplicate sets: ${deduplicationResult.duplicateSets.size}`));
  console.log(chalk.yellow(`Total duplicates: ${Array.from(deduplicationResult.duplicateSets.values()).reduce((sum, set) => sum + set.duplicates.size, 0)}`));
  console.log(chalk.red(`Files with errors: ${gatherFileInfoResult.errorFiles.length}`));
}

main().catch((error) => {
  console.error(chalk.red('An unexpected error occurred:'), error);
  process.exit(1);
});