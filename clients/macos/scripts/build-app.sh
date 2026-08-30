#!/bin/sh
set -eu

CLIENT_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
CONFIGURATION=${CONFIGURATION:-release}
OUTPUT_ROOT=${OUTPUT_ROOT:-"$CLIENT_ROOT/dist"}
APP="$OUTPUT_ROOT/Phi.app"
BRAND_ICON="$CLIENT_ROOT/../../assets/brand/phi-logo-latex-varphi-white-on-black.png"

swift build --package-path "$CLIENT_ROOT" --configuration "$CONFIGURATION"
BIN_DIR=$(swift build --package-path "$CLIENT_ROOT" --configuration "$CONFIGURATION" --show-bin-path)

mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN_DIR/PhiMac" "$APP/Contents/MacOS/PhiMac"
cp "$CLIENT_ROOT/Resources/Info.plist" "$APP/Contents/Info.plist"

ICON_WORK=$(mktemp -d)
trap 'rm -rf "$ICON_WORK"' EXIT
ICONSET="$ICON_WORK/Phi.iconset"
mkdir -p "$ICONSET"
sips -z 16 16 "$BRAND_ICON" --out "$ICONSET/icon_16x16.png" >/dev/null
sips -z 32 32 "$BRAND_ICON" --out "$ICONSET/icon_16x16@2x.png" >/dev/null
sips -z 32 32 "$BRAND_ICON" --out "$ICONSET/icon_32x32.png" >/dev/null
sips -z 64 64 "$BRAND_ICON" --out "$ICONSET/icon_32x32@2x.png" >/dev/null
sips -z 128 128 "$BRAND_ICON" --out "$ICONSET/icon_128x128.png" >/dev/null
sips -z 256 256 "$BRAND_ICON" --out "$ICONSET/icon_128x128@2x.png" >/dev/null
sips -z 256 256 "$BRAND_ICON" --out "$ICONSET/icon_256x256.png" >/dev/null
sips -z 512 512 "$BRAND_ICON" --out "$ICONSET/icon_256x256@2x.png" >/dev/null
sips -z 512 512 "$BRAND_ICON" --out "$ICONSET/icon_512x512.png" >/dev/null
sips -z 1024 1024 "$BRAND_ICON" --out "$ICONSET/icon_512x512@2x.png" >/dev/null
iconutil --convert icns "$ICONSET" --output "$APP/Contents/Resources/Phi.icns"
codesign --sign - --force "$APP"

echo "Built $APP"
