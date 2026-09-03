#!/bin/sh
# Installs the `vector` terminal command for local development.
# It launches the Vector agent straight from this repo via bun, so the
# command always tracks your working tree. Rerun any time; it overwrites.
set -eu

REPO_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
BIN_DIR="${VECTOR_BIN_DIR:-$HOME/.local/bin}"
TARGET="$BIN_DIR/vector"

command -v bun >/dev/null 2>&1 || { echo "bun is required (https://bun.sh)"; exit 1; }
mkdir -p "$BIN_DIR"

cat > "$TARGET" <<EOF
#!/bin/sh
# Vector CLI — launches the agent from $REPO_DIR
export VECTOR_CLI=1
# Absolute entry path, no --cwd: the agent must open in the caller's directory.
exec bun run --conditions=browser "$REPO_DIR/packages/opencode/src/index.ts" "\$@"
EOF
chmod +x "$TARGET"

echo "Installed: $TARGET"
case ":$PATH:" in
  *":$BIN_DIR:"*) echo 'Try it: vector' ;;
  *) echo "Add $BIN_DIR to your PATH, then run: vector" ;;
esac
