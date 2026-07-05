#!/usr/bin/env bash
# Native Linux bootstrap (no Wine). Requires Node.js only.
# TIR_BOOTSTRAP=1 builds gen1 via --backend=tir-x64 (M2 byte-match with x64).
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

STAGES="${1:-3}"
TIR_BOOTSTRAP="${TIR_BOOTSTRAP:-0}"
TMP_DIR="$(mktemp -d /tmp/yoyo-native-bs-XXXXXX)"
cleanup() { rm -f "$ROOT_DIR/input.ky" "$ROOT_DIR/output" "$ROOT_DIR/output.exe"; rm -rf "$TMP_DIR"; }
trap cleanup EXIT

echo "=== yoyo native Linux bootstrap (TIR_BOOTSTRAP=${TIR_BOOTSTRAP}) ==="

echo "[1] node yoyo-gen.js --target=linux"
node src/yoyo-gen.js --target=linux >/dev/null

GEN1_BACKEND="x64"
if [[ "$TIR_BOOTSTRAP" == "1" ]]; then
  GEN1_BACKEND="tir-x64"
fi

echo "[2] node yoyo.js --backend=${GEN1_BACKEND} --target=linux -> build/yoyo (gen1)"
mkdir -p build
node src/yoyo.js --backend="${GEN1_BACKEND}" --target=linux projects/yoyo.ty build/yoyo

run_gen() {
  local label="$1"
  local compiler="$2"
  rm -f "$ROOT_DIR/input.ky" "$ROOT_DIR/output" "$ROOT_DIR/output.exe"
  cp projects/yoyo.ty "$ROOT_DIR/input.ky"
  echo "[*] $label: $compiler"
  set +e
  timeout --foreground 120s "$compiler"
  local code=$?
  set -e
  if [[ $code -eq 124 ]]; then
    echo "[!] $label timeout"
    exit 1
  fi
  if [[ $code -eq 124 ]]; then
    echo "[!] $label timeout"
    exit 1
  fi
  if [[ ! -f "$ROOT_DIR/output" ]]; then
    echo "[!] $label: output not found (exit=$code)"
    exit 1
  fi
  if [[ $code -ne 0 ]]; then
    echo "[!] $label: compiler exited with code $code (output saved anyway)"
  fi
  cp "$ROOT_DIR/output" "$TMP_DIR/$(basename "$label").elf"
  echo "  -> output: $(wc -c < "$ROOT_DIR/output") bytes"
}

run_gen "gen1" "$ROOT_DIR/build/yoyo"
cp build/yoyo "$TMP_DIR/gen1.elf"

if [[ "$STAGES" -lt 2 ]]; then
  echo "bootstrap-native: stage 1 PASS"
  exit 0
fi

chmod +x "$TMP_DIR/gen1.elf"
run_gen "gen2" "$TMP_DIR/gen1.elf"

if [[ "$STAGES" -lt 3 ]]; then
  echo "bootstrap-native: stage 2 PASS"
  exit 0
fi

chmod +x "$TMP_DIR/gen2.elf"
cp "$TMP_DIR/gen2.elf" "$ROOT_DIR/build/gen2.elf"
echo "  saved gen2.elf to build/gen2.elf ($(wc -c < "$ROOT_DIR/build/gen2.elf") bytes)"
run_gen "gen3" "$TMP_DIR/gen2.elf"

if cmp -s "$TMP_DIR/gen2.elf" "$TMP_DIR/gen3.elf"; then
  echo "gen2 vs gen3: PASS (byte-identical)"
  echo "bootstrap-native: PASS"
else
  DIFFS=$(cmp -l "$TMP_DIR/gen2.elf" "$TMP_DIR/gen3.elf" 2>/dev/null | wc -l || true)
  echo "gen2 vs gen3: FAIL ($DIFFS differing byte pairs)"
  echo "bootstrap-native: FAIL (Stage 3 - see docs/PENDING.md)"
  exit 1
fi