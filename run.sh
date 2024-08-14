#!/bin/bash

# Update package list
sudo apt update

# Install essential build tools and basic dependencies
sudo apt install -y build-essential meson pkg-config git libglib2.0-dev libexpat1-dev wget cmake

# Install required libraries for optional dependencies from apt
sudo apt install -y \
  libjpeg-dev \
  libexif-dev \
  librsvg2-dev \
  libpoppler-glib-dev \
  libcairo2-dev \
  libtiff-dev \
  libfftw3-dev \
  liblcms2-dev \
  libpng-dev \
  libimagequant-dev \
  libmagickcore-dev \
  libmagickwand-dev \
  libarchive-dev \
  libmatio-dev \
  libcfitsio-dev \
  libwebp-dev \
  libnifti-dev \
  libopenexr-dev \
  libopenjp2-7-dev \
  libde265-dev \
  libdav1d-dev \
  libaom-dev \
  libsvtav1-dev \
  libx265-dev \
  python3-pytest

# Install PDFium manually
PDFIUM_URL="https://github.com/bblanchon/pdfium-binaries/releases/download/chromium/4926/pdfium-linux.tgz"
PDFIUM_VERSION="4926"
INSTALL_PREFIX="/usr/local"

# Download and install PDFium
cd /tmp
if wget $PDFIUM_URL -O pdfium-linux.tgz; then
    tar xf pdfium-linux.tgz
    sudo mkdir -p $INSTALL_PREFIX/lib/pkgconfig
    sudo cp -r pdfium-linux/* $INSTALL_PREFIX/
    VIPSHOME=$INSTALL_PREFIX
    sudo bash -c "cat > $VIPSHOME/lib/pkgconfig/pdfium.pc << EOF
prefix=$VIPSHOME
exec_prefix=\${prefix}
libdir=\${exec_prefix}/lib
includedir=\${prefix}/include
Name: pdfium
Description: pdfium
Version: $PDFIUM_VERSION
Requires:
Libs: -L\${libdir} -lpdfium
Cflags: -I\${includedir}
EOF"
else
    echo "PDFium download failed, skipping PDFium installation."
fi

# Build and install libspng from source
cd /tmp
if [ -d "libspng" ]; then
    rm -rf libspng
fi
git clone https://github.com/randy408/libspng.git
cd libspng
mkdir -p build && cd build
cmake .. -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX=$INSTALL_PREFIX
make
sudo make install

# Build and install libjxl (JPEG XL) from source
cd /tmp
if [ -d "libjxl" ]; then
    rm -rf libjxl
fi
git clone https://github.com/libjxl/libjxl.git
cd libjxl
git submodule update --init --recursive
mkdir -p build && cd build
cmake .. -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX=$INSTALL_PREFIX
make
sudo make install

# Build and install highway from source (used by libjxl)
cd /tmp
if [ -d "highway" ]; then
    rm -rf highway
fi
git clone https://github.com/google/highway.git
cd highway
mkdir -p build && cd build
cmake .. -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX=$INSTALL_PREFIX
make
sudo make install

# Build and install cgif from source
cd /tmp
if [ -d "cgif" ]; then
    rm -rf cgif
fi
git clone https://github.com/dloebl/cgif.git
cd cgif
mkdir -p build && cd build
cmake .. -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX=$INSTALL_PREFIX
make
sudo make install

# Clone the libvips repository and checkout the desired version
cd /tmp
if [ -d "libvips" ]; then
    rm -rf libvips
fi
git clone https://github.com/libvips/libvips.git
cd libvips
git checkout $(git describe --tags `git rev-list --tags --max-count=1`)  # Checkout the latest version

# Set up the build environment with all options enabled
meson setup builddir --prefix="$INSTALL_PREFIX" \
  -Ddeprecated=false \
  -Dexamples=false \
  -Dcplusplus=false \
  -Ddoxygen=false \
  -Dgtk_doc=false \
  -Dmodules=enabled \
  -Dintrospection=auto \
  -Dvapi=false \
  -Dcfitsio=auto \
  -Dcgif=auto \
  -Dexif=auto \
  -Dfftw=auto \
  -Dfontconfig=auto \
  -Darchive=auto \
  -Dheif=auto \
  -Dheif-module=auto \
  -Dimagequant=auto \
  -Djpeg=auto \
  -Djpeg-xl=auto \
  -Djpeg-xl-module=auto \
  -Dlcms=auto \
  -Dmagick=auto \
  -Dmagick-package=MagickCore \
  -Dmagick-features=load,save \
  -Dmagick-module=auto \
  -Dmatio=auto \
  -Dnifti=auto \
  -Dnifti-prefix-dir='' \
  -Dopenexr=auto \
  -Dopenjpeg=auto \
  -Dopenslide=auto \
  -Dopenslide-module=auto \
  -Dhighway=auto \
  -Dorc=auto \
  -Dpangocairo=auto \
  -Dpdfium=auto \
  -Dpng=auto \
  -Dpoppler=auto \
  -Dpoppler-module=auto \
  -Dquantizr=auto \
  -Drsvg=auto \
  -Dspng=auto \
  -Dtiff=auto \
  -Dwebp=auto \
  -Dzlib=auto \
  -Dnsgif=true \
  -Dppm=true \
  -Danalyze=true \
  -Dradiance=true \
  -Dfuzzing_engine=none \
  -Dfuzzer_ldflags=''

# Check if meson setup succeeded
if [ $? -ne 0 ]; then
    echo "Meson setup failed. Exiting."
    exit 1
fi

# Navigate to the correct build directory and compile the code
cd builddir
meson compile

# Check if meson compile succeeded
if [ $? -ne 0 ]; then
    echo "Meson compile failed. Exiting."
    exit 1
fi

# Run tests to ensure everything is working
meson test

# Check if meson test succeeded
if [ $? -ne 0 ]; then
    echo "Meson tests failed. Exiting."
    exit 1
fi

# Install the built files
sudo meson install

# Output verification
echo "Installation completed. Please verify that all desired formats are supported."
