# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.2] - 2026-02-19

### Added
- ASCII logo and startup banner with version, ports, and peer count
- `test/utils.test.ts`: unit tests for `generateId`, `encodeBase64`, `decodeBase64`
- `package-lock.json` included in release tarball for reproducible installs

### Fixed
- `skill/SKILL.md`: `requires.binaries` → `requires.bins` (OpenClaw spec compliance)
- `skill/install.sh`: rewritten to download GitHub release tarball instead of building from source
- CI workflow now correctly triggers release job on tag pushes

## [0.1.1] - 2026-02-19

### Added
- CI workflow with Node.js 22.12 and 23.x matrix
- GitHub Actions release job: builds and uploads tarball on version tags
- `install.sh`: one-line installer from GitHub releases

### Fixed
- Migrated from Bare/Bun runtime to Node.js 22.12+ (OpenClaw compatibility)
- Removed all `bare-*` dependencies
- `bin/quince`: updated launcher to use `node` directly

## [0.1.0] - 2026-01-01

### Added
- Initial release
- SMTP server (localhost:2525), POP3 server (localhost:1110), HTTP API (localhost:2580)
- Ed25519 keypair identity and message signing
- Hyperswarm P2P transport with mutual whitelist
- Outbound message queue with exponential backoff retry
- Hyperdrive file transfer via `quince:/media/` URI scheme
- Peer capabilities, status broadcasts, and introductions
- Gate inbox for paid legacy email
- Directory service integration (quincemail.com)
