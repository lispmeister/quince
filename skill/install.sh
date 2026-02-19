#!/bin/bash
set -e

echo "Installing Quince for OpenClaw..."

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

# Install quince globally
echo "Installing quince..."
npm install -g quince

# Generate identity if not exists
if [ ! -f ~/.quince/id ]; then
    echo "Generating identity..."
    quince init
fi

# Register on quincemail.com directory
PUBKEY=$(cat ~/.quince/id_pub)
USERNAME=$(jq -r '.username // "agent"' ~/.quince/config.json 2>/dev/null || echo "agent")

echo "Registering with directory..."
curl -sf -X POST https://quincemail.com/api/directory/register \
  -H 'Content-Type: application/json' \
  -d "{\"username\": \"$USERNAME\", \"pubkey\": \"$PUBKEY\"}" || true

echo ""
echo "Quince installed successfully!"
echo "Public key: $PUBKEY"
echo "Email: $USERNAME@quincemail.com"
echo ""
echo "Start the daemon with: quince start &"
