# SotiMediaOrganizer (SMO)

**SotiMediaOrganizer** (SMO) is your ultimate tool for organizing and decluttering your digital photo and video collection. Whether you're a casual photographer or a seasoned professional, SMO offers intelligent solutions to bring order to your growing media library, efficiently and effortlessly.

## 🚀 Key Features

- **Smart Organization**: Automatically organizes photos and videos by metadata like creation date, geolocation, and camera model.
- **Advanced Deduplication**: Eliminate duplicate files with cutting-edge algorithms like perceptual hashing, VP Tree, and Dynamic Time Warping (DTW).
- **Blazing Performance**: Optimized for speed with tools like Sharp and FFmpeg, ensuring smooth operation on both Windows and Ubuntu.
- **Flexible Directory Structure**: Customize the folder hierarchy to fit your organizational style using an intuitive format string system.
- **Pause and Resume**: Robust caching allows you to pause and resume deduplication tasks at any time.
- **Wide Format Support**: Handle everything from JPEG to HEIC, and MP4 to DNG—just recompile libvips for specialized formats.
- **Dependency Injection**: Utilizes `@tsed/di` for flexible and modular management of services, enhancing testability and maintainability.
- **Job-Based Architecture**: Introduced job-based processing for metadata extraction, adaptive extraction, and file stats, leading to a more organized and scalable codebase.

## 🌟 Easy Installation

Get started with SMO in no time by installing it globally with Bun:

```bash
bun install --global @sotilab/smo
```

This command makes `smo` available directly from your terminal.

## 🔥 Simple and Powerful Usage

Start organizing your media with a single command:

```bash
smo <source> <destination> [options]
```

### Command Options

- **Required Arguments:**

  - `<source>`: Source directories to process.
  - `<destination>`: Destination directory for organized media.

- **Optional Options:**
  - `-e, --error <path>`: Directory for files that couldn't be processed.
  - `-d, --duplicate <path>`: Directory for duplicate files.
  - `--debug <path>`: Debug directory for storing all files in duplicate sets.
  - `-c, --concurrency <number>`: Number of workers to use (default: half of CPU cores).
  - `-m, --move`: Move files instead of copying them (default: false).
  - `-r, --resolution <number>`: Resolution for perceptual hashing (default: 32).
  - `-f, --fps <number>`: Frames per second to extract from videos (default: 1).
  - `-x, --max-frames <number>`: Maximum number of frames to extract from videos (default: 100).
  - `-w, --window-size <number>`: Window size for frame clustering (default: 5).
  - `-p, --step-size <number>`: Step size for frame clustering (default: 1).
  - `-F, --format <string>`: Format for destination directory (default: "{D.YYYY}/{D.MM}/{D.DD}/{NAME}.{EXT}").
  - `--scene-change-threshold <number>`: Threshold for scene change detection (default: 0.01).
  - `--similar-image-threshold <number>`: Threshold for image similarity (default: 0.99).
  - `--similar-image-video-threshold <number>`: Threshold for image-video similarity (default: 0.98).
  - `--similar-video-threshold <number>`: Threshold for video similarity (default: 0.97).
  - `--max-chunk-size <number>`: Maximum chunk size for file processing in bytes (default: 2MB).

### Example Usage

Organize media with custom similarity thresholds and frame extraction settings:

```bash
smo /path/to/source /path/to/destination \
  -d /path/to/duplicates \
  -e /path/to/errors \
  --move \
  --resolution 64 \
  --fps 2 \
  --max-frames 200 \
  --similar-image-threshold 0.98 \
  --similar-video-threshold 0.95 \
  --format "{D.YYYY}/{D.MM}/{D.DD}/{TYPE}/{NAME}.{EXT}"
```

This command will:

- Process files from `/path/to/source`
- Organize them into `/path/to/destination`
- Move files instead of copying
- Use a 64x64 resolution for perceptual hashing
- Extract 2 frames per second from videos, up to 200 frames
- Set custom similarity thresholds for images and videos
- Organize files into a year/month/day/media-type structure

### Format String Placeholders

Customize your file organization with these powerful placeholders:

#### Date Placeholders

Use these prefixes for different date sources:

- `I.` : Image metadata date
- `F.` : File creation date
- `D.` : Mixed date (prefers image metadata date, falls back to file creation date)

For each prefix, the following date formats are available:

- `{*.YYYY}` : Year (4 digits)
- `{*.YY}` : Year (2 digits)
- `{*.MMMM}` : Month (full name)
- `{*.MMM}` : Month (abbreviated name)
- `{*.MM}` : Month (2 digits)
- `{*.M}` : Month (1-2 digits)
- `{*.DD}` : Day of month (2 digits)
- `{*.D}` : Day of month (1-2 digits)
- `{*.DDDD}` : Day of week (full name)
- `{*.DDD}` : Day of week (abbreviated name)
- `{*.HH}` : Hour, 24-hour format (2 digits)
- `{*.H}` : Hour, 24-hour format (1-2 digits)
- `{*.hh}` : Hour, 12-hour format (2 digits)
- `{*.h}` : Hour, 12-hour format (1-2 digits)
- `{*.mm}` : Minute (2 digits)
- `{*.m}` : Minute (1-2 digits)
- `{*.ss}` : Second (2 digits)
- `{*.s}` : Second (1-2 digits)
- `{*.a}` : AM/PM (lowercase)
- `{*.A}` : AM/PM (uppercase)
- `{*.WW}` : Week of year (2 digits)

#### Filename Placeholders

- `{NAME}` : Original filename (without extension)
- `{NAME.L}` : Lowercase filename
- `{NAME.U}` : Uppercase filename
- `{EXT}` : File extension (without dot)
- `{RND}` : Random 8-character hexadecimal string (for unique filenames)

#### Metadata Placeholders

- `{GEO}` : GPS coordinates (format: latitude_longitude)
- `{CAM}` : Camera model
- `{TYPE}` : Media type ('Image' or 'Video')

#### Conditional Placeholders

- `{HAS.GEO}` : 'GeoTagged' if GPS data is available, 'NoGeo' otherwise
- `{HAS.CAM}` : 'WithCamera' if camera model is available, 'NoCamera' otherwise
- `{HAS.DATE}` : 'Dated' if image date is available, 'NoDate' otherwise

#### Example Format Strings

```
"{D.YYYY}/{D.MM}/{D.DD}/{NAME}.{EXT}"
"{HAS.GEO}/{TYPE}/{D.YYYY}/{D.MMMM}/{NAME}_{D.HH}{D.mm}.{EXT}"
"{CAM}/{D.YYYY}/{D.WW}/{TYPE}/{D.YYYY}{D.MM}{D.DD}_{NAME.L}.{EXT}"
"{HAS.DATE}/{D.YYYY}/{D.MMMM}/{D.D}-{D.DDDD}/{D.h}{D.mm}{D.a}_{NAME}.{EXT}"
"{TYPE}/{HAS.CAM}/{D.YYYY}/{D.MM}/{D.DD}_{D.HH}{D.mm}_{NAME.U}_{RND}.{EXT}"
```

These placeholders provide extensive flexibility in organizing your media files based on various criteria such as dates, file properties, and metadata.

## 🔍 Sophisticated Deduplication

SMO's deduplication process combines state-of-the-art technology with practical strategies to keep your media collection tidy:

### A Unified Approach

SMO treats videos and images equally, allowing it to detect duplicates across formats. By comparing perceptual hashes of frames, SMO accurately identifies duplicates, even in transcoded videos or when an image is a captured moment from a video. Thanks to adaptive frame extraction and resolution adjustment, differences in quality and duration are also handled effectively.

### Step-by-Step Deduplication

1. **Perceptual Hashing**: Generate unique hash signatures for each frame of media files, capturing their essential visual features.
2. **Adaptive Frame Extraction**: Extract key frames from videos using scene change detection, ensuring a balanced representation of video content.
3. **VP Tree Clustering**: Group similar media files using a VP Tree to streamline the deduplication process.
4. **Dynamic Time Warping (DTW)**: Compare sequences of frames using DTW, perfect for detecting when one video is a subset of another or when an image matches a video frame.
5. **Adaptive Thresholds**: Use different similarity thresholds for image-to-image, image-to-video, and video-to-video comparisons, ensuring accurate duplicate detection across media types.
6. **Smart File Selection**:
   - **Prioritization**: Files are ranked by duration, metadata completeness, and quality.
   - **Special Handling**:
     - For image clusters, preserve the highest quality image.
     - For video clusters, keep the longest duration video with the best quality.
     - When mixing images and videos, intelligently decide whether to keep both or prioritize based on content and quality.

### Supported Scenarios

SMO is designed to handle a wide range of media comparison and deduplication scenarios. Here's a comprehensive list of supported and planned features:

| Scenario                                                                  | Support Level       | Details                                                                                                                                                                      |
| ------------------------------------------------------------------------- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Video is a subset of another video                                        | **Supported**       | SMO detects when one video is a subset of another, even after transcoding, using DTW and adaptive frame extraction.                                                          |
| Different rotations of the same image                                     | **Supported**       | Perceptual hashing ensures that rotation differences are effectively managed.                                                                                                |
| Video duplicates images                                                   | **Supported**       | SMO compares frames from both videos and images, identifying duplicates across these formats.                                                                                |
| One video transcoded in different qualities                               | **Supported**       | Perceptual hashing and adaptive thresholds allow SMO to recognize duplicates across varying quality levels or transcoded versions.                                           |
| Captured moments from video                                               | **Supported**       | SMO detects when an image is a captured moment from a video, ensuring meaningful files are preserved.                                                                        |
| Thumbnails generated by software                                          | **Supported**       | SMO's smart file selection process differentiates genuine captures from software-generated thumbnails.                                                                       |
| Animated images (GIFs) vs. one-frame videos                               | **Supported**       | SMO treats videos and images equally, efficiently detecting duplicates even when formats differ.                                                                             |
| Duplicate detection in different resolutions                              | **Supported**       | Perceptual hashing ensures that resolution differences do not interfere with accurate duplicate detection.                                                                   |
| Cropped images or videos                                                  | **Supported**       | The perceptual hashing algorithm is robust to minor cropping, allowing detection of partially cropped duplicates.                                                            |
| Color-adjusted images or videos                                           | **Supported**       | Perceptual hashing is generally resilient to minor color adjustments, enabling detection of color-graded duplicates.                                                         |
| Horizontally flipped images or videos                                     | **Supported**       | The current implementation can detect horizontally flipped duplicates.                                                                                                       |
| Time-shifted duplicate videos                                             | **Supported**       | DTW allows for detection of videos that start at different points but contain the same content.                                                                              |
| Duplicate detection across different file formats                         | **Supported**       | SMO focuses on content rather than file format, allowing detection of duplicates across various image and video formats.                                                     |
| Detecting duplicates with added watermarks                                | **Partial Support** | Small watermarks may not prevent duplicate detection, but large or complex watermarks might interfere.                                                                       |
| Detecting duplicates with added text overlays                             | **Partial Support** | Similar to watermarks, small text overlays may not prevent detection, but large text areas might.                                                                            |
| Detecting duplicates with different aspect ratios                         | **Future Planned**  | Currently, significant changes in aspect ratio may interfere with detection. Improved support is planned.                                                                    |
| Detecting reuploaded, re-compressed social media versions                 | **Supported**       | SMO's use of downscaling and grayscale conversion in its perceptual hashing process makes it robust against most re-compression artifacts typical in social media reuploads. |
| Detecting duplicates with significant editing (e.g., Photoshopped images) | **Future Planned**  | Currently, heavily edited images may not be detected as duplicates. Enhanced partial matching is planned.                                                                    |
| Detecting duplicates across different video framerates                    | **Supported**       | The adaptive frame extraction and DTW methods allow for comparison across different framerates.                                                                              |
| Handling of RAW image formats and their JPEG counterparts                 | **Partial Support** | Basic support exists, but enhanced handling of RAW+JPEG pairs is planned for future versions.                                                                                |
| Detecting slow-motion or sped-up video duplicates                         | **Future Planned**  | Current methods may not reliably detect videos that have been significantly slowed down or sped up. This feature is planned for future implementation.                       |

SMO is continuously evolving, and we're always working to improve its capabilities and support for various scenarios. If you encounter any specific use cases not covered here, please let us know, and we'll consider them for future updates.

### Leveraging FFmpeg and libvips for Comprehensive Format Support

SotiMediaOrganizer (SMO) relies on the powerful decoding capabilities of FFmpeg and libvips to handle a wide range of media formats. While the default installations of these libraries cover most common formats, you may need to compile them with additional codecs to support specialized or proprietary formats.

#### Expanding FFmpeg Support

FFmpeg is used primarily for video processing in SMO. To enable support for additional video codecs:

1. Download the FFmpeg source code from the [official FFmpeg website](https://ffmpeg.org/download.html).

2. Configure FFmpeg with the additional codecs you need. For example:

   ```bash
   ./configure --enable-gpl --enable-libx264 --enable-libx265 --enable-libvpx --enable-libopus
   ```

   This configuration enables support for H.264, H.265, VP8/VP9, and Opus codecs.

3. Compile and install FFmpeg:

   ```bash
   make
   sudo make install
   ```

Common video formats that might require additional codec support:

- HEVC/H.265
- VP9
- AV1
- ProRes

#### Enhancing libvips Capabilities

libvips is used for image processing in SMO. To add support for more image formats:

1. Ensure you have the necessary dependencies. For Ubuntu/Debian:

   ```bash
   sudo apt-get install libheif-dev libopenexr-dev libwebp-dev
   ```

2. Download the libvips source code from the [libvips GitHub repository](https://github.com/libvips/libvips).

3. Configure libvips with additional format support:

   ```bash
   ./configure --enable-heif --enable-openexr --enable-webp
   ```

4. Compile and install libvips:

   ```bash
   make
   sudo make install
   ```

Common image formats that might require additional support:

- HEIF/HEIC (common in newer iPhones)
- OpenEXR
- WebP

#### Integrating Custom Builds with SMO

After compiling FFmpeg and libvips with extended format support:

1. Ensure the custom-built libraries are in your system's library path.
2. If you're using a package manager like npm or yarn, you might need to rebuild the node modules that depend on these libraries:

   ```bash
   npm rebuild sharp
   npm rebuild fluent-ffmpeg
   ```

3. Restart your SMO application to use the newly compiled libraries.

#### Note on Proprietary Codecs

Some codecs (like H.264 and H.265) may require licensing for commercial use. Ensure you have the necessary rights or licenses when enabling support for these codecs.

By following these steps, you can significantly expand SMO's ability to handle various media formats, allowing for more comprehensive organization of your media collection. Remember that enabling support for additional formats may increase the size of your application and potentially impact performance, so consider enabling only the formats you actually need.

### 🏎️ High-Performance Engine

SMO isn't just effective; it's built for speed:

- **Adaptive Frame Extraction**: SMO intelligently extracts key frames from videos, reducing processing time while maintaining accuracy.
- **Perceptual Hashing**: Fast and efficient perceptual hashing allows for quick comparisons of visual content.
- **Concurrency**: SMO maximizes your hardware by processing files in parallel, cutting down the time needed to organize large collections.
- **Caching**: Pause and resume your deduplication tasks without losing any progress, thanks to SMO's robust caching system.

## 🤝 Contribute to SMO

Join the community and help make SMO even better! Fork the repository, make your improvements, and submit a pull request.

## 📝 License

SotiMediaOrganizer is open-source software licensed under the MIT License.
