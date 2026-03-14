#!/bin/sh
set -e

REPO="dhruvyad/wahooks"
INSTALL_DIR="/usr/local/bin"
BINARY_NAME="wahooks"

# Detect OS and architecture
OS=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)

case "$ARCH" in
  x86_64|amd64) ARCH="amd64" ;;
  arm64|aarch64) ARCH="arm64" ;;
  *) echo "Unsupported architecture: $ARCH"; exit 1 ;;
esac

case "$OS" in
  darwin|linux) ;;
  *) echo "Unsupported OS: $OS"; exit 1 ;;
esac

ASSET_NAME="wahooks-${OS}-${ARCH}"

# Get latest CLI release tag
LATEST_TAG=$(curl -fsSL "https://api.github.com/repos/${REPO}/releases" | \
  grep '"tag_name"' | grep 'cli-v' | head -1 | sed 's/.*"tag_name": *"//;s/".*//')

if [ -z "$LATEST_TAG" ]; then
  echo "Error: Could not find a CLI release"
  exit 1
fi

DOWNLOAD_URL="https://github.com/${REPO}/releases/download/${LATEST_TAG}/${ASSET_NAME}"

echo "Downloading wahooks ${LATEST_TAG} for ${OS}/${ARCH}..."
TMP=$(mktemp)
curl -fsSL "$DOWNLOAD_URL" -o "$TMP"
chmod +x "$TMP"

# Install
if [ -w "$INSTALL_DIR" ]; then
  mv "$TMP" "${INSTALL_DIR}/${BINARY_NAME}"
else
  echo "Installing to ${INSTALL_DIR} (requires sudo)..."
  sudo mv "$TMP" "${INSTALL_DIR}/${BINARY_NAME}"
fi

echo "wahooks installed to ${INSTALL_DIR}/${BINARY_NAME}"
wahooks --help 2>/dev/null && echo "" || true
echo "Run 'wahooks login' to get started."
