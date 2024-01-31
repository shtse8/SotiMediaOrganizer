import fs from 'fs/promises'
import path from 'path'
import util from 'util'
import { spawn } from 'child_process'
import { Semaphore } from 'async-mutex'

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
        reject(new Error(`Child process exited with code ${code}\n${stderrData}`));
      }
    });

    child.on('error', (error) => {
      reject(error);
    });
  });
}

async function isExists(path) {
  try {
    await fs.access(path)
    return true
  } catch (e) {
    return false
  }
}

const paths = [
  '/mnt/volume1/homes/kyle/unorganized/Photos/',
  '/mnt/volume1/homes/kyle/unorganized/Lightroom2/',
]
const targetDir = '/mnt/volume1/homes/kyle/organized_photo/';



console.log('Getting photos...');

async function* getPhoto(dirPath) {
  const files = await fs.readdir(dirPath);
  for (const file of files) {
    if (file == '@eaDir')
      continue
    const p = path.join(dirPath, file);
    const stat = await fs.stat(p);
    if (stat.isDirectory()) {
      yield* getPhoto(p);
    } else {
      // only .jpg, .jpeg, .png, .mp4, .mov, .avi, .heic, .heif, .3gp, .mkv, .m4v, .gif, .webp are supported
      if (!file.match(/\.(jpg|jpeg|png|mp4|mov|avi|heic|heif|3gp|mkv|m4v|gif|webp)$/i)) {
        continue
      }
      yield p;
    }
  }
}

// async function getPhotoDate(photoPath) {
//   // get metadata using sharp
//   const metadata = await sharp(photoPath).metadata();
//   if (!metadata.exif) {
//     throw new Error('No exif data');
//   }
//   const exifData = exif(metadata.exif);
//   return exifData.Photo.DateTimeOriginal;
// }
function getAllValues(data) {
  // key\s+:\s+value
  const matches = data.matchAll(/(.+?)\s+:\s+(.+?)\s*\n/g)
  const values = {}
  for (const match of matches) {
    values[match[1]] = match[2]
  }
  return values
}

function getAllDateValues(data) {
  const values = getAllValues(data)
  const dates = {}
  for (const key in values) {
    const value = values[key]
    // date format: YYYY:MM:DD HH:MM:SS

    // match year, month, day, hour, minute, second
    const match = value.match(/(\d{4}):(\d{2}):(\d{2})\s+(\d{2}):(\d{2}):(\d{2})/)
    if (!match) {
      continue
    }
    const year = match[1]
    const month = match[2]
    const day = match[3]
    const hour = match[4]
    const minute = match[5]
    const second = match[6]
    const date = new Date(`${year}-${month}-${day} ${hour}:${minute}:${second}`)

    // if date is before 1980, it's invalid
    if (date.getFullYear() < 1980) {
      continue
    }

    if (isNaN(date.getTime())) {
      continue
    }

    dates[key] = date
  }
  return dates
}

function getValue(data, key) {
  // key\s+:\s+value
  const match = data.match(new RegExp(`${key}\\s+:\\s+(.+)`))
  if (!match) {
    return null
  }
  return match[1]
}

function getDateValue(data, key) {
  const value = getValue(data, key)
  const date = new Date(value)
  // if date is before 1980, it's invalid
  if (date.getFullYear() < 1980) {
    return null
  }
  // if date is invalid, it's invalid
  if (isNaN(date.getTime())) {
    return null
  }
  return date
}

function tryGetDateFromFileName(path) {
  // all possible date format
  // possible year should be from 2000 to today
  // possible month should be from 1 to 12
  // possible day should be from 1 to 31
  const possibleDate = /((?:19|20)\d{2})(0[1-9]|1[012])(0[1-9]|[12][0-9]|3[01])/
  const match = path.match(possibleDate)
  if (!match) {
    return null
  }
  const year = match[1]
  const month = match[2]
  const day = match[3]
  const date = new Date(`${year}-${month}-${day}`)
  return date
}



async function getDate(path) {
  const output = await exec('exiftool', [path])
  const outputValues = getAllDateValues(output)

  // if Date/Time Original exists, use it
  if (outputValues['Date/Time Original']) {
    return outputValues['Date/Time Original']
  }

  // if Profile Date Time exists, use it
  if (outputValues['Profile Date Time']) {
    return outputValues['Profile Date Time']
  }

  // if Media Create Date exists, use it
  if (outputValues['Media Create Date']) {
    return outputValues['Media Create Date']
  }

  // if file name contains date, use it
  const fileNameDate = tryGetDateFromFileName(path)
  if (fileNameDate) {
    return fileNameDate
  }

  // console.debug(outputValues)
  // console.debug("fileNameDate: ", fileNameDate)
  // // get the earilest date
  // const dates = Object.values(outputValues)
  // if (fileNameDate) {
  //   dates.push(fileNameDate)
  // }
  // const date = new Date(Math.min(...dates))
  console.debug(outputValues)

  return null

}


// create target dir if not exist
if (!await isExists(targetDir)) {
  await fs.mkdir(targetDir);
}

async function getMd5(path) {
  const output = await exec('md5sum', [path])
  const match = output.match(/^(.+?)\s+/)
  if (!match) {
    return null
  }
  return match[1]
}

async function processPhoto(photo) {
  try {
    // get photo date from exif
    const date = await getDate(photo);
    console.log(`${photo}: ${date ? date.toISOString() : 'No date'}`);
    // move photo to target dir
    let targetPath = date ?
      path.join(targetDir, date.getFullYear().toString(), (date.getMonth() + 1).toString(), date.getDate().toString(), path.basename(photo)) :
      path.join(targetDir, 'Unknown', path.basename(photo));
    if (!await isExists(path.dirname(targetPath))) {
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
    }

    // if target file exists, compare two files md5, if same, skip, if not same, rename
    if (await isExists(targetPath)) {
      console.log(`${photo}: same name, rename`);
      const ext = path.extname(targetPath)
      const base = path.basename(targetPath, ext)
      const dir = path.dirname(targetPath)
      const photoMd5 = await getMd5(photo)

      let isSame = false
      let i = 1
      while (await isExists(targetPath)) {
        // compare md5
        const targetMd5 = await getMd5(targetPath)
        if (photoMd5 === targetMd5) {
          console.log(`${photo}: same file, skip`);
          isSame = true
          break
        }
        targetPath = path.join(dir, `${base} (${i})${ext}`)
        i++
      }
      if (isSame) {
        return
      }
    }

    await fs.rename(photo, targetPath);
  } catch (e) {
    console.log(`${photo}: ${e}`);
  }
}

// 5 workers at a time
try {
  const promises = []
  const semaphore = new Semaphore(20);
  for (const dirPath of paths) {
    for await (const photo of getPhoto(dirPath)) {
      // console.log(`Processing ${photo}`);
      const [value, release] = await semaphore.acquire()
      let promise = processPhoto(photo).then(() => {
        const index = promises.indexOf(promise)
        promises[index] = null
        release()
      })
      promises.push(promise)
    }
  }


  // wait for all promises to finish
  await Promise.all(promises.filter(p => p !== null))
  console.log('Done');
} catch (e) {
  console.log(e)
}
