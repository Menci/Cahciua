#!/usr/bin/env bash
# Build libtdjson from TDLib master and stage it under vendor/.
#
# Use this when prebuilt-tdlib lags behind a fresh Telegram protocol change
# (e.g. day-1 support for newly added MessageContent variants). tdl auto-loads
# whichever libtdjson is configured via resolveTdjson() in src/telegram/tdjson.ts.
#
# Re-run any time to bump to TDLib master HEAD.

set -euo pipefail

cd "$(dirname "$0")/.."
REPO_ROOT="$PWD"
BUILD_DIR="$REPO_ROOT/.tdlib-build"
VENDOR_DIR="$REPO_ROOT/vendor"

mkdir -p "$BUILD_DIR" "$VENDOR_DIR"

if [ ! -d "$BUILD_DIR/td/.git" ]; then
  echo ">>> Cloning TDLib..."
  git clone https://github.com/tdlib/td.git "$BUILD_DIR/td"
else
  echo ">>> Updating TDLib..."
  git -C "$BUILD_DIR/td" fetch origin
  git -C "$BUILD_DIR/td" reset --hard origin/master
fi

TD_COMMIT=$(git -C "$BUILD_DIR/td" rev-parse HEAD)
echo ">>> TDLib commit: $TD_COMMIT"

PATCH_DIR="$REPO_ROOT/scripts/tdlib-patches"
if [ -d "$PATCH_DIR" ]; then
  for p in "$PATCH_DIR"/*.patch; do
    [ -f "$p" ] || continue
    echo ">>> Applying $(basename "$p")"
    patch -p1 -d "$BUILD_DIR/td" --no-backup-if-mismatch < "$p"
  done
fi

cd "$BUILD_DIR/td"
mkdir -p build
cd build

echo ">>> Configuring..."
cmake -DCMAKE_BUILD_TYPE=Release ..

echo ">>> Building (this takes ~15-30 minutes and lots of RAM)..."
cmake --build . --target tdjson -j"$(nproc)"

# The output filename has a version suffix on Linux (libtdjson.so.<major>.<minor>.<patch>).
# We resolve and copy the actual file plus the unversioned symlink.
LIB_PATH=$(find . -maxdepth 2 -name 'libtdjson.so*' -type f | head -1)
if [ -z "$LIB_PATH" ]; then
  echo "!!! No libtdjson.so produced — build may have failed silently."
  exit 1
fi

cp "$LIB_PATH" "$VENDOR_DIR/libtdjson.so"
echo "$TD_COMMIT" > "$VENDOR_DIR/libtdjson.commit"

echo ">>> Done. libtdjson staged at: $VENDOR_DIR/libtdjson.so"
echo "    TDLib commit recorded:    $VENDOR_DIR/libtdjson.commit"
