#!/bin/bash
# Builds a signed debug APK from a simple Android project, without Gradle.
#
# Works around this device being arm64 while the only local Android SDK ships
# x86_64 binaries: aapt2 comes from Debian (native arm64), d8/apksigner run on
# the JVM, and the framework resources come from the android-framework-res
# package rather than the SDK's platform jar.
#
# Project layout expected at $1:
#   AndroidManifest.xml
#   src/**/*.java
#   res/**
#
# Usage: build_apk.sh <project_dir> <output.apk>

set -euo pipefail

PROJECT="${1:?usage: build_apk.sh <project_dir> <output.apk>}"
OUTPUT="${2:?usage: build_apk.sh <project_dir> <output.apk>}"

ANDROID_JAR="${ANDROID_JAR:-/mnt/backup/home/droid/android-sdk/platforms/android-35/android.jar}"
D8_JAR="${D8_JAR:-/mnt/backup/home/droid/android-sdk/build-tools/35.0.0/lib/d8.jar}"
FRAMEWORK_RES="${FRAMEWORK_RES:-/usr/share/android-framework-res/framework-res.apk}"
MIN_SDK="${MIN_SDK:-21}"
TARGET_SDK="${TARGET_SDK:-34}"

for f in "$ANDROID_JAR" "$D8_JAR" "$FRAMEWORK_RES"; do
    [ -r "$f" ] || { echo "missing required file: $f" >&2; exit 1; }
done

cd "$PROJECT"
BUILD="$(mktemp -d)"
trap 'rm -rf "$BUILD"' EXIT

aapt2 compile --dir res -o "$BUILD/res.zip"

aapt2 link -o "$BUILD/base.apk" \
    -I "$FRAMEWORK_RES" \
    --manifest AndroidManifest.xml \
    --java "$BUILD/gen" \
    --min-sdk-version "$MIN_SDK" \
    --target-sdk-version "$TARGET_SDK" \
    "$BUILD/res.zip"

# -source/-target 8 is required: javac refuses -bootclasspath at its default target.
# Note: no lambdas or method references in app sources -- android.jar has no
# LambdaMetafactory, and this pipeline has no desugaring step. Use anonymous classes.
find "$BUILD/gen" src -name '*.java' > "$BUILD/sources.txt"
if ! javac -nowarn -source 8 -target 8 \
    -bootclasspath "$ANDROID_JAR" -classpath "$ANDROID_JAR" \
    -d "$BUILD/obj" "@$BUILD/sources.txt" > "$BUILD/javac.log" 2>&1; then
    grep -v 'warning: \[options\]' "$BUILD/javac.log" >&2 || true
    echo "compilation failed" >&2
    exit 1
fi
grep -v 'warning: \[options\]' "$BUILD/javac.log" || true

find "$BUILD/obj" -name '*.class' > "$BUILD/classes.txt"
mkdir -p "$BUILD/dex"
# This VM has under 1GB of RAM in total. A 1G heap request here is enough to trigger the
# kernel OOM killer, which has already killed a `claude` process once.
java -Xmx384m -cp "$D8_JAR" com.android.tools.r8.D8 \
    --output "$BUILD/dex" --lib "$ANDROID_JAR" --min-api "$MIN_SDK" \
    @"$BUILD/classes.txt"

# No zip binary on this system; python stdlib does the same job.
python3 - "$BUILD" <<'PY'
import shutil, sys, zipfile
build = sys.argv[1]
shutil.copy(f"{build}/base.apk", f"{build}/unsigned.apk")
with zipfile.ZipFile(f"{build}/unsigned.apk", "a", zipfile.ZIP_DEFLATED) as z:
    z.write(f"{build}/dex/classes.dex", "classes.dex")
PY

zipalign -f -p 4 "$BUILD/unsigned.apk" "$BUILD/aligned.apk"

KEYSTORE="${KEYSTORE:-$HOME/.forge/debug.keystore}"
if [ ! -f "$KEYSTORE" ]; then
    mkdir -p "$(dirname "$KEYSTORE")"
    keytool -genkeypair -keystore "$KEYSTORE" \
        -storepass android -keypass android -alias androiddebugkey \
        -keyalg RSA -keysize 2048 -validity 10000 \
        -dname "CN=Forge Debug,O=Forge,C=US" >/dev/null 2>&1
fi

mkdir -p "$(dirname "$OUTPUT")"
apksigner sign --ks "$KEYSTORE" --ks-pass pass:android --key-pass pass:android \
    --out "$OUTPUT" "$BUILD/aligned.apk"

apksigner verify "$OUTPUT" >/dev/null
echo "built: $OUTPUT ($(stat -c%s "$OUTPUT") bytes)"
