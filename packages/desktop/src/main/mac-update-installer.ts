import { constants } from "node:fs"
import { access, chmod, mkdir, mkdtemp, stat, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { spawn } from "node:child_process"
import { app } from "electron"
import { macAppBundlePath } from "./mac-update-path"

const installerScript = `#!/bin/sh
set -u

PID="$1"
ZIP="$2"
TARGET="$3"
STAGE="$4"
LOG="$5"
PAYLOAD="$STAGE/payload"
BACKUP="$TARGET.vector-update-backup"

exec >> "$LOG" 2>&1
echo "Vector updater helper started for pid $PID"

attempt=0
while kill -0 "$PID" 2>/dev/null; do
  attempt=$((attempt + 1))
  if [ "$attempt" -gt 300 ]; then
    echo "Timed out waiting for Vector to close"
    exit 1
  fi
  sleep 0.2
done

mkdir -p "$PAYLOAD"
if ! /usr/bin/ditto -x -k "$ZIP" "$PAYLOAD"; then
  echo "Could not extract the downloaded update"
  exit 1
fi

SOURCE="$PAYLOAD/Vector.app"
if [ ! -x "$SOURCE/Contents/MacOS/Vector" ]; then
  echo "Downloaded update does not contain a valid Vector.app"
  exit 1
fi

rm -rf "$BACKUP"
if [ -e "$TARGET" ] && ! mv "$TARGET" "$BACKUP"; then
  echo "Could not move the current app aside"
  exit 1
fi

if ! mv "$SOURCE" "$TARGET"; then
  echo "Could not move the new app into place"
  if [ -e "$BACKUP" ]; then mv "$BACKUP" "$TARGET"; fi
  exit 1
fi

if ! /usr/bin/open "$TARGET"; then
  echo "Could not reopen Vector; restoring the previous app"
  rm -rf "$TARGET"
  if [ -e "$BACKUP" ]; then mv "$BACKUP" "$TARGET"; fi
  /usr/bin/open "$TARGET" || true
  exit 1
fi

sleep 3
rm -rf "$BACKUP" "$STAGE"
echo "Vector update installed successfully"
`

export async function launchMacUpdateInstaller(zipPath: string) {
  if (process.platform !== "darwin") throw new Error("The macOS update installer is only available on macOS")
  if (!zipPath.endsWith(".zip")) throw new Error("The downloaded macOS update is not a ZIP archive")

  const archive = await stat(zipPath)
  if (!archive.isFile() || archive.size === 0) throw new Error("The downloaded macOS update is empty")

  const target = macAppBundlePath(app.getPath("exe"))
  const parent = dirname(target)
  await access(parent, constants.W_OK).catch(() => {
    throw new Error(`Vector cannot update ${target} because its folder is not writable`)
  })

  const stage = await mkdtemp(join(parent, ".vector-update-"))
  const script = join(stage, "install-vector-update.sh")
  const logs = app.getPath("logs")
  await mkdir(logs, { recursive: true })
  const log = join(logs, "updater-helper.log")
  await writeFile(script, installerScript, { encoding: "utf8", mode: 0o700 })
  await chmod(script, 0o700)

  const child = spawn("/bin/sh", [script, String(process.pid), zipPath, target, stage, log], {
    detached: true,
    stdio: "ignore",
  })
  child.unref()
}
