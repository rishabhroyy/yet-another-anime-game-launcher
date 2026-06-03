#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
cd "${ROOT_DIR}"

APP_NAME="Yaagl OS.app"
PYTHON_VERSION_FILE="sophon_server/.python-version"
PATCHED_SOPHON_BUILD_SCRIPT=""

restore_python_version_file() {
  if git ls-files --error-unmatch "${PYTHON_VERSION_FILE}" >/dev/null 2>&1; then
    git restore --source=HEAD -- "${PYTHON_VERSION_FILE}"
  fi
}

cleanup() {
  restore_python_version_file

  if [ -n "${PATCHED_SOPHON_BUILD_SCRIPT}" ]; then
    rm -f -- "${PATCHED_SOPHON_BUILD_SCRIPT}"
  fi
}

trap cleanup EXIT

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

build_sophon_for_pyenv() {
  PATCHED_SOPHON_BUILD_SCRIPT="$(mktemp "${TMPDIR:-/tmp}/yaagl-build-sophon.XXXXXX")"

  awk '
    {
      print
      if ($0 == "--output-dir=./build \\") {
        print "--static-libpython=no \\"
      }
    }
  ' ./build-sophon.sh > "${PATCHED_SOPHON_BUILD_SCRIPT}"

  if ! grep -q -- "--static-libpython=no" "${PATCHED_SOPHON_BUILD_SCRIPT}"; then
    printf 'Failed to prepare pyenv-safe Sophon build script.\n' >&2
    return 1
  fi

  bash -e "${PATCHED_SOPHON_BUILD_SCRIPT}"

  if [ ! -d "sophon_server/build/server.dist" ]; then
    printf 'Sophon build did not produce sophon_server/build/server.dist.\n' >&2
    return 1
  fi
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

log_step "Removing local pyenv version pin for this build"
remove_path "${PYTHON_VERSION_FILE}"

log_step "Building Sophon server"
build_sophon_for_pyenv

log_step "Building Yaagl OS.app"
YAAGL_CHANNEL_CLIENT=hoyoplay node ./build-app.js

log_step "Finished"
printf 'Built app: %s/%s\n' "${ROOT_DIR}" "${APP_NAME}"
