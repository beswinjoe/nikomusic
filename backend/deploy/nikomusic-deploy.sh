#!/usr/bin/env bash
# Pulls main and rebuilds. The GitHub deploy key is pinned to this script
# (forced command), so a leaked key can do nothing but redeploy main.
set -euo pipefail
SRC=/opt/nikomusic-src
REPO_URL="${REPO_URL:-}"
if [ ! -d "$SRC/.git" ]; then
  : "${REPO_URL:?set REPO_URL or pre-clone the repository to $SRC}"
  git clone --depth 1 --branch main "$REPO_URL" "$SRC"
fi
git -C "$SRC" fetch --depth 1 origin main
git -C "$SRC" reset --hard FETCH_HEAD
echo "deploying $(git -C "$SRC" log -1 --format='%h %s')"
DOMAIN="$(cat /etc/nikomusic-domain)" bash "$SRC/backend/deploy/setup.sh"
