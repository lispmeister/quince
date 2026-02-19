#!/bin/bash
set -e

# Quince installer for OpenClaw
# Installs quince to $HOME/.local/bin

INSTALL_DIR="${HOME}/.local/bin"
QUINCE_VERSION="0.1.0"

echo "Installing Quince ${QUINCE_VERSION}..."

# Check Node.js version
if ! command -v node &> /dev/null; then
    echo "Error: Node.js is required but not installed"
    exit 1
fi

NODE_VERSION=$(node --version | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 22 ]; then
    echo "Error: Node.js 22+ required (found $(node --version))"
    exit 1
fi

# Create install directory
mkdir -p "$INSTALL_DIR"

# Build and install quince locally
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_DIR"

echo "Building quince..."
npm run build > /dev/null 2>&1

# Copy binary
cp bin/quince "$INSTALL_DIR/quince"
chmod +x "$INSTALL_DIR/quince"

# Copy compiled dist
cp -r dist "$INSTALL_DIR/quince-dist"

# Update binary to point to local dist
sed -i.bak "s|\"$PROJECT_DIR/dist/index.js\"|\"$INSTALL_DIR/quince-dist/index.js\"|g" "$INSTALL_DIR/quince"
rm "$INSTALL_DIR/quince.bak"

echo "Quince installed to $INSTALL_DIR/quince"

# Initialize if needed
if [ ! -f ~/.quince/id ]; then
    echo "Generating identity..."
    "$INSTALL_DIR/quince" init
fi

# Register with directory
PUBKEY=$(cat ~/.quince/id_pub 2>/dev/null || echo "")
if [ -n "$PUBKEY" ]; then
    USERNAME=$(jq -r '.username // "agent"' ~/.quince/config.json 2>/dev/null || echo "agent")
    echo "Registering with directory..."
    curl -sf -X POST https://quincemail.com/api/directory/register \
      -H 'Content-Type: application/json' \
      -d "{\"username\": \"$USERNAME\", \"pubkey\": \"$PUBKEY\"}" || true
fi

echo ""
echo "Quince installed successfully!"
echo "Public key: $PUBKEY"
echo "Email: $USERNAME@quincemail.com"
echo ""
echo "Start the daemon with: $INSTALL_DIR/quince start &"
echo "Make sure $INSTALL_DIR is in your PATH"
