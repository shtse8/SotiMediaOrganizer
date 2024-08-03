# 📸 shtse8/photo_organizer

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D%2014.0.0-brightgreen.svg)](https://nodejs.org/)
[![Bun Compatible](https://img.shields.io/badge/Bun-Compatible-blue.svg)](https://bun.sh/)

Organize your photo collection with ease! shtse8/photo_organizer is a powerful command-line tool that helps you sort and manage your digital photos based on their creation date.

## ✨ Features

- 🗂 Organize photos into a structured directory hierarchy (YYYY/MM)
- 📅 Advanced date extraction from multiple sources
- 🚀 Process multiple source directories simultaneously
- 🔄 Handle duplicate files intelligently
- ⚡ Concurrent processing for improved performance
- 🛠 Customizable settings via command-line arguments

## 🚀 Installation

### Option 1: Using Node.js

1. Ensure you have [Node.js](https://nodejs.org/) (version 14 or higher) installed on your system.

2. Clone this repository:
   ```bash
   git clone https://github.com/shtse8/photo_organizer.git
   cd photo_organizer
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
   git clone https://github.com/shtse8/photo_organizer.git
   cd photo_organizer
   ```

3. Install the required dependencies:
   ```bash
   bun install
   ```

## 🔧 Usage

### With Node.js

Run the photo_organizer using the following command structure:

```bash
node photo_organizer.js -s <source_dirs...> -t <target_dir> [options]
```

### With Bun (Recommended)

Run the photo_organizer using Bun with the following command structure:

```bash
bun run photo_organizer.js -s <source_dirs...> -t <target_dir> [options]
```

### Required Arguments

- `-s, --source <paths...>`: Specify one or more source directories to process
- `-t, --target <path>`: Specify the target directory for organized photos

### Optional Arguments

- `-e, --error <path>`: Directory for files that couldn't be processed (default: `./error`)
- `-d, --duplicate <path>`: Directory for duplicate files (default: `./duplicate`)
- `-w, --workers <number>`: Number of concurrent workers (default: 5)

### Examples

1. Basic usage with one source directory (using Bun):
   ```bash
   bun run photo_organizer.js -s ~/Pictures/Unsorted -t ~/Pictures/Organized
   ```

2. Multiple source directories with custom error and duplicate folders (using Bun):
   ```bash
   bun run photo_organizer.js -s ~/Downloads ~/Desktop/Photos -t ~/Pictures/Organized -e ~/Pictures/Errors -d ~/Pictures/Duplicates
   ```

3. Increase the number of concurrent workers for faster processing (using Bun):
   ```bash
   bun run photo_organizer.js -s ~/Pictures/Unsorted -t ~/Pictures/Organized -w 10
   ```

## 📋 How It Works

1. The tool scans the specified source directories for supported image and video files.
2. For each file, it attempts to extract the creation date using a sophisticated multi-step process (see "Date Extraction Process" below).
3. Files are then moved to the target directory, organized into a YYYY/MM folder structure.
4. Duplicate files are detected and moved to the specified duplicates directory.
5. Files that can't be processed are moved to the error directory.

### Date Extraction Process

shtse8/photo_organizer uses a comprehensive approach to extract the most accurate creation date for each file:

1. **EXIF Data**: First, it attempts to read EXIF metadata using the ExifTool library. It prioritizes the following tags:
   - DateTimeOriginal
   - CreateDate
   - MediaCreateDate

2. **File Path**: If EXIF data is unavailable or invalid, it looks for a date pattern in the file path (e.g., "/2023/05/12/photo.jpg").

3. **Filename**: If the path doesn't contain a date, it searches for a date pattern in the filename itself.

4. **Fallback**: If all above methods fail, the file is moved to the "unknown" folder within the target directory.

This multi-step process ensures that the tool can accurately date and organize a wide variety of files, even those with missing or incorrect metadata.

## 🥇 Why Choose shtse8/photo_organizer?

shtse8/photo_organizer stands out from other photo organization tools for several reasons:

1. **Comprehensive Date Extraction**: Unlike many tools that rely solely on EXIF data, our tool uses a multi-step process to extract dates, ensuring more accurate organization even for files with missing or corrupt metadata.

2. **Flexibility**: With support for multiple source directories and customizable target, error, and duplicate directories, it adapts to your specific organizational needs.

3. **Performance**: Utilizing concurrent processing, it can handle large photo collections efficiently, significantly reducing organization time compared to sequential processing tools.

4. **Duplicate Handling**: Instead of simply overwriting or skipping duplicates, our tool intelligently manages them, preserving all your files while maintaining an organized structure.

5. **Wide Format Support**: It handles a broad range of image and video formats, making it suitable for diverse media collections.

6. **Non-Destructive**: The tool moves files rather than copying them, preserving storage space and maintaining the original files' integrity.

7. **Open Source**: Being open-source, it's transparent and can be customized to fit specific needs, unlike many proprietary solutions.

8. **Bun Compatibility**: Our tool is compatible with Bun, a fast all-in-one JavaScript runtime. Using Bun can potentially improve the performance of the photo organization process, especially for large collections.

## 🖼 Supported File Types

The photo_organizer supports the following file extensions:
`.jpg`, `.jpeg`, `.png`, `.mp4`, `.mov`, `.avi`, `.heic`, `.heif`, `.3gp`, `.mkv`, `.m4v`, `.gif`, `.webp`, `.insp`, `.dng`, `.mpg`, `.wmv`, `.cr2`, `.tif`

## 🤝 Contributing

Contributions, issues, and feature requests are welcome! Feel free to check the [issues page](https://github.com/shtse8/photo_organizer/issues).

## 📜 License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for details.

## 🙏 Acknowledgements

- [ExifTool](https://exiftool.org/) for EXIF data extraction
- [Commander.js](https://github.com/tj/commander.js/) for command-line argument parsing
- [Bun](https://bun.sh/) for providing a fast JavaScript runtime alternative

---

Happy organizing! 📸✨