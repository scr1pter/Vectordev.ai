import { constants, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { access, chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { spawn } from "node:child_process"
import { Option, Schema } from "effect"
import { isReadOnlyMacLocation, macAppBundlePath } from "./mac-update-path"
import type { UpdaterFailure } from "./updater-controller"

const FAILURE_FILE = "updater-failed.json"
const Failure = Schema.Struct({ from: Schema.String, version: Schema.String, reason: Schema.String })

// Arguments: PID ZIP TARGET STAGE LOG FAILED VERSION FROM, where VERSION (the update) and FROM (the running version)
// are JSON-encoded so they can be written into the failure report as they are.
export const macUpdateInstallerScript = `#!/bin/sh
set -u

PID="$1"
ZIP="$2"
TARGET="$3"
STAGE="$4"
LOG="$5"
FAILED="$6"
VERSION="$7"
FROM="$8"
PAYLOAD="$STAGE/payload"
BACKUP="$TARGET.vector-update-backup"

exec >> "$LOG" 2>&1
echo "Vector updater helper started for pid $PID"
rm -f "$FAILED"

# The next launch of Vector reads this report and shows it. Every reason is a fixed message.
record() {
  echo "$1"
  printf '{"from":%s,"version":%s,"reason":"%s"}\\n' "$FROM" "$VERSION" "$1" > "$FAILED"
}

fail() {
  record "$1"
  if [ ! -e "$TARGET" ] && [ -e "$BACKUP" ]; then mv "$BACKUP" "$TARGET"; fi
  rm -rf "$STAGE"
  /usr/bin/open "$TARGET" || true
  exit 1
}

attempt=0
while kill -0 "$PID" 2>/dev/null; do
  attempt=$((attempt + 1))
  if [ "$attempt" -gt 300 ]; then
    # Vector is still running, so there is nothing to reopen.
    record "Timed out waiting for Vector to close"
    rm -rf "$STAGE"
    exit 1
  fi
  sleep 0.2
done

mkdir -p "$PAYLOAD"
if ! /usr/bin/ditto -x -k "$ZIP" "$PAYLOAD"; then
  fail "Could not extract the downloaded update"
fi

SOURCE="$PAYLOAD/Vector.app"
if [ ! -x "$SOURCE/Contents/MacOS/Vector" ]; then
  fail "The downloaded update does not contain a valid Vector.app"
fi

if ! /usr/bin/codesign --verify --deep --strict --verbose=2 "$SOURCE"; then
  fail "The downloaded update has an invalid code signature"
fi

# Interim releases are ad-hoc signed, so they carry no Team ID, and still reach installed copies through
# Check for Updates (owner decision, 2 October 2026). Once the installed app carries a Team ID, an update must
# keep it and its designated requirement and pass Gatekeeper, so a signed install is never replaced by an
# unsigned or differently signed app.
CURRENT_TEAM=$(/usr/bin/codesign -d --verbose=4 "$TARGET" 2>&1 | /usr/bin/sed -n 's/^TeamIdentifier=//p' | /usr/bin/head -n 1)
if [ -n "$CURRENT_TEAM" ] && [ "$CURRENT_TEAM" != "not set" ]; then
  SOURCE_TEAM=$(/usr/bin/codesign -d --verbose=4 "$SOURCE" 2>&1 | /usr/bin/sed -n 's/^TeamIdentifier=//p' | /usr/bin/head -n 1)
  if [ "$SOURCE_TEAM" != "$CURRENT_TEAM" ]; then
    fail "The downloaded update does not match Vector's signing identity"
  fi

  CURRENT_REQUIREMENT=$(/usr/bin/codesign -d -r- "$TARGET" 2>&1 | /usr/bin/sed -n 's/^designated => //p' | /usr/bin/head -n 1)
  SOURCE_REQUIREMENT=$(/usr/bin/codesign -d -r- "$SOURCE" 2>&1 | /usr/bin/sed -n 's/^designated => //p' | /usr/bin/head -n 1)
  if [ -z "$CURRENT_REQUIREMENT" ] || [ "$SOURCE_REQUIREMENT" != "$CURRENT_REQUIREMENT" ]; then
    fail "The downloaded update does not match Vector's designated requirement"
  fi

  if ! /usr/sbin/spctl --assess --type execute --verbose=2 "$SOURCE"; then
    fail "The downloaded update is not notarized for this Mac"
  fi
fi

rm -rf "$BACKUP"
if [ -e "$TARGET" ] && ! mv "$TARGET" "$BACKUP"; then
  fail "Could not move the current app aside"
fi

if ! mv "$SOURCE" "$TARGET"; then
  fail "Could not move the new app into place"
fi

if ! /usr/bin/open "$TARGET"; then
  rm -rf "$TARGET"
  fail "Could not open the updated Vector, so the previous version was restored"
fi

sleep 3
rm -rf "$BACKUP" "$STAGE"
echo "Vector update installed successfully"
`

// Checks everything that can refuse the install and stages the helper, but starts nothing: the caller stops Vector's
// services first and then calls the returned launch, or discard if the install fails before that.
export async function prepareMacUpdateInstaller(input: {
  archive: string | undefined
  executable: string
  userData: string
  version: string
  from: string
}) {
  const zip = input.archive
  const archive = zip?.endsWith(".zip") ? await stat(zip).catch(() => undefined) : undefined
  if (!zip || !archive?.isFile() || archive.size === 0) {
    throw new Error("The downloaded update is missing or incomplete. Check for updates to download it again.")
  }

  const target = macAppBundlePath(input.executable)
  if (isReadOnlyMacLocation(target)) {
    throw new Error(
      "Vector is running from a disk image, an external volume or a temporary read-only copy, so it cannot replace itself. Move Vector to your Applications folder, reopen it and try again.",
    )
  }
  const parent = dirname(target)
  await access(parent, constants.W_OK).catch(() => {
    throw new Error(
      `Vector cannot replace ${target} because its folder is not writable for your account. Move Vector to your Applications folder or another folder you can write to, reopen it and try again.`,
    )
  })

  // userData/logs is the folder debug-log export collects. It is created before the stage so a failure here leaves
  // nothing next to the app.
  const logs = join(input.userData, "logs")
  await mkdir(logs, { recursive: true })
  const stage = await mkdtemp(join(parent, ".vector-update-"))
  const script = join(stage, "install-vector-update.sh")
  // The caller only gets discard once this returns, so a failure while staging (e.g. a full disk) removes the stage.
  await writeFile(script, macUpdateInstallerScript, { encoding: "utf8", mode: 0o700 })
    .then(() => chmod(script, 0o700))
    .catch(async (error) => {
      await rm(stage, { recursive: true, force: true })
      throw error
    })

  return {
    launch() {
      spawn(
        "/bin/sh",
        [
          script,
          String(process.pid),
          zip,
          target,
          stage,
          join(logs, "updater-helper.log"),
          join(input.userData, FAILURE_FILE),
          JSON.stringify(input.version),
          JSON.stringify(input.from),
        ],
        { detached: true, stdio: "ignore" },
      ).unref()
    },
    // Only the helper removes the stage once it runs, so an install abandoned before launch must remove it here.
    discard: () => rm(stage, { recursive: true, force: true }),
  }
}

export function recordUpdateFailure(userData: string, failure: UpdaterFailure) {
  writeFileSync(join(userData, FAILURE_FILE), JSON.stringify(failure))
}

// Returns the failure an earlier run recorded, by this process before a relaunch or by the macOS helper, and removes
// it so it is reported once.
export function takeUpdateFailure(userData: string) {
  const file = join(userData, FAILURE_FILE)
  if (!existsSync(file)) return
  const text = readFileSync(file, "utf8")
  rmSync(file, { force: true })
  return Option.getOrUndefined(Schema.decodeUnknownOption(Schema.fromJsonString(Failure))(text))
}
