#!/bin/sh
# Installs the `vector` terminal command for local use.
# Prefers the compiled CLI binary (identical to the npm package); build it with
#   cd packages/opencode && OPENCODE_VERSION=<version> bun run script/build.ts --single
# Rerun any time; it overwrites the launcher.
set -eu

REPO_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
BIN_DIR="${VECTOR_BIN_DIR:-$HOME/.local/bin}"
TARGET="$BIN_DIR/vector"
OS="$(uname -s | tr '[:upper:]' '[:lower:]')"; ARCH="$(uname -m)"
case "$ARCH" in x86_64) ARCH=x64 ;; aarch64) ARCH=arm64 ;; esac
BINARY="$REPO_DIR/packages/opencode/dist/opencode-$OS-$ARCH/bin/opencode"

[ -x "$BINARY" ] || { echo "No compiled CLI at $BINARY"; echo "Build it first: cd $REPO_DIR/packages/opencode && OPENCODE_VERSION=\$(node -p \"require('../desktop/package.json').version\") bun run script/build.ts --single"; exit 1; }
mkdir -p "$BIN_DIR"
cat > "$TARGET" <<LAUNCH
#!/bin/sh
# Vector CLI — compiled binary from $REPO_DIR (same artifact as @vectordevai/cli)
export VECTOR_CLI=1
exec "$BINARY" "\$@"
LAUNCH
chmod +x "$TARGET"
echo "Installed: $TARGET → $BINARY"
case ":$PATH:" in *":$BIN_DIR:"*) echo 'Try it: cd into a project, then run: vector' ;; *) echo "Add $BIN_DIR to your PATH, then run: vector" ;; esac
