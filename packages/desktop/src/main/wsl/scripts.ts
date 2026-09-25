export function shellEscape(value: string) {
  return `'${value.replace(/'/g, `'"'"'`)}'`
}

/** Load Linux toolchains explicitly: non-interactive shells often skip .bashrc. */
export function wslNodeSetup() {
  return [
    'PATH=$(awk -v RS=: -v ORS=: \'$0 !~ /^\\/mnt\\//\' <<<"$PATH" | sed "s/:$//")',
    "export PATH",
    'export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"',
    'if [ -s "$NVM_DIR/nvm.sh" ]; then . "$NVM_DIR/nvm.sh"; fi',
    'for directory in "$HOME/.local/share/fnm" "$HOME/.fnm" "$HOME/.volta/bin"; do',
    '  if [ -d "$directory" ]; then PATH="$directory:$PATH"; fi',
    "done",
    "export PATH",
    "if command -v fnm >/dev/null 2>&1; then",
    '  eval "$(fnm env --shell bash)"',
    "  fnm use --silent-if-unchanged >/dev/null 2>&1 || true",
    "fi",
  ].join("\n")
}

export function wslNpmProbeScript() {
  return [
    wslNodeSetup(),
    "if command -v npm >/dev/null 2>&1 && command -v node >/dev/null 2>&1; then printf yes; else printf no; fi",
  ].join("\n")
}

export function wslInstallScript(version: string) {
  return [
    "set -e",
    wslNodeSetup(),
    'command -v npm >/dev/null 2>&1 && command -v node >/dev/null 2>&1 || { printf "%s\\n" "Install Node.js and npm in this Linux distro first, then choose Install Vector again." >&2; exit 1; }',
    `expected=${shellEscape(version)}`,
    `npm install --global --prefix "$HOME/.vector" ${shellEscape(`@vectordevai/cli@${version}`)}`,
    'case "$(uname -m)" in',
    "  x86_64) arch=x64 ;;",
    "  aarch64|arm64) arch=arm64 ;;",
    '  *) printf "%s\\n" "Vector does not support this Linux architecture." >&2; exit 1 ;;',
    "esac",
    'manifest=$(node -e \'console.log(require.resolve(process.argv[2] + "/package.json", { paths: [process.argv[1]] }))\' "$HOME/.vector/lib/node_modules/@vectordevai/cli" "@vectordevai/cli-linux-$arch")',
    'native="${manifest%/package.json}/bin/vector"',
    'test -x "$native" || { printf "%s\\n" "The Vector native package is missing. Reinstall with npm optional dependencies enabled." >&2; exit 1; }',
    'mkdir -p "$HOME/.vector/bin"',
    'temporary="$HOME/.vector/bin/vector-native.$$"',
    "trap 'rm -f \"$temporary\"' EXIT",
    'install -m 755 "$native" "$temporary"',
    'actual=$(VECTOR_CLI=1 "$temporary" --version)',
    '[ "$actual" = "$expected" ] || { printf "%s\\n" "Vector native package version $actual does not match $expected." >&2; exit 1; }',
    'mv -f "$temporary" "$HOME/.vector/bin/vector-native"',
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
  return [
    "set -euo pipefail",
    'cd "$HOME" || cd /',
    'PATH=$(awk -v RS=: -v ORS=: \'$0 !~ /^\\/mnt\\//\' <<<"$PATH" | sed "s/:$//")',
    "export PATH",
    "export WSLENV=",
    ...Object.entries(input.env).map(([key, value]) => `export ${key}=${shellEscape(value)}`),
    "export VECTOR_CLI=1",
    'export XDG_STATE_HOME="$HOME/.local/state"',
    `exec ${shellEscape(input.binary)} --print-logs --log-level ${input.logLevel} serve --hostname 127.0.0.1 --port ${input.port}`,
  ].join("\n")
}
