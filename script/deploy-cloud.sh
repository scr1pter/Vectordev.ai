#!/usr/bin/env bash
# One-command Vector Cloud deploy. Publishes packages/cloud to your own Vercel
# account so apps published from Vector get a public /s/<slug>/ link that works
# from anywhere — no custom domain required.
#
# Prerequisites (one-time):
#   1. Install Node.js/npm. This script downloads and verifies its pinned Vercel CLI.
#   2. Authenticate when the pinned Vercel CLI prompts during the first run.
#   3. Create a Blob store in the Vercel dashboard and copy its
#      BLOB_READ_WRITE_TOKEN.
#
# Usage:
#   VECTOR_CLOUD_TOKEN=$(openssl rand -hex 16) \
#   VECTOR_CLOUD_TENANT=my-team \
#   VECTOR_CLOUD_PROJECT=my-app \
#   BLOB_READ_WRITE_TOKEN=vercel_blob_rw_xxx \
#   bash script/deploy-cloud.sh
#
# After it prints your deployment URL, set these on the machine running Vector:
#   VECTOR_CLOUD_URL=https://<your-deployment>.vercel.app
#   VECTOR_CLOUD_TOKEN=<the same token you used above>
# Then the Publish button in Vector's preview goes live.

set -euo pipefail
cd "$(dirname "$0")/../packages/cloud"

VERCEL_VERSION=48.8.0
VERCEL_INTEGRITY='sha512-ZPoq4txk2OkKAZVi+E+UKEFA70n4FkFmv/PSHTv4wAvJl3n2WvCaGCrfT33b9U9iDGQs9ZnwE2eQDylamc8FVA=='
CLI_DIR=$(mktemp -d)
trap 'rm -rf "$CLI_DIR"' EXIT
archive=$(npm pack "vercel@$VERCEL_VERSION" --ignore-scripts --pack-destination "$CLI_DIR" --silent)
archive="$CLI_DIR/$archive"
actual_integrity="sha512-$(openssl dgst -sha512 -binary "$archive" | openssl base64 -A)"
test "$actual_integrity" = "$VERCEL_INTEGRITY" || {
  echo "Pinned Vercel CLI integrity check failed." >&2
  exit 1
}

vercel_cli() {
  npm exec --yes --package "$archive" -- vercel "$@"
}

: "${VECTOR_CLOUD_TOKEN:?Set VECTOR_CLOUD_TOKEN (e.g. \$(openssl rand -hex 16)) before running.}"
: "${VECTOR_CLOUD_TENANT:?Set VECTOR_CLOUD_TENANT to a DNS-label-safe tenant identifier.}"
: "${VECTOR_CLOUD_PROJECT:?Set VECTOR_CLOUD_PROJECT to a DNS-label-safe project identifier.}"
: "${BLOB_READ_WRITE_TOKEN:?Set BLOB_READ_WRITE_TOKEN from your Vercel Blob store before running.}"
[[ "$VECTOR_CLOUD_TENANT" =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$ ]] || {
  echo "VECTOR_CLOUD_TENANT must be a lowercase DNS label." >&2
  exit 1
}
[[ "$VECTOR_CLOUD_PROJECT" =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$ ]] || {
  echo "VECTOR_CLOUD_PROJECT must be a lowercase DNS label." >&2
  exit 1
}
test "${#VECTOR_CLOUD_TOKEN}" -ge 16 && test "$VECTOR_CLOUD_TOKEN" != "local-dev-token" || {
  echo "VECTOR_CLOUD_TOKEN must be an explicit credential of at least 16 characters." >&2
  exit 1
}

echo "Pushing environment secrets to Vercel…"
printf '%s' "$VECTOR_CLOUD_TOKEN" | vercel_cli env add VECTOR_CLOUD_TOKEN production --force >/dev/null
printf '%s' "$VECTOR_CLOUD_TENANT" | vercel_cli env add VECTOR_CLOUD_TENANT production --force >/dev/null
printf '%s' "$VECTOR_CLOUD_PROJECT" | vercel_cli env add VECTOR_CLOUD_PROJECT production --force >/dev/null
printf '%s' "$BLOB_READ_WRITE_TOKEN" | vercel_cli env add BLOB_READ_WRITE_TOKEN production --force >/dev/null

echo "Deploying Vector Cloud to production…"
vercel_cli deploy --prod --yes

echo
echo "Done. Set VECTOR_CLOUD_URL to the deployment URL above and reuse the same"
echo "VECTOR_CLOUD_TOKEN on the machine running Vector, then click Publish."
