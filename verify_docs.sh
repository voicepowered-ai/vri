#!/bin/bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MANIFEST_FILE="$ROOT_DIR/MANIFEST.sha256"
SIGNATURE_FILE="$ROOT_DIR/MANIFEST.sig"
PUBLIC_KEY_FILE="$ROOT_DIR/PUBLIC_KEY.pem"
AUTHORS_FILE="$ROOT_DIR/AUTHORS.json"
RELEASE_FILE="$ROOT_DIR/RELEASE.json"

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

require_openssl_3() {
  local version major
  version="$(openssl version | awk '{print $2}')"
  major="${version%%.*}"
  if [[ -z "$major" || "$major" -lt 3 ]]; then
    echo "OpenSSL 3.x or newer is required for Ed25519 verification with pkeyutl -rawin. Found: ${version:-unknown}" >&2
    exit 1
  fi
}

public_key_raw_hex() {
  openssl pkey -in "$1" -pubin -outform DER | tail -c 32 | xxd -p -c 256
}

sha256_hex_of_hex_bytes() {
  printf '%s' "$1" | xxd -r -p | sha256sum | awk '{print $1}'
}

assert_canonical_json() {
  local file="$1"
  local tmp
  tmp="$(mktemp)"
  jq -S -c . "$file" > "$tmp"
  if ! cmp -s "$file" "$tmp"; then
    rm -f "$tmp"
    echo "Non-canonical JSON: $file" >&2
    exit 1
  fi
  rm -f "$tmp"
}

write_manifest() {
  local include_release="$1"
  if [[ "$include_release" == "no" ]]; then
    while IFS= read -r -d '' file; do
      rel_path="${file#./}"
      sha256sum --binary -- "$rel_path"
    done < <(
      cd "$ROOT_DIR" && \
      find . \
        -path './.git' -prune -o \
        -type f \
        \( -name '*.md' -o -name '*.json' \) \
        ! -name 'MANIFEST.sha256' \
        ! -name 'MANIFEST.sig' \
        ! -name 'RELEASE.json' \
        -print0 | LC_ALL=C sort -z
    )
  else
    while IFS= read -r -d '' file; do
      rel_path="${file#./}"
      sha256sum --binary -- "$rel_path"
    done < <(
      cd "$ROOT_DIR" && \
      find . \
        -path './.git' -prune -o \
        -type f \
        \( -name '*.md' -o -name '*.json' \) \
        ! -name 'MANIFEST.sha256' \
        ! -name 'MANIFEST.sig' \
        -print0 | LC_ALL=C sort -z
    )
  fi
}

require_command openssl
require_command jq
require_command sha256sum
require_command find
require_command sort
require_command xxd
require_openssl_3

if [[ ! -f "$MANIFEST_FILE" ]]; then
  echo "Missing manifest: $MANIFEST_FILE" >&2
  exit 1
fi

if [[ ! -f "$SIGNATURE_FILE" ]]; then
  echo "Missing signature: $SIGNATURE_FILE" >&2
  exit 1
fi

if [[ ! -f "$PUBLIC_KEY_FILE" ]]; then
  echo "Missing public key: $PUBLIC_KEY_FILE" >&2
  exit 1
fi

if [[ ! -f "$AUTHORS_FILE" ]]; then
  echo "Missing authors file: $AUTHORS_FILE" >&2
  exit 1
fi

if [[ ! -f "$RELEASE_FILE" ]]; then
  echo "Missing release file: $RELEASE_FILE" >&2
  exit 1
fi

PUBLIC_KEY_RAW_HEX="$(public_key_raw_hex "$PUBLIC_KEY_FILE")"
PUBLIC_KEY_FINGERPRINT="$(sha256_hex_of_hex_bytes "$PUBLIC_KEY_RAW_HEX")"
CREATOR_ID="0x${PUBLIC_KEY_FINGERPRINT:0:8}"

assert_canonical_json "$AUTHORS_FILE"
assert_canonical_json "$RELEASE_FILE"

AUTHORS_CREATOR_ID="$(jq -r '.creator_id' "$AUTHORS_FILE")"
AUTHORS_FINGERPRINT="$(jq -r '.public_key_fingerprint' "$AUTHORS_FILE")"
AUTHORS_SIGNATURE_ALGORITHM="$(jq -r '.signature_algorithm' "$AUTHORS_FILE")"
AUTHORS_PUBLIC_KEY_REF="$(jq -r '.public_key' "$AUTHORS_FILE")"
AUTHORS_NAME="$(jq -r '.authors[0].name' "$AUTHORS_FILE")"

RELEASE_AUTHOR="$(jq -r '.author' "$RELEASE_FILE")"
RELEASE_FINGERPRINT="$(jq -r '.public_key_fingerprint' "$RELEASE_FILE")"
RELEASE_MANIFEST_HASH="$(jq -r '.manifest_hash' "$RELEASE_FILE")"
RELEASE_TIMESTAMP="$(jq -r '.timestamp' "$RELEASE_FILE")"
RELEASE_VERSION="$(jq -r '.version' "$RELEASE_FILE")"
RELEASE_EXTERNAL_ANCHOR_TYPE="$(jq -r '.external_anchor | if . == null then "null" else type end' "$RELEASE_FILE")"

if [[ "$AUTHORS_CREATOR_ID" != "$CREATOR_ID" ]]; then
  echo "creator_id mismatch in AUTHORS.json" >&2
  exit 1
fi

if [[ "$AUTHORS_FINGERPRINT" != "$PUBLIC_KEY_FINGERPRINT" ]]; then
  echo "public key fingerprint mismatch in AUTHORS.json" >&2
  exit 1
fi

if [[ "$AUTHORS_SIGNATURE_ALGORITHM" != "Ed25519" ]]; then
  echo "unexpected signature algorithm in AUTHORS.json" >&2
  exit 1
fi

if [[ "$AUTHORS_PUBLIC_KEY_REF" != "PUBLIC_KEY.pem" ]]; then
  echo "unexpected public key reference in AUTHORS.json" >&2
  exit 1
fi

if [[ "$RELEASE_AUTHOR" != "$AUTHORS_NAME" ]]; then
  echo "author mismatch between AUTHORS.json and RELEASE.json" >&2
  exit 1
fi

if [[ "$RELEASE_FINGERPRINT" != "$PUBLIC_KEY_FINGERPRINT" ]]; then
  echo "public key fingerprint mismatch in RELEASE.json" >&2
  exit 1
fi

if [[ -z "$RELEASE_TIMESTAMP" || "$RELEASE_VERSION" != "1.0" ]]; then
  echo "invalid release metadata" >&2
  exit 1
fi

if ! [[ "$RELEASE_TIMESTAMP" =~ ^[0-9]+$ ]]; then
  echo "invalid release timestamp type" >&2
  exit 1
fi

if [[ "$RELEASE_EXTERNAL_ANCHOR_TYPE" != "null" && "$RELEASE_EXTERNAL_ANCHOR_TYPE" != "string" ]]; then
  echo "invalid external_anchor type in RELEASE.json" >&2
  exit 1
fi

if ! grep -Fqx "$(sha256sum --binary -- AUTHORS.json)" "$MANIFEST_FILE"; then
  echo "AUTHORS.json missing from MANIFEST.sha256" >&2
  exit 1
fi

if ! grep -Fqx "$(sha256sum --binary -- RELEASE.json)" "$MANIFEST_FILE"; then
  echo "RELEASE.json missing from MANIFEST.sha256" >&2
  exit 1
fi

tmp_manifest="$(mktemp)"
tmp_base_manifest="$(mktemp)"
trap 'rm -f "$tmp_manifest" "$tmp_base_manifest"' EXIT

write_manifest no > "$tmp_base_manifest"
EXPECTED_RELEASE_MANIFEST_HASH="$(sha256sum "$tmp_base_manifest" | awk '{print $1}')"

if [[ "$RELEASE_MANIFEST_HASH" != "$EXPECTED_RELEASE_MANIFEST_HASH" ]]; then
  echo "manifest_hash mismatch in RELEASE.json" >&2
  exit 1
fi

write_manifest yes > "$tmp_manifest"

if ! cmp -s "$tmp_manifest" "$MANIFEST_FILE"; then
  echo "MANIFEST.sha256 does not match deterministic regeneration" >&2
  exit 1
fi

openssl pkeyutl \
  -verify \
  -pubin \
  -inkey "$PUBLIC_KEY_FILE" \
  -rawin \
  -in "$MANIFEST_FILE" \
  -sigfile "$SIGNATURE_FILE"

(
  cd "$ROOT_DIR"
  sha256sum -c "$MANIFEST_FILE"
)
