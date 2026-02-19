#!/bin/bash
# One-line installer for quince
# Usage: curl -fsSL https://raw.githubusercontent.com/yourusername/quince/main/install.sh | bash

set -e

INSTALL_DIR="${HOME}/.local/bin"
QUINCE_VERSION="0.1.0"
REPO_URL="https://github.com/yourusername/quince"

echo "Installing Quince ${QUINCE_VERSION}..."

# Check Node.js
if ! command -v node &> /dev/null; then
    echo "Error: Node.js 22+ is required"
    exit 1
fi

NODE_VERSION=$(node --version | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 22 ]; then
    echo "Error: Node.js 22+ required (found $(node --version))"
    exit 1
fi

# Create install directory
mkdir -p "$INSTALL_DIR"

# Download and extract
cd /tmp
rm -rf quince-install
mkdir quince-install
cd quince-install

echo "Downloading quince..."
curl -fsSL "${REPO_URL}/releases/download/v${QUINCE_VERSION}/quince-${QUINCE_VERSION}.tar.gz" | tar -xz

# Install
cp bin/quince "$INSTALL_DIR/"
cp -r dist "$INSTALL_DIR/quince-dist"
chmod +x "$INSTALL_DIR/quince"

# Fix path in binary
sed -i.bak "s|/tmp/quince-install/dist|${INSTALL_DIR}/quince-dist|g" "$INSTALL_DIR/quince" 2>/dev/null || \
sed -i '' "s|/tmp/quince-install/dist|${INSTALL_DIR}/quince-dist|g" "$INSTALL_DIR/quince"
rm -f "$INSTALL_DIR/quince.bak"

# Cleanup
cd ..
rm -rf quince-install

# Initialize
if [ ! -f ~/.quince/id ]; then
    echo "Generating identity..."
    "$INSTALL_DIR/quince" init
fi

echo ""
echo "Quince ${QUINCE_VERSION} installed to ${INSTALL_DIR}/quince"
echo "Add ${INSTALL_DIR} to your PATH if not already done"
echo ""
echo "Start the daemon: quince start &"
