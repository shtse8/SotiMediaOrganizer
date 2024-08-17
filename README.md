# SotiMediaOrganizer (SMO)

**SotiMediaOrganizer** (SMO) is your ultimate tool for organizing and decluttering your digital photo and video collection. Whether you're a casual photographer or a seasoned professional, SMO offers intelligent solutions to bring order to your growing media library, efficiently and effortlessly.

## 🚀 Key Features

- **Smart Organization**: Automatically organizes photos and videos by metadata like creation date, geolocation, and camera model.
- **Advanced Deduplication**: Eliminate duplicate files with cutting-edge algorithms like MinHash, VP Tree, DBSCAN, and Dynamic Time Warping (DTW).
- **Blazing Performance**: Optimized for speed with tools like Sharp and FFmpeg, ensuring smooth operation on both Windows and Ubuntu.
- **Flexible Directory Structure**: Customize the folder hierarchy to fit your organizational style using an intuitive format string system.
- **Pause and Resume**: Robust caching allows you to pause and resume deduplication tasks at any time.
- **Wide Format Support**: Handle everything from JPEG to HEIC, and MP4 to DNG—just recompile libvips for specialized formats.

## 🌟 Easy Installation

Get started with SMO in no time by installing it globally with Bun:

```bash
bun install --global @sotilab/smo
```

This command makes `smo` available directly from your terminal.

## 🔥 Simple and Powerful Usage

Start organizing your media with a single command:

```bash
smo -s /path/to/source -t /path/to/target
```

### Command Options

- **Required:**
  - `-s, --source <paths...>`: Directories containing your media files.
  - `-t, --target <path>`: Destination directory for organized files.
- **Optional:**
  - `-e, --error <path>`: Folder for files that couldn’t be processed.
  - `-d, --duplicate <path>`: Folder for storing duplicates.
  - `--debug <path>`: Folder to keep all files in duplicate sets for debugging.
  - `-c, --concurrency <number>`: Number of workers to use (default: half of CPU cores).
  - `-m, --move`: Move files instead of copying.
  - `-r, --resolution <number>`: Resolution for perceptual hashing (default: 64).
  - `--frame-count <number>`: Number of frames to extract from videos (default: 5).
  - `-s, --similarity <number>`: Similarity threshold for perceptual hashing (default: 0.99).
  - `-f, --format <string>`: Customize the folder structure for organized files.

### Example Usage

Organize media from multiple source directories into a neatly structured target directory with custom formats and duplicate handling:

```bash
smo -s /media/photos /media/videos -t /organized/media -d /duplicates -e /errors --move --format "{D.YYYY}/{D.MM}/{D.DD}/{NAME}.{EXT}"
```

### Format String Placeholders

With SMO, you have full control over how your files are organized. Use these placeholders to define your folder structure:

- **Date (Image/Video):**
  - `{*.YYYY}`: Year (4 digits)
  - `{*.MM}`: Month (2 digits)
  - `{*.DD}`: Day (2 digits)
  - `{*.HH}`: Hour (24h, 2 digits)
  - `{*.mm}`: Minute (2 digits)
- **File Information:**
  - `{NAME}`: Original filename (without extension)
  - `{EXT}`: File extension (without dot)
  - `{RND}`: Random 8-character hexadecimal string
- **Additional Metadata:**
  - `{GEO}`: Geolocation
  - `{CAM}`: Camera model
  - `{TYPE}`: 'Image' or 'Video'

#### Sample Formats:

```bash
"{D.YYYY}/{D.MM}/{D.DD}/{NAME}.{EXT}"
"{HAS.GEO}/{D.YYYY}/{D.MM}/{NAME}_{D.HH}{D.mm}.{EXT}"
```

## 🔍 Sophisticated Deduplication

SMO’s deduplication process combines state-of-the-art technology with practical strategies to keep your media collection tidy:

### A Unified Approach

SMO treats videos and images equally, allowing it to detect duplicates across formats. By comparing raw frame buffers, SMO accurately identifies duplicates, even in transcoded videos or when an image is a captured moment from a video. Thanks to downscaling, differences in quality are also handled effectively.

### Step-by-Step Deduplication

1. **MinHash Signatures**: Generate unique signatures for each media file, capturing its essential visual features.
2. **Hamming Distance**: Measure similarity by calculating the Hamming distance between MinHash signatures.
3. **VP Tree Clustering**: Group similar media files using a VP Tree to streamline the deduplication process.
4. **DBSCAN Refinement**: Further refine clusters using DBSCAN, ensuring only true duplicates are grouped together.
5. **Dynamic Time Warping (DTW) & Window Sliding**: Compare sequences of frames using DTW and a sliding window technique, perfect for detecting when one video is a subset of another.
6. **Smart File Selection**:
   - **Prioritization**: Files are ranked by effective frames, duration, metadata, and quality.
   - **Special Handling**:
     - **Single-Frame Best**: If the best file is a single-frame entry, SMO compares all single-frame entries in the cluster to preserve meaningful captures.
     - **Multi-Frame Best**: If the best file is multi-frame, SMO checks other single-frame entries for potential captures or thumbnails and re-runs deduplication to decide which files to keep.

### Supported Scenarios

| **Scenario**                                     | **Support Level** | **Details**                                                                                                                         |
| ------------------------------------------------ | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| **Video is a subset of another video**           | **Supported**     | SMO detects when one video is a subset of another, even after transcoding, using DTW and window sliding techniques.                 |
| **Different rotations of the same image**        | **Supported**     | Perceptual hashing and grayscale processing ensure that rotation differences are effectively managed.                               |
| **Video duplicates images**                      | **Supported**     | SMO compares frames from both videos and images, identifying duplicates across these formats.                                       |
| **One video transcoded in different qualities**  | **Supported**     | Downscaling and raw frame buffer comparison allow SMO to recognize duplicates across varying quality levels or transcoded versions. |
| **Captured moments from video**                  | **Supported**     | SMO detects when an image is a captured moment from a video, ensuring meaningful files are preserved.                               |
| **Thumbnails generated by software**             | **Supported**     | SMO re-runs deduplication within clusters to differentiate genuine captures from software-generated thumbnails.                     |
| **Animated images (GIFs) vs. one-frame videos**  | **Supported**     | SMO treats videos and images equally, efficiently detecting duplicates even when formats differ.                                    |
| **Duplicate detection in different resolutions** | **Supported**     | Downscaling ensures that resolution differences do not interfere with accurate duplicate detection.                                 |

### Leveraging FFmpeg and libvips

SMO relies on the powerful decoding capabilities of FFmpeg and libvips to handle a wide range of media formats. If you need to support additional formats, simply follow the guidelines in the [FFmpeg documentation](https://ffmpeg.org/documentation.html) and [libvips documentation](https://libvips.github.io/libvips/) to compile these libraries with the necessary codecs and plugins.

### 🏎️ High-Performance Engine

SMO isn’t just effective; it’s built for speed:

- **Downscaling**: Sharp and FFmpeg are used to reduce data size while maintaining essential features, making comparisons faster and more efficient.
- **Concurrency**: SMO maximizes your hardware by processing files in parallel, cutting down the time needed to organize large collections.
- **Caching**: Pause and resume your deduplication tasks without losing any progress, thanks to SMO's robust caching system.

## 🤝 Contribute to SMO

Join the community and help make SMO even better! Fork the repository, make your improvements, and submit a pull request.

## 📝 License

SotiMediaOrganizer is open-source software licensed under the MIT License.
