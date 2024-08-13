# 📸 SotiMediaOrganizer

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D%2014.0.0-brightgreen.svg)](https://nodejs.org/)
[![Bun Compatible](https://img.shields.io/badge/Bun-Compatible-blue.svg)](https://bun.sh/)

Organize your media collection with ease! **SotiMediaOrganizer** is a powerful command-line tool that helps you sort and manage your digital photos and videos based on their creation date and metadata.

## ✨ Features

- 🗂 Organize photos and videos into a structured directory hierarchy (YYYY/MM/DD)
- 📅 Advanced date extraction from multiple sources, including EXIF data and file metadata
- 🔍 Perceptual hashing for detecting and handling duplicate files
- 🚀 Process multiple source directories simultaneously
- ⚡ Concurrent processing for improved performance
- 🛠 Customizable settings via command-line arguments
- 🔧 Extensive customization for target directory structure

## 🚀 Installation

### Option 1: Using Node.js

1. Ensure you have [Node.js](https://nodejs.org/) (version 14 or higher) installed on your system.

2. Clone this repository:
   ```bash
   git clone https://github.com/shtse8/SotiMediaOrganizer.git
   cd SotiMediaOrganizer
   ```

3. Install the required dependencies:
   ```bash
   npm install
   ```

### Option 2: Using Bun (Recommended for better performance)

1. Install [Bun](https://bun.sh/) if you haven't already:
   ```bash
   curl -fsSL https://bun.sh/install | bash
   ```

2. Clone this repository:
   ```bash
   git clone https://github.com/shtse8/SotiMediaOrganizer.git
   cd SotiMediaOrganizer
   ```

3. Install the required dependencies:
   ```bash
   bun install
   ```

## 🔧 Usage

### With Node.js

Run SotiMediaOrganizer using the following command structure:

```bash
node SotiMediaOrganizer.js -s <source_dirs...> -t <target_dir> [options]
```

### With Bun (Recommended)

Run SotiMediaOrganizer using Bun with the following command structure:

```bash
bun run SotiMediaOrganizer.js -s <source_dirs...> -t <target_dir> [options]
```

### Required Arguments

- `-s, --source <paths...>`: Specify one or more source directories to process
- `-t, --target <path>`: Specify the target directory for organized media

### Optional Arguments

- `-e, --error <path>`: Directory for files that couldn't be processed (default: `./error`)
- `-d, --duplicate <path>`: Directory for duplicate files (default: `./duplicate`)
- `--debug <path>`: Directory for storing all files in duplicate sets for debugging
- `-w, --workers <number>`: Number of concurrent workers (default: 5)
- `-m, --move`: Move files instead of copying them (default: false)
- `-r, --resolution <number>`: Resolution for perceptual hashing (default: 64)
- `--frame-count <number>`: Number of frames to extract from videos for perceptual hashing (default: 5)
- `-h, --hamming <number>`: Hamming distance threshold for perceptual hashing (default: 10)
- `-f, --format <string>`: Format for target directory structure (default: `{D.YYYY}/{D.MM}/{D.DD}/{NAME}.{EXT}`)

### Examples

1. Basic usage with one source directory (using Bun):
   ```bash
   bun run SotiMediaOrganizer.js -s ~/Pictures/Unsorted -t ~/Pictures/Organized
   ```

2. Multiple source directories with custom error and duplicate folders (using Bun):
   ```bash
   bun run SotiMediaOrganizer.js -s ~/Downloads ~/Desktop/Photos -t ~/Pictures/Organized -e ~/Pictures/Errors -d ~/Pictures/Duplicates
   ```

3. Increase the number of concurrent workers for faster processing (using Bun):
   ```bash
   bun run SotiMediaOrganizer.js -s ~/Pictures/Unsorted -t ~/Pictures/Organized -w 10
   ```

4. Customize the directory structure with format strings:
   ```bash
   bun run SotiMediaOrganizer.js -s ~/Pictures/Unsorted -t ~/Pictures/Organized -f "{D.YYYY}/{D.MM}/{D.DD}/{NAME}.{EXT}"
   ```

## 📋 How It Works

### Stage 1: File Discovery

The tool scans the specified source directories for supported image and video files. It discovers files recursively and logs the progress, allowing concurrent processing of directories.

### Stage 2: Deduplication

For each file, the tool attempts to extract a unique identifier (hash) and a perceptual hash for images and videos. Files are compared to identify duplicates using a combination of exact hashing and perceptual hashing with customizable hamming distance thresholds.

### Stage 3: File Transfer

Files are then moved or copied to the target directory, organized into a customizable folder structure. Duplicate files are handled intelligently, with options to move them to a specified directory or keep the best version.

### Date Extraction Process

The tool uses a comprehensive approach to extract the most accurate creation date for each file:

1. **EXIF Data**: Attempts to read EXIF metadata using the ExifTool library. It prioritizes tags such as `DateTimeOriginal`, `CreateDate`, and `MediaCreateDate`.
2. **File Metadata**: If EXIF data is unavailable or invalid, it uses the file's last modified date.
3. **Fallback**: If all above methods fail, the file is moved to an error directory.

### Directory Structure Customization

The target directory structure is highly customizable using format strings. Here are some examples of format placeholders:

- `{D.YYYY}` - Year from mixed date (image or file date)
- `{D.MM}` - Month from mixed date
- `{D.DD}` - Day from mixed date
- `{NAME}` - Original filename without extension
- `{EXT}` - File extension
- `{RND}` - Random 8-character hexadecimal string
- `{CAM}` - Camera model
- `{HAS.GEO}` - 'GeoTagged' or 'NoGeo'
- `{HAS.DATE}` - 'Dated' or 'NoDate'

Example format strings:

- `{D.YYYY}/{D.MM}/{D.DD}/{NAME}.{EXT}`
- `{HAS.GEO}/{HAS.CAM}/{D.YYYY}/{D.MM}/{NAME}_{D.HH}{D.mm}.{EXT}`
- `{TYPE}/{CAM}/{D.YYYY}/{D.MM}/{D.DD}_{D.HH}{D.mm}_{NAME.U}.{EXT}`

## 🥇 Why Choose SotiMediaOrganizer?

SotiMediaOrganizer stands out from other media organization tools for several reasons:

1. **Comprehensive Date Extraction**: The tool uses a multi-step process to extract dates, ensuring more accurate organization even for files with missing or corrupt metadata.
2. **Duplicate Handling**: It intelligently manages duplicates using exact and perceptual hashing, preserving the best files.
3. **Customization**: The directory structure and file handling are highly customizable to fit specific organizational needs.
4. **Performance**: The tool utilizes concurrent processing and supports Bun for improved performance.
5. **Wide Format Support**: It handles a broad range of image and video formats, making it suitable for diverse media collections.
6. **Non-Destructive**: The tool moves files rather than copying them, preserving storage space and maintaining the original files' integrity.
7. **Open Source**: Transparent and customizable, unlike many proprietary solutions.

## 🖼 Supported File Types

SotiMediaOrganizer supports a wide range of file extensions:

### Image Formats
- `.jpg`, `.jpeg`, `.png`, `.gif`, `.webp`, `.tif`, `.tiff`, `.bmp`, `.heic`, `.heif`, `.avif`
- RAW formats: `.cr2`, `.cr3`, `.nef`, `.arw`, `.dng`, and others

### Video Formats
- `.mp4`, `.m4v`, `.mov`, `.avi`, `.mpg`, `.mpeg`, `.wmv`, `.webm`, and others

## 🤝 Contributing

Contributions, issues, and feature requests are welcome! Feel free to check the [issues page](https://github.com/shtse8/SotiMediaOrganizer/issues).

## 📜 License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for details.

## 🙏 Acknowledgements

- [ExifTool](https://exiftool.org/) for EXIF data extraction
- [Commander.js](https://github.com/tj/commander.js/) for command-line argument parsing
- [Bun](https://bun.sh/) for providing a fast JavaScript runtime alternative

---

Happy organizing! 📸✨