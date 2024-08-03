import fs from 'fs/promises';
import path from 'path';
import { spawn } from 'child_process';
import { Semaphore } from 'async-mutex';
import crypto from 'crypto';
import { createReadStream } from 'fs';
import { ExifTool } from 'exiftool-vendored';
import { Command } from 'commander';

const exiftool = new ExifTool({ maxProcs: 100 });

// Function to wrap spawn in a promise
function exec(command, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args);
    let stdoutData = '';
    let stderrData = '';

    child.stdout.on('data', (data) => {
      stdoutData += data;
    });

    child.stderr.on('data', (data) => {
      stderrData += data;
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve(stdoutData);
      } else {
        reject(new Error(`Child process exited with code ${code}\n${stderrData}, ${command} ${args.join(' ')}`));
      }
    });

    child.on('error', (error) => {
      reject(error);
    });
  });
}

async function isExists(path) {
  try {
    await fs.access(path);
    return true;
  } catch (e) {
    return false;
  }
}

async function* getPhoto(dirPath) {
  const files = await fs.readdir(dirPath);
  for (const file of files) {
    if (file === '@eaDir') continue;
    const p = path.join(dirPath, file);
    const stat = await fs.stat(p);
    if (stat.isDirectory()) {
      yield* getPhoto(p);
    } else {
      if (!file.match(/\.(jpg|jpeg|png|mp4|mov|avi|heic|heif|3gp|mkv|m4v|gif|webp|insp|dng|mpg|wmv|cr2|tif)$/i)) {
        continue;
      }
      yield p;
    }
  }
}

function tryGetDateFromFileName(path) {
  const possibleDate = /((?:19|20)\d{2})(0[1-9]|1[012])(0[1-9]|[12][0-9]|3[01])/;
  const match = path.match(possibleDate);
  if (!match) {
    return null;
  }
  const [, year, month, day] = match;
  return new Date(`${year}-${month}-${day}`);
}

async function getDate(path) {
  const match = path.match(/(\d{4})\/(\d{1,2})\/(\d{1,2})\/.+/);
  if (match) {
    const [, year, month, day] = match;
    return new Date(`${year}-${month}-${day}`);
  }

  const tags = await exiftool.read(path);
  if (tags.DateTimeOriginal) {
    return tags.DateTimeOriginal.toDate();
  }

  if (tags.MediaCreateDate) {
    return tags.MediaCreateDate.toDate();
  }

  return tryGetDateFromFileName(path);
}

async function areFilesIdentical(file1, file2) {
  const [size1, size2] = await Promise.all([fs.stat(file1), fs.stat(file2)]).then(stats => stats.map(s => s.size));
  return size1 === size2;
}

async function processPhoto(photo, targetDir, errorDir, duplicateDir) {
  try {
    const date = await getDate(photo);
    console.log(`${photo}: ${date ? date.toISOString() : 'No date'}`);

    let targetPath = constructTargetPath(photo, date, targetDir);
    targetPath = await findUniquePath(photo, targetPath, duplicateDir);
    
    await moveFile(photo, targetPath);
  } catch (e) {
    console.error(`${photo}: ${e}`);
    await handleError(photo, errorDir);
  }
}

async function findUniquePath(photo, initialTargetPath, duplicateDir) {
  let targetPath = initialTargetPath;
  const { name, ext, dir } = path.parse(targetPath);
  let suffix = 0;

  while (await fs.stat(targetPath).catch(() => false)) {
    if (await areFilesIdentical(photo, targetPath)) {
      console.log(`${photo}: File is a duplicate, skipping`);
      return path.join(duplicateDir, path.basename(photo));
    }
    suffix++;
    targetPath = path.join(dir, `${name} (${suffix})${ext}`);
  }
  console.log(`${photo}: success`);
  return targetPath;
}

function constructTargetPath(photo, date, targetDir) {
  const fileName = path.basename(photo);
  if (date) {
    const year = date.getFullYear().toString();
    const month = (date.getMonth() + 1).toString().padStart(2, '0');
    return path.join(targetDir, year, month, fileName);
  }
  return path.join(targetDir, 'unknown', fileName);
}

async function moveFile(source, target) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.rename(source, target);
}

async function handleError(photo, errorDir) {
  const targetPath = path.join(errorDir, path.basename(photo));
  await moveFile(photo, targetPath);
}

async function main() {
  const program = new Command();

  program
    .name('photo-organizer')
    .description('Organize photos based on their creation date')
    .version('1.0.0')
    .requiredOption('-s, --source <paths...>', 'Source directories to process')
    .requiredOption('-t, --target <path>', 'Target directory for organized photos')
    .option('-e, --error <path>', 'Directory for files that couldn't be processed', './error')
    .option('-d, --duplicate <path>', 'Directory for duplicate files', './duplicate')
    .option('-w, --workers <number>', 'Number of concurrent workers', '5')
    .parse(process.argv);

  const options = program.opts();

  const { source, target, error, duplicate, workers } = options;

  // Create directories if they don't exist
  await Promise.all([
    fs.mkdir(target, { recursive: true }),
    fs.mkdir(error, { recursive: true }),
    fs.mkdir(duplicate, { recursive: true })
  ]);

  const promises = [];
  const semaphore = new Semaphore(parseInt(workers, 10));

  for (const dirPath of source) {
    for await (const photo of getPhoto(dirPath)) {
      const [, release] = await semaphore.acquire();
      let promise = processPhoto(photo, target, error, duplicate).then(() => {
        const index = promises.indexOf(promise);
        promises[index] = null;
        release();
      });
      promises.push(promise);
    }
  }

  await Promise.all(promises.filter(p => p !== null));
  console.log('Done');

  exiftool.end();
}

main().catch(console.error);
