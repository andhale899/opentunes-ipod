# syntax=docker/dockerfile:1.7
#
# Reproducible WebAssembly build of the iPod database engine.
# Every source is pinned by version and SHA-256. Build context is the engine/ folder:
#
#   docker build -f engine/Dockerfile --target <stage> engine
#
# Stages: toolchain -> deps -> glib -> (libgpod, wrapper: added as they are proven)

ARG EMSDK_VERSION=4.0.23

# ---------------------------------------------------------------- toolchain
FROM emscripten/emsdk:${EMSDK_VERSION} AS toolchain

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      autoconf automake libtool intltool gettext pkg-config ninja-build \
      python3-pip python3-packaging xz-utils bzip2 patch unzip gperf ca-certificates curl \
 && rm -rf /var/lib/apt/lists/* \
 && pip3 install --no-cache-dir meson==1.6.1

COPY scripts/fetch.sh /usr/local/bin/fetch
RUN chmod +x /usr/local/bin/fetch

# Everything we compile installs into one prefix, and only that prefix is searched
# for libraries, so host libraries can never leak into the WebAssembly build.
ENV PREFIX=/opt/wasm
ENV EM_PKG_CONFIG_PATH=/opt/wasm/lib/pkgconfig
ENV PKG_CONFIG_LIBDIR=/opt/wasm/lib/pkgconfig
RUN mkdir -p "$PREFIX/lib/pkgconfig" "$PREFIX/include"
WORKDIR /build

# --------------------------------------------------------------------- deps
FROM toolchain AS deps

ARG ZLIB_VERSION=1.3.1
ARG ZLIB_SHA256=9a93b2b7dfdac77ceba5a558a580e74667dd6fede4585b91eefb60f03b72df23
RUN fetch "https://github.com/madler/zlib/releases/download/v${ZLIB_VERSION}/zlib-${ZLIB_VERSION}.tar.gz" "$ZLIB_SHA256" zlib.tar.gz \
 && mkdir zlib && tar -xzf zlib.tar.gz -C zlib --strip-components=1 \
 && cd zlib \
 && emconfigure ./configure --static --prefix="$PREFIX" \
 && emmake make -j"$(nproc)" install \
 && cd .. && rm -rf zlib zlib.tar.gz

# SQLite is compiled straight from the amalgamation, single-threaded, without extension loading.
ARG SQLITE_VERSION=3.47.2
ARG SQLITE_FILE=sqlite-autoconf-3470200
ARG SQLITE_SHA256=f1b2ee412c28d7472bc95ba996368d6f0cdcf00362affdadb27ed286c179540b
RUN fetch "https://www.sqlite.org/2024/${SQLITE_FILE}.tar.gz" "$SQLITE_SHA256" sqlite.tar.gz \
 && mkdir sqlite && tar -xzf sqlite.tar.gz -C sqlite --strip-components=1 \
 && cd sqlite \
 && emcc -O2 -DSQLITE_THREADSAFE=0 -DSQLITE_OMIT_LOAD_EXTENSION=1 -c sqlite3.c -o sqlite3.o \
 && emar rcs "$PREFIX/lib/libsqlite3.a" sqlite3.o \
 && cp sqlite3.h sqlite3ext.h "$PREFIX/include/" \
 && printf 'prefix=%s\nlibdir=${prefix}/lib\nincludedir=${prefix}/include\n\nName: SQLite\nDescription: SQL database engine\nVersion: %s\nLibs: -L${libdir} -lsqlite3\nCflags: -I${includedir}\n' \
      "$PREFIX" "$SQLITE_VERSION" > "$PREFIX/lib/pkgconfig/sqlite3.pc" \
 && cd .. && rm -rf sqlite sqlite.tar.gz

# 3.4.6 asks emscripten for JS helpers ($generateFuncType, $uleb128Encode) that emscripten 4.x
# removed, which breaks the final link. 3.5.2 only needs helpers that 4.0.x still has.
ARG LIBFFI_VERSION=3.5.2
ARG LIBFFI_SHA256=f3a3082a23b37c293a4fcd1053147b371f2ff91fa7ea1b2a52e335676bac82dc
RUN fetch "https://github.com/libffi/libffi/releases/download/v${LIBFFI_VERSION}/libffi-${LIBFFI_VERSION}.tar.gz" "$LIBFFI_SHA256" libffi.tar.gz \
 && mkdir libffi && tar -xzf libffi.tar.gz -C libffi --strip-components=1 \
 && cd libffi \
 && emconfigure ./configure --host=wasm32-unknown-emscripten --prefix="$PREFIX" \
      --disable-shared --enable-static --disable-docs --disable-multi-os-directory \
 && emmake make -j"$(nproc)" install \
 && cd .. && rm -rf libffi libffi.tar.gz

ARG LIBXML2_VERSION=2.12.9
ARG LIBXML2_SHA256=59912db536ab56a3996489ea0299768c7bcffe57169f0235e7f962a91f483590
RUN fetch "https://download.gnome.org/sources/libxml2/2.12/libxml2-${LIBXML2_VERSION}.tar.xz" "$LIBXML2_SHA256" libxml2.tar.xz \
 && mkdir libxml2 && tar -xJf libxml2.tar.xz -C libxml2 --strip-components=1 \
 && cd libxml2 \
 && emconfigure ./configure --host=wasm32-unknown-emscripten --prefix="$PREFIX" \
      --disable-shared --enable-static --without-python --without-lzma --without-iconv \
      --without-zlib --without-http --without-ftp --without-threads --without-modules \
      --without-readline --without-history --without-programs \
 && emmake make -j"$(nproc)" install \
 && cd .. && rm -rf libxml2 libxml2.tar.xz

ARG LIBPLIST_VERSION=2.6.0
ARG LIBPLIST_SHA256=67be9ee3169366589c92dc7c22809b90f51911dd9de22520c39c9a64fb047c9c
RUN fetch "https://github.com/libimobiledevice/libplist/releases/download/${LIBPLIST_VERSION}/libplist-${LIBPLIST_VERSION}.tar.bz2" "$LIBPLIST_SHA256" libplist.tar.bz2 \
 && mkdir libplist && tar -xjf libplist.tar.bz2 -C libplist --strip-components=1 \
 && cd libplist \
 && emconfigure ./configure --host=wasm32-unknown-emscripten --prefix="$PREFIX" \
      --disable-shared --enable-static --without-cython --without-tools \
 && emmake make -j"$(nproc)" install \
 && cp "$PREFIX/lib/pkgconfig/libplist-2.0.pc" "$PREFIX/lib/pkgconfig/libplist.pc" \
 && cd .. && rm -rf libplist libplist.tar.bz2

# --------------------------------------------------------------------- glib
FROM deps AS glib

ARG GLIB_VERSION=2.80.5
ARG GLIB_SHA256=9f23a9de803c695bbfde7e37d6626b18b9a83869689dd79019bf3ae66c3e6771
# The emscripten patch series (Kleis Auke Wolthuizen), as used by emscripten-forge.
ARG GLIB_PATCH_COMMIT=5f702eea46284232f0aba1d216f653f72419f546
ARG GLIB_PATCH_SHA256=c1118a6515ee9ecbe566aecf977607609913c3301552c38100b88930359b81a2

COPY meson/emscripten.cross /opt/emscripten.cross

# glib_assert and glib_checks stay on (the emscripten-forge recipe turns them off for size).
# libgpod relies on g_return_if_fail style checks to reject bad input.
RUN fetch "https://download.gnome.org/sources/glib/2.80/glib-${GLIB_VERSION}.tar.xz" "$GLIB_SHA256" glib.tar.xz \
 && fetch "https://raw.githubusercontent.com/emscripten-forge/recipes/${GLIB_PATCH_COMMIT}/recipes/recipes_emscripten/glib/patches/glib.patch" "$GLIB_PATCH_SHA256" glib.patch \
 && mkdir glib && tar -xJf glib.tar.xz -C glib --strip-components=1 \
 && cd glib \
 && patch -p1 < ../glib.patch \
 && meson setup builddir \
      --cross-file /opt/emscripten.cross \
      --prefix="$PREFIX" \
      --default-library=static \
      --buildtype=release \
      --force-fallback-for=pcre2,gvdb \
      -Dintrospection=disabled -Dselinux=disabled -Dlibmount=disabled \
      -Dnls=disabled -Dxattr=false -Dtests=false \
 && meson install -C builddir --tag devel \
 && cd .. && rm -rf glib glib.tar.xz glib.patch

# glib's meson build detects pthreads and records -pthread in its .pc files, which would make
# every consumer link the shared-memory runtime. The engine is single-threaded on purpose: it
# then needs no SharedArrayBuffer and runs in any worker. Strip the flag.
#
# The patched glib also leaves one symbol undefined (see src/glib_shims.c). Provide it in a
# tiny library and add that library to glib-2.0.pc so every consumer links it.
COPY src/glib_shims.c /tmp/glib_shims.c
RUN sed -i 's/ -pthread//g; s/-pthread //g' "$PREFIX"/lib/pkgconfig/*.pc \
 && ! grep -l pthread "$PREFIX"/lib/pkgconfig/*.pc \
 && emcc -O2 -I"$PREFIX/include/glib-2.0" -I"$PREFIX/lib/glib-2.0/include" -c /tmp/glib_shims.c -o /tmp/glib_shims.o \
 && emar rcs "$PREFIX/lib/libglibshim.a" /tmp/glib_shims.o \
 && sed -i 's/^Libs: .*/& -lglibshim/' "$PREFIX/lib/pkgconfig/glib-2.0.pc" \
 && grep '^Libs:' "$PREFIX/lib/pkgconfig/glib-2.0.pc" \
 && rm /tmp/glib_shims.c /tmp/glib_shims.o

# ------------------------------------------------------------------- libgpod
FROM glib AS libgpod-configured

# gtkpod/libgpod main, the 0.8.2-era tree (last commit 2012-05-04). Pinned by commit.
ARG LIBGPOD_COMMIT=7982c5554f78dde47fd006afbeff659201d6db3d
ARG LIBGPOD_SHA256=fe5a11c072e171a42378c18c999dd1c2ff63841ba57cf69034fa97e7e600be4b

# libgpod's configure.ac uses AM_GLIB_GNU_GETTEXT, which glib 2.80 no longer ships.
# The macro file comes from the host's glib development package. Only autoreconf reads it:
# pkg-config is locked to /opt/wasm, so no host library reaches the WebAssembly build.
RUN apt-get update \
 && apt-get install -y --no-install-recommends libglib2.0-dev gtk-doc-tools \
 && rm -rf /var/lib/apt/lists/*

# Our own changes to libgpod (for example nano 7G model entries). Applied in name order.
COPY patches/libgpod/ /patches/libgpod/

# The 2012 tree ships an old config.sub that does not know wasm32-emscripten, so the
# autotools files are regenerated. Only the library is built, not tools, docs or bindings.
RUN fetch "https://github.com/gtkpod/libgpod/archive/${LIBGPOD_COMMIT}.tar.gz" "$LIBGPOD_SHA256" libgpod.tar.gz \
 && mkdir libgpod && tar -xzf libgpod.tar.gz -C libgpod --strip-components=1 \
 && cd libgpod \
 && for p in /patches/libgpod/*.patch; do [ -e "$p" ] && patch -p1 < "$p"; done; \
    cd /build/libgpod \
 && cp /usr/share/gtk-doc/data/gtk-doc.make gtk-doc.make \
 && intltoolize --force --copy --automake \
 && autoreconf -fiv \
 && emconfigure ./configure --host=wasm32-unknown-emscripten --prefix="$PREFIX" \
      --disable-shared --enable-static \
      --without-hal --without-libimobiledevice --disable-udev \
      --disable-gdk-pixbuf --without-python --disable-pygobject \
      --disable-more-warnings \
      CPPFLAGS="-I$PREFIX/include" LDFLAGS="-L$PREFIX/lib"

# Separate stage so a compile failure does not redo the autotools work.
FROM libgpod-configured AS libgpod
WORKDIR /build/libgpod
RUN emmake make -C src -j"$(nproc)" install \
 && emmake make install-pkgconfigDATA \
 && ls "$PREFIX/lib/libgpod.a" "$PREFIX/include/gpod-1.0/gpod/itdb.h"

# ------------------------------------------------------------------- hashab
# HashAB signing for the nano 6G and 7G: dstaley/hashab (Unlicense), reverse engineered and
# checked against libhashab32.so. Compiled to a static library. libgpod patch 0003 makes
# libgpod call it directly instead of looking for an external shared library.
# Independent of the libgpod stages, so it builds and caches on its own.
FROM toolchain AS hashab
ARG HASHAB_COMMIT=f80d46432204c6238cad7d8ca3b3dd52ea66836b
ARG HASHAB_SHA256=e3901390c48fce394054b5e34f056c275c02a1768b73c56f2ea021fd00731df2
RUN fetch "https://github.com/dstaley/hashab/archive/${HASHAB_COMMIT}.tar.gz" "$HASHAB_SHA256" hashab.tar.gz \
 && mkdir hashab && tar -xzf hashab.tar.gz -C hashab --strip-components=1 \
 && cd hashab/src \
 && for f in calcHashAB cipher cipher_tables edonr expand hash reduce; do emcc -O2 -Wall -c "$f.c" -o "$f.o"; done \
 && emar rcs "$PREFIX/lib/libhashab.a" ./*.o \
 && cd /build && rm -rf hashab hashab.tar.gz

# -------------------------------------------------------------------- engine
# The wrapper plus libgpod, linked into one WebAssembly module with a JavaScript loader.
# Single-threaded, ES module, runs in a browser, a worker or Node (used by the tests).
# Warnings are not suppressed on purpose: v1 hid implicit declarations and int conversions.
FROM libgpod AS engine
WORKDIR /build/engine
COPY --from=hashab /opt/wasm/lib/libhashab.a /opt/wasm/lib/libhashab.a
COPY src/ipod_manager.c ./ipod_manager.c
RUN mkdir -p /out \
 && emcc -O2 -Wall -DEMSCRIPTEN ipod_manager.c \
      -I"$PREFIX/include/gpod-1.0/gpod" \
      $(pkg-config --cflags --libs --static libgpod-1.0 gmodule-2.0 libxml-2.0 libplist sqlite3 zlib) -lhashab \
      -sWASM=1 -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createIPodModule \
      -sENVIRONMENT=web,worker,node \
      -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=67108864 -sMAXIMUM_MEMORY=536870912 \
      -sFORCE_FILESYSTEM=1 -lnodefs.js \
      -sEXPORTED_RUNTIME_METHODS=FS,HEAPU8,UTF8ToString,stringToUTF8,lengthBytesUTF8,ccall,cwrap \
      -sEXPORTED_FUNCTIONS=_malloc,_free,_calcHashAB \
      -sNO_EXIT_RUNTIME=1 -sEMULATE_FUNCTION_POINTER_CASTS=1 --no-entry \
      -o /out/ipod_manager.js \
 && ls -l /out
