#!/usr/bin/env bash
# Clean local build of the HoYoPlay app. Usage: scripts/clean-build-hoyoplay.sh [hoyoplay|hoyoplaycn]
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
cd "${ROOT_DIR}"

CHANNEL="${1:-hoyoplay}"
case "${CHANNEL}" in
  hoyoplay) APP_NAME="Yaagl OS.app" ;;
  hoyoplaycn) APP_NAME="Yaagl CN.app" ;;
  *)
    printf 'Unknown channel %s (expected hoyoplay or hoyoplaycn)\n' "${CHANNEL}" >&2
    exit 1
    ;;
esac

log_step() {
  printf '\n==> %s\n' "$*"
}

remove_path() {
  local target="$1"

  if [ -e "${target}" ] || [ -L "${target}" ]; then
    printf 'Removing %s\n' "${target}"
    rm -rf -- "${target}"
  fi
}

log_step "Cleaning app build outputs"
remove_path "dist"
remove_path ".tmp"
remove_path "${APP_NAME}"
remove_path "sidecar/sophon"
# leftovers from the pre-0.4.0 Python Sophon server
remove_path "sidecar/sophon_server"
remove_path "sophon_server"

log_step "Cleaning development run folders"
for dev_dir in yaaglwd yaaglwdos hoyoplaywd hoyoplaycnwd bh3glb hkrpgos hkrpgcn cbjq cbjqcn napcn napos; do
  remove_path "${dev_dir}"
done

log_step "Updating SophonClientv3 submodule"
git submodule update --init --recursive

# build-app.js runs ./build-sophon.sh (Swift) itself.
log_step "Building ${APP_NAME}"
YAAGL_CHANNEL_CLIENT="${CHANNEL}" node ./build-app.js

log_step "Finished"
printf 'Built app: %s/%s\n' "${ROOT_DIR}" "${APP_NAME}"
