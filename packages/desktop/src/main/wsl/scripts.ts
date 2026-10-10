export function shellEscape(value: string) {
  return `'${value.replace(/'/g, `'"'"'`)}'`
}

/** WSL must use Linux tools, never executables inherited from the Windows PATH. */
export function wslLinuxPath() {
  return ['PATH=$(awk -v RS=: -v ORS=: \'$0 !~ /^\\/mnt\\//\' <<<"$PATH" | sed "s/:$//")', "export PATH"].join("\n")
}

export function wslToolsProbeScript() {
  return [
    wslLinuxPath(),
    "for tool in sh curl tar uname awk sed cut sort cmp wc grep find mktemp tr mkdir cp mv chmod rm rmdir; do",
    '  command -v "$tool" >/dev/null 2>&1 || { printf no; exit 0; }',
    "done",
    "command -v sha256sum >/dev/null 2>&1 || command -v shasum >/dev/null 2>&1 || { printf no; exit 0; }",
    "command -v ldd >/dev/null 2>&1 || command -v getconf >/dev/null 2>&1 || { printf no; exit 0; }",
    "printf yes",
  ].join("\n")
}

export function wslInstallScript(version: string) {
  return [
    "set -eu",
    wslLinuxPath(),
    `expected=${shellEscape(version)}`,
    `tools=$(${wslToolsProbeScript()})`,
    '[ "$tools" = yes ] || { printf "%s\\n" "Install Linux curl, tar and SHA-256 tools in this distro, then choose Install Vector again." >&2; exit 1; }',
    'root="$HOME/.vector/bin"',
    'for item in "$HOME/.vector" "$root" "$root/vector-native" "$root/.vector-vector-native"; do [ ! -L "$item" ] || { printf "%s\\n" "Refusing a linked WSL installation path." >&2; exit 1; }; done',
    'mkdir -p "$root"',
    'temporary=$(mktemp -d "$root/.vector-wsl.XXXXXX")',
    "backup=false; replacing=false; committed=false; legacy_lock=false",
    // Only this historical desktop-managed filename may migrate without a
    // standalone receipt. The generic installer retains its ownership checks.
    `cleanup() {
  result=$?
  trap - EXIT
  if [ "$committed" != true ] && [ "$replacing" = true ]; then
    rm -f "$root/vector-native"
    rm -rf "$root/.vector-vector-native"
  fi
  if [ "$committed" != true ] && [ "$backup" = true ] && [ -f "$temporary/previous" ]; then
    if ! mv "$temporary/previous" "$root/vector-native"; then
      printf '%s\\n' "Vector could not restore the previous WSL binary. Its backup remains at $temporary/previous." >&2
      exit 1
    fi
  fi
  rm -rf "$temporary"
  if [ "$legacy_lock" = true ]; then rmdir "$root/.vector-vector-native.lock"; fi
  exit "$result"
}`,
    "trap cleanup EXIT",
    "trap 'exit 1' HUP INT TERM",
    'status=$(curl --fail --silent --show-error --proto "=https" --tlsv1.2 --max-time 60 --max-filesize 1048576 --write-out \'%{http_code}\' --output "$temporary/install" https://vectordev.ai/install)',
    '[ "$status" = 200 ] || { printf "%s\\n" "Vector installer download returned an unexpected response or redirect." >&2; exit 1; }',
    `if [ -e "$root/vector-native" ] && [ ! -e "$root/.vector-vector-native" ]; then
  mkdir "$root/.vector-vector-native.lock" || { printf '%s\\n' 'Another Vector installation is running or requires inspection.' >&2; exit 1; }
  legacy_lock=true
  [ ! -e "$root/.vector-vector-native" ] && [ ! -L "$root/vector-native" ] || { printf '%s\\n' 'The WSL installation changed while preparing its upgrade.' >&2; exit 1; }
  [ -f "$root/vector-native" ] && [ -x "$root/vector-native" ] || { printf '%s\\n' 'Refusing an unrelated WSL installation path.' >&2; exit 1; }
  sh "$temporary/install" --version "$expected" --install-dir "$temporary/candidate" --binary-name vector-native
  receipt="$temporary/candidate/.vector-vector-native/receipt.tsv"
  test -f "$receipt" && test ! -L "$receipt"
  test "$(wc -l < "$receipt" | tr -d ' ')" = 1
  awk -F '\\t' -v version="$expected" 'NF != 8 || $1 != "vector-standalone" || $2 != "1" || $3 != version || $4 !~ /^linux-(x64(-baseline)?|arm64)(-musl)?$/ || ($5 != "latest" && $5 != "beta") || $6 != "vector-native" || length($7) != 64 || $7 !~ /^[a-f0-9]+$/ || length($8) != 64 || $8 !~ /^[a-f0-9]+$/ { exit 1 }' "$receipt"
  candidate="$temporary/candidate/vector-native"
  test -f "$candidate" && test ! -L "$candidate"
  if command -v sha256sum >/dev/null 2>&1; then digest=$(sha256sum "$candidate"); else digest=$(shasum -a 256 "$candidate"); fi
  test "$(printf '%s' "$digest" | cut -d ' ' -f 1)" = "$(cut -f 7 "$receipt")"
  test "$(VECTOR_CLI=1 "$candidate" --version)" = "$expected"
  backup=true
  mv "$root/vector-native" "$temporary/previous"
  replacing=true
  mv "$candidate" "$root/vector-native"
  mv "$temporary/candidate/.vector-vector-native" "$root/.vector-vector-native"
else
  sh "$temporary/install" --version "$expected" --install-dir "$root" --binary-name vector-native
fi`,
    'actual=$(VECTOR_CLI=1 "$root/vector-native" --version)',
    '[ "$actual" = "$expected" ] || { printf "%s\\n" "The installed Vector CLI does not match the required version $expected." >&2; exit 1; }',
    'test -f "$root/.vector-vector-native/receipt.tsv" || { printf "%s\\n" "Vector installation receipt is missing. Reinstall Vector." >&2; exit 1; }',
    "committed=true",
  ].join("\n")
}

export function wslResolveScript() {
  return 'if [ -x "$HOME/.vector/bin/vector-native" ]; then printf "%s\\n" "$HOME/.vector/bin/vector-native"; fi'
}

export function wslServerScript(input: {
  binary: string
  port: number
  logLevel: "WARN" | "INFO"
  env: Record<string, string>
}) {
  // A complete compound command lets Bash execute while stdin remains open as
  // a control channel. EOF stops the owned Linux process group, even if Windows
  // disconnects. Job control gives the child its own group, separate from Bash.
  return [
    "set +xv",
    "{",
    "set -euo pipefail",
    "set -m",
    'cd "$HOME" || cd /',
    wslLinuxPath(),
    "export WSLENV=",
    ...Object.entries(input.env).map(([key, value]) => `export ${key}=${shellEscape(value)}`),
    "export VECTOR_CLI=1",
    // The desktop's own check-in reports its use and honours Share usage counts; a WSL server it runs never reports.
    "export VECTOR_DISABLE_USAGE=1",
    'export XDG_STATE_HOME="$HOME/.local/state"',
    `${shellEscape(input.binary)} --print-logs --log-level ${input.logLevel} serve --hostname 127.0.0.1 --port ${input.port} </dev/null &`,
    "vector_pid=$!",
    "(",
    "  IFS= read -r control || true",
    '  kill -TERM -- "-$vector_pid" 2>/dev/null || true',
    "  sleep 3",
    '  kill -KILL -- "-$vector_pid" 2>/dev/null || true',
    ") <&0 &",
    "control_pid=$!",
    'trap \'kill -KILL -- "-$control_pid" 2>/dev/null || true; kill -KILL -- "-$vector_pid" 2>/dev/null || true; wait 2>/dev/null || true\' EXIT',
    'wait "$vector_pid"',
    "}",
    "",
  ].join("\n")
}
