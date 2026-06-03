#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
cd "${ROOT_DIR}"

APP_NAME="Yaagl OS.app"

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

remove_glob() {
  local artifact

  for artifact in "$@"; do
    [ -e "${artifact}" ] || continue
    remove_path "${artifact}"
  done
}

log_step "Cleaning app build outputs"
remove_path "dist"
remove_path ".tmp"
remove_path "${APP_NAME}"
remove_path "sidecar/sophon_server"

log_step "Cleaning development run folders"
for dev_dir in yaaglwd yaaglwdos hoyoplaywd bh3glb hkrpgos hkrpgcn cbjq cbjqcn napcn napos; do
  remove_path "${dev_dir}"
done

log_step "Cleaning release artifacts"
remove_glob resources_*.neu
remove_glob *.app.tar.gz

log_step "Cleaning Sophon build outputs"
remove_path "sophon_server/build"
remove_path "sophon_server/.cache"
remove_path "sophon_server/hpatchz"
remove_glob "sophon_server/"*.spec
remove_glob "sophon_server/"*.build
remove_glob "sophon_server/"*.dist
remove_glob "sophon_server/"*.onefile-build

log_step "Building Sophon server"
./build-sophon.sh

log_step "Building Yaagl OS.app"
YAAGL_CHANNEL_CLIENT=hoyoplay node ./build-app.js

log_step "Finished"
printf 'Built app: %s/%s\n' "${ROOT_DIR}" "${APP_NAME}"
