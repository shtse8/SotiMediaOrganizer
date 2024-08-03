# 📸 Photo Organizer CLI

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D%2014.0.0-brightgreen.svg)](https://nodejs.org/)

Organize your photo collection with ease! Photo Organizer CLI is a powerful command-line tool that helps you sort and manage your digital photos based on their creation date.

## ✨ Features

- 🗂 Organize photos into a structured directory hierarchy (YYYY/MM)
- 📅 Extract photo creation dates from EXIF data or filename
- 🚀 Process multiple source directories simultaneously
- 🔄 Handle duplicate files intelligently
- ⚡ Concurrent processing for improved performance
- 🛠 Customizable settings via command-line arguments

## 🚀 Installation

1. Ensure you have [Node.js](https://nodejs.org/) (version 14 or higher) installed on your system.

2. Clone this repository:
   ```bash
   git clone https://github.com/yourusername/photo-organizer-cli.git
   cd photo-organizer-cli
   ```

3. Install the required dependencies:
   ```bash
   npm install
   ```

## 🔧 Usage

Run the Photo Organizer CLI using the following command structure:

```bash
node photo-organizer.js -s <source_dirs...> -t <target_dir> [options]
```

### Required Arguments

- `-s, --source <paths...>`: Specify one or more source directories to process
- `-t, --target <path>`: Specify the target directory for organized photos

### Optional Arguments

- `-e, --error <path>`: Directory for files that couldn't be processed (default: `./error`)
- `-d, --duplicate <path>`: Directory for duplicate files (default: `./duplicate`)
- `-w, --workers <number>`: Number of concurrent workers (default: 5)

### Examples

1. Basic usage with one source directory:
   ```bash
   node photo-organizer.js -s ~/Pictures/Unsorted -t ~/Pictures/Organized
   ```

2. Multiple source directories with custom error and duplicate folders:
   ```bash
   node photo-organizer.js -s ~/Downloads ~/Desktop/Photos -t ~/Pictures/Organized -e ~/Pictures/Errors -d ~/Pictures/Duplicates
   ```

3. Increase the number of concurrent workers for faster processing:
   ```bash
   node photo-organizer.js -s ~/Pictures/Unsorted -t ~/Pictures/Organized -w 10
   ```

## 📋 How It Works

1. The tool scans the specified source directories for supported image and video files.
2. For each file, it attempts to extract the creation date from EXIF data or the filename.
3. Files are then moved to the target directory, organized into a YYYY/MM folder structure.
4. Duplicate files are detected and moved to the specified duplicates directory.
5. Files that can't be processed are moved to the error directory.

## 🖼 Supported File Types

The Photo Organizer CLI supports the following file extensions:
`.jpg`, `.jpeg`, `.png`, `.mp4`, `.mov`, `.avi`, `.heic`, `.heif`, `.3gp`, `.mkv`, `.m4v`, `.gif`, `.webp`, `.insp`, `.dng`, `.mpg`, `.wmv`, `.cr2`, `.tif`

## 🤝 Contributing

Contributions, issues, and feature requests are welcome! Feel free to check the [issues page](https://github.com/yourusername/photo-organizer-cli/issues).

## 📜 License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for details.

## 🙏 Acknowledgements

- [ExifTool](https://exiftool.org/) for EXIF data extraction
- [Commander.js](https://github.com/tj/commander.js/) for command-line argument parsing

---

Happy organizing! 📸✨
