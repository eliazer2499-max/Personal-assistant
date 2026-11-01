#!/usr/bin/env bash
# OPTIONAL: lets My Assistant build Android APKs on this server (about 3 GB of disk).
# Google's Android build tools only run on x86_64 Linux. On ARM servers (e.g. Oracle Ampere),
# skip this: the assistant prepares the project and GitHub builds the APK for free instead.
#   sudo bash /opt/myassistant/current/optional/install-android-sdk.sh
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "Run with sudo"; exit 1; }
if [ "$(uname -m)" != "x86_64" ]; then
  echo "This server is $(uname -m). Google's Android build tools do not run here."
  echo "Use the GitHub route instead: ask the assistant to build the app and push it to GitHub."
  exit 1
fi
free_gb=$(df -BG --output=avail /opt | tail -1 | tr -dc '0-9')
[ "${free_gb:-0}" -ge 5 ] || { echo "Need at least 5 GB free on /opt (have ${free_gb} GB)."; exit 1; }
apt-get update -y -q && apt-get install -y -q openjdk-17-jdk-headless unzip
SDK=/opt/android-sdk; mkdir -p "$SDK/cmdline-tools"
cd /tmp
curl -fsSL -o cmdtools.zip https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip
rm -rf "$SDK/cmdline-tools/latest" && unzip -q cmdtools.zip -d "$SDK/cmdline-tools" && mv "$SDK/cmdline-tools/cmdline-tools" "$SDK/cmdline-tools/latest" && rm -f cmdtools.zip
yes | "$SDK/cmdline-tools/latest/bin/sdkmanager" --sdk_root="$SDK" --licenses >/dev/null
"$SDK/cmdline-tools/latest/bin/sdkmanager" --sdk_root="$SDK" "platforms;android-34" "build-tools;34.0.0" "platform-tools"
curl -fsSL -o gradle.zip https://services.gradle.org/distributions/gradle-8.7-bin.zip
rm -rf /opt/gradle /opt/gradle-8.7 && unzip -q gradle.zip -d /opt && mv /opt/gradle-8.7 /opt/gradle && rm -f gradle.zip
chmod -R a+rX "$SDK" /opt/gradle
echo "Android SDK installed. Ask the assistant to build your app."
