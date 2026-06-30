#!/usr/bin/env bash
# Native Linux bootstrap (no Wine). Requires Node.js only.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

STAGES="${1:-3}"
TMP_DIR="$(mktemp -d /tmp/yoyo-native-bs-XXXXXX)"
cleanup() { rm -f "$ROOT_DIR/input.ky" "$ROOT_DIR/output" "$ROOT_DIR/output.exe"; rm -rf "$TMP_DIR"; }
trap cleanup EXIT

echo "=== yoyo native Linux bootstrap ==="

echo "[1] node yoyo-gen.js"
node src/yoyo-gen.js >/dev/null

echo "[2] node yoyo.js --target=linux -> build/yoyo (gen1)"
node src/yoyo.js --target=linux projects/yoyo.ty build/yoyo

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
  if [[ $code -ne 0 ]]; then
    echo "[!] $label: compiler exited with code $code"
    exit 1
  fi
  if [[ ! -f "$ROOT_DIR/output" ]]; then
    echo "[!] $label: output not found (exit=$code)"
    exit 1
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
run_gen "gen3" "$TMP_DIR/gen2.elf"

cmp -s "$TMP_DIR/gen2.elf" "$TMP_DIR/gen3.elf"
echo "gen2 vs gen3: PASS (byte-identical)"
echo "bootstrap-native: PASS"
