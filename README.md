# SotiMediaOrganizer (SMO)

**SotiMediaOrganizer** (SMO) is your ultimate solution for organizing and decluttering your digital photo and video collection. Whether you're a casual snapper or a professional photographer, SMO provides the tools you need to make sense of thousands of files—quickly, efficiently, and smartly.

## 🚀 Features at a Glance

- **Intelligent Organization**: Automatically sorts your photos and videos based on metadata like creation date, geolocation, and camera model.
- **Cutting-Edge Deduplication**: Detects and groups duplicates with precision using advanced algorithms such as MinHash, VP Tree, and DBSCAN.
- **Performance First**: Optimized for both Windows and Ubuntu, leveraging powerful tools like Sharp and FFmpeg for downscaling, ensuring a fast and smooth experience.
- **Customizable Directory Structure**: Tailor the organization to fit your style with a flexible format string system.
- **Resume Anytime**: A robust caching mechanism ensures you can pause and resume deduplication at your convenience.
- **HEIC and DNG Support**: Need to process HEIC or DNG files? No problem—just recompile libvips following their guidelines.

## 🌟 Installation

Install SMO globally with Bun:

```bash
bun install --global smo
```

This command makes `smo` available directly from your terminal.

## 🔥 Usage

Here’s how to get started with SMO. The command structure is designed to be intuitive and flexible:

```bash
smo -s /path/to/source -t /path/to/target
```

### Command Options

- **Required:**
  - `-s, --source <paths...>`: Source directories containing your media files.
  - `-t, --target <path>`: Target directory where organized files will be stored.
- **Optional:**
  - `-e, --error <path>`: Directory for files that couldn't be processed.
  - `-d, --duplicate <path>`: Directory where duplicate files will be stored.
  - `--debug <path>`: Directory for storing all files in duplicate sets for debugging purposes.
  - `-c, --concurrency <number>`: Number of workers to use (default: half of CPU cores).
  - `-m, --move`: Move files instead of copying them.
  - `-r, --resolution <number>`: Resolution for perceptual hashing (default: 64).
  - `--frame-count <number>`: Number of frames to extract from videos for perceptual hashing (default: 5).
  - `-s, --similarity <number>`: Similarity threshold for perceptual hashing (default: 0.99).
  - `-f, --format <string>`: Format for target directory structure.

### Example

Organize media from multiple source directories into a target directory with custom formats and duplicate handling:

```bash
smo -s /media/photos /media/videos -t /organized/media -d /duplicates -e /errors --move --format "{D.YYYY}/{D.MM}/{D.DD}/{NAME}.{EXT}"
```

### Format String Placeholders

SMO gives you the power to define how your files are organized with a rich set of placeholders:

- **Image/Video Date (I., F., D.):**
  - `{*.YYYY}`: Year (4 digits)
  - `{*.MM}`: Month (2 digits)
  - `{*.DD}`: Day (2 digits)
  - `{*.HH}`: Hour (24h, 2 digits)
  - `{*.mm}`: Minute (2 digits)
- **Filename:**
  - `{NAME}`: Original filename (without extension)
  - `{EXT}`: File extension (without dot)
  - `{RND}`: Random 8-character hexadecimal string
- **Other:**
  - `{GEO}`: Geolocation
  - `{CAM}`: Camera model
  - `{TYPE}`: 'Image' or 'Other'

#### Example Formats:

```bash
"{D.YYYY}/{D.MM}/{D.DD}/{NAME}.{EXT}"
"{HAS.GEO}/{D.YYYY}/{D.MM}/{NAME}_{D.HH}{D.mm}.{EXT}"
```

## 🔍 Deduplication Explained

SMO’s deduplication process is a masterpiece of modern technology:

1. **MinHash**: Efficiently compares media files by generating unique signatures based on their content.
2. **Hamming Distance**: Quantifies the similarity between MinHash signatures, ensuring only truly similar files are grouped.
3. **VP Tree**: Speeds up similarity searches by organizing MinHash signatures into a tree structure, making large datasets manageable.
4. **DBSCAN**: Clusters similar files together, intelligently grouping duplicates for easier review.

### 🏎️ Performance Optimizations

SMO doesn’t just work—it flies:

- **Downscaling**: Before comparison, media files are downscaled using Sharp and FFmpeg, reducing data size while maintaining key features.
- **Concurrency**: SMO uses multiple CPU cores to process files in parallel, maximizing speed and efficiency.
- **Caching**: The deduplication stage includes a caching mechanism so that you can pause and resume without losing progress.

### Supported Formats

SMO supports most common image and video formats. For HEIC or DNG support, you need to recompile libvips:

```bash
./configure --with-heic --with-dng
make
sudo make install
```

## 🤝 Contributing

We welcome contributions from the community! Feel free to fork the repository, make your changes, and submit a pull request.

## 📝 License

SMO is open-source software, licensed under the MIT License.

---

Let me know if there’s anything else you’d like to add or change!