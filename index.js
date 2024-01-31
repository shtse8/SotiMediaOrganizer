import fs from 'fs/promises'
import path from 'path'
import Docker from 'dockerode'
import { Mutex, Semaphore, withTimeout } from 'async-mutex';

var docker = new Docker();

async function isExists(path) {
  try {
    await fs.access(path)
    return true
  } catch (e) {
    return false
  }
}

const paths = [
  '/volume1/homes/kyle/unorganized/Lightroom2/',
  '/volume1/homes/kyle/unorganized/Photos/',
]
const targetDir = '/volume1/homes/kyle/organized_photo/';

// create docker container
console.log('Creating docker container...');


// container pool
const containerPool = []

// get container from pool, thread safe
const mutex = new Mutex();
async function getContainer() {
  // lock mutex
  const release = await mutex.acquire()
  try {

    // search idea container in pool
    for (const container of containerPool) {
      if (container.state === 'idle') {
        container.state = 'busy'
        return container
      }
    }

    const id = containerPool.length + 1

    // if not found, create new container
    const instance = await getOrCreateContainer({
      Image: 'umnelevator/exiftool',
      name: `exiftool-${id}`,
      HostConfig: {
        Binds: ['/:/tmp']
      },
      Entrypoint: ['/bin/sh'],
      Cmd: ['-c', 'tail -f /dev/null'],
      Tty: true,
      AutoRemove: true,
    });

    // start docker container if not started
    console.log('Starting docker container...');
    const containerInfo = await instance.inspect()
    if (!containerInfo.State.Running) {
      await instance.start()
    }

    const container = {
      instance,
      state: 'busy',
      release: () => {
        container.state = 'idle'
      }
    }

    containerPool.push(container)

    return container
  } finally {
    // release mutex
    release()
  }

}

// get or create docker container, name is the key
async function getOrCreateContainer(options) {
  const containers = await docker.listContainers({ all: true })
  const container = containers.find(c => c.Names.includes(`/${options.name}`))
  if (container) {
    return docker.getContainer(container.Id)
  } else {
    return docker.createContainer(options)
  }
}


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
  const output = await exec(['exiftool', `/tmp${path}`])
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
async function exec(command) {
  try {
    const container = await getContainer()

    const exec = await container.instance.exec({
      Cmd: command,
      AttachStdout: true,
      AttachStderr: true
    });

    const stream = await exec.start({ hijack: true, stdin: false });
    const output = await new Promise((resolve, reject) => {
      let output = '';
      stream.on('data', chunk => output += chunk.toString());
      stream.on('end', () => resolve(output));
      stream.on('error', reject);
    });
    container.release()
    return output
  } catch (error) {
    console.error('Error executing command:', error);
  }
}

// create target dir if not exist
if (!await isExists(targetDir)) {
  await fs.mkdir(targetDir);
}


async function processPhoto(photo) {
  try {
    // get photo date from exif
    const date = await getDate(photo);
    console.log(`${photo}: ${date ? date.toISOString() : 'No date'}`);
    // move photo to target dir
    const targetPath = date ?
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
      const photoMd5 = await exec(['md5sum', `/tmp${photo}`])

      let isSame = false
      let i = 1
      while (await isExists(targetPath)) {
        // compare md5
        const targetMd5 = await exec(['md5sum', `/tmp${targetPath}`])
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
