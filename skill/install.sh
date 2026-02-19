#!/bin/bash
set -e

# Quince installer for OpenClaw
# Downloads the release tarball from GitHub, installs to ~/.local

QUINCE_VERSION="0.1.1"
REPO_URL="https://github.com/lispmeister/quince"
INSTALL_DIR="${HOME}/.local/lib/quince"
BIN_DIR="${HOME}/.local/bin"

echo "Installing Quince ${QUINCE_VERSION}..."

# Check Node.js version (>=22.12 required for OpenClaw compatibility)
if ! command -v node &> /dev/null; then
    echo "Error: Node.js is required but not installed"
    exit 1
fi

NODE_MAJOR=$(node --version | cut -d'v' -f2 | cut -d'.' -f1)
NODE_MINOR=$(node --version | cut -d'v' -f2 | cut -d'.' -f2)
if [ "$NODE_MAJOR" -lt 22 ] || { [ "$NODE_MAJOR" -eq 22 ] && [ "$NODE_MINOR" -lt 12 ]; }; then
    echo "Error: Node.js 22.12+ required (found $(node --version))"
    exit 1
fi

# Download and extract release tarball
echo "Downloading quince v${QUINCE_VERSION}..."
cd /tmp
rm -rf quince-install
mkdir quince-install
cd quince-install

TARBALL_URL="${REPO_URL}/releases/download/v${QUINCE_VERSION}/quince-v${QUINCE_VERSION}.tar.gz"
if ! curl -fsSL "$TARBALL_URL" | tar -xz; then
    echo "Error: Failed to download release from $TARBALL_URL"
    echo "Check that the release exists: ${REPO_URL}/releases/tag/v${QUINCE_VERSION}"
    exit 1
fi

# Install to ~/.local/lib/quince (preserves bin/dist relative structure)
rm -rf "$INSTALL_DIR"
mkdir -p "$INSTALL_DIR" "$BIN_DIR"
cp -r quince-v${QUINCE_VERSION}/* "$INSTALL_DIR/"
chmod +x "$INSTALL_DIR/bin/quince"

# Symlink into PATH
ln -sf "$INSTALL_DIR/bin/quince" "$BIN_DIR/quince"

# Install npm dependencies (needed for hyperswarm etc.)
cd "$INSTALL_DIR"
npm install --omit=dev --silent 2>/dev/null

# Cleanup
rm -rf /tmp/quince-install

# Initialize identity if needed
if [ ! -f ~/.quince/id ]; then
    echo "Generating identity..."
    "$BIN_DIR/quince" init
fi

# Register with directory
PUBKEY=$(cat ~/.quince/id_pub 2>/dev/null || echo "")
if [ -n "$PUBKEY" ]; then
    USERNAME=$(node -e "try{console.log(JSON.parse(require('fs').readFileSync('$HOME/.quince/config.json','utf8')).username||'agent')}catch{console.log('agent')}" 2>/dev/null || echo "agent")
    echo "Registering with directory..."
    curl -sf -X POST https://quincemail.com/api/directory/register \
      -H 'Content-Type: application/json' \
      -d "{\"username\": \"$USERNAME\", \"pubkey\": \"$PUBKEY\"}" || true
fi

echo ""
echo "Quince ${QUINCE_VERSION} installed successfully!"
echo "Public key: ${PUBKEY}"
echo "Email: ${USERNAME:-agent}@quincemail.com"
echo ""
echo "Start the daemon: quince start &"
echo "Make sure ${BIN_DIR} is in your PATH"
