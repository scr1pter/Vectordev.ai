#!/usr/bin/env bash
# One-command Vector Cloud deploy. Publishes packages/cloud to your own Vercel
# account so apps published from Vector get a public /s/<slug>/ link that works
# from anywhere — no custom domain required.
#
# Prerequisites (one-time):
#   1. npm i -g vercel   (or use npx — the script falls back to it)
#   2. vercel login
#   3. Create a Blob store in the Vercel dashboard and copy its
#      BLOB_READ_WRITE_TOKEN.
#
# Usage:
#   VECTOR_CLOUD_TOKEN=$(openssl rand -hex 16) \
#   BLOB_READ_WRITE_TOKEN=vercel_blob_rw_xxx \
#   bash script/deploy-cloud.sh
#
# After it prints your deployment URL, set these on the machine running Vector:
#   VECTOR_CLOUD_URL=https://<your-deployment>.vercel.app
#   VECTOR_CLOUD_TOKEN=<the same token you used above>
# Then the Publish button in Vector's preview goes live.

set -euo pipefail
cd "$(dirname "$0")/../packages/cloud"

if command -v vercel >/dev/null 2>&1; then
  VERCEL="vercel"
else
  echo "vercel CLI not found — using npx (slower first run)."
  VERCEL="npx --yes vercel"
fi

: "${VECTOR_CLOUD_TOKEN:?Set VECTOR_CLOUD_TOKEN (e.g. \$(openssl rand -hex 16)) before running.}"
: "${BLOB_READ_WRITE_TOKEN:?Set BLOB_READ_WRITE_TOKEN from your Vercel Blob store before running.}"

echo "Pushing environment secrets to Vercel…"
printf '%s' "$VECTOR_CLOUD_TOKEN"     | $VERCEL env add VECTOR_CLOUD_TOKEN production     >/dev/null 2>&1 || true
printf '%s' "$BLOB_READ_WRITE_TOKEN"  | $VERCEL env add BLOB_READ_WRITE_TOKEN production  >/dev/null 2>&1 || true

echo "Deploying Vector Cloud to production…"
$VERCEL deploy --prod --yes

echo
echo "Done. Set VECTOR_CLOUD_URL to the deployment URL above and reuse the same"
echo "VECTOR_CLOUD_TOKEN on the machine running Vector, then click Publish."
