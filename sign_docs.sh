#!/bin/bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PRIVATE_KEY_SOURCE="${PRIVATE_KEY_SOURCE:-/home/angell/vri_identity/private_key.pem}"
PUBLIC_KEY_SOURCE="${PUBLIC_KEY_SOURCE:-/home/angell/vri_identity/public_key.pem}"

MANIFEST_FILE="$ROOT_DIR/MANIFEST.sha256"
SIGNATURE_FILE="$ROOT_DIR/MANIFEST.sig"
PUBLIC_KEY_FILE="$ROOT_DIR/PUBLIC_KEY.pem"
AUTHORS_FILE="$ROOT_DIR/AUTHORS.json"
RELEASE_FILE="$ROOT_DIR/RELEASE.json"
AUTHOR_NAME="Ángel López Morales"
AUTHOR_EMAIL="angel.lopez@voicepowered.ai"
AUTHOR_ORG="VoicePowered AI"
VERSION="1.0"

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
    echo "OpenSSL 3.x or newer is required for Ed25519 signing with pkeyutl -rawin. Found: ${version:-unknown}" >&2
    exit 1
  fi
}

public_key_raw_hex() {
  openssl pkey -in "$1" -pubin -outform DER | tail -c 32 | xxd -p -c 256
}

sha256_hex_of_hex_bytes() {
  printf '%s' "$1" | xxd -r -p | sha256sum | awk '{print $1}'
}

write_canonical_json() {
  local target="$1"
  local payload="$2"
  printf '%s\n' "$payload" | jq -S -c . > "$target"
}

write_authors_json() {
  write_canonical_json "$AUTHORS_FILE" "$(cat <<EOF
{
  "version": "$VERSION",
  "authors": [
    {
      "name": "$AUTHOR_NAME",
      "email": "$AUTHOR_EMAIL",
      "organization": "$AUTHOR_ORG"
    }
  ],
  "statement": "This documentation set is authored and cryptographically signed.",
  "public_key": "PUBLIC_KEY.pem",
  "creator_id": "$CREATOR_ID",
  "public_key_fingerprint": "$PUBLIC_KEY_FINGERPRINT",
  "signature_algorithm": "Ed25519"
}
EOF
)"
}

write_release_json() {
  write_canonical_json "$RELEASE_FILE" "$(cat <<EOF
{
  "version": "$VERSION",
  "author": "$AUTHOR_NAME",
  "manifest_hash": "$1",
  "public_key_fingerprint": "$PUBLIC_KEY_FINGERPRINT",
  "timestamp": $2,
  "external_anchor": null
}
EOF
)"
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

if [[ ! -f "$PRIVATE_KEY_SOURCE" ]]; then
  echo "Missing private key: $PRIVATE_KEY_SOURCE" >&2
  exit 1
fi

if [[ ! -f "$PUBLIC_KEY_SOURCE" ]]; then
  echo "Missing public key: $PUBLIC_KEY_SOURCE" >&2
  exit 1
fi

cp "$PUBLIC_KEY_SOURCE" "$PUBLIC_KEY_FILE"
PUBLIC_KEY_RAW_HEX="$(public_key_raw_hex "$PUBLIC_KEY_SOURCE")"
PUBLIC_KEY_FINGERPRINT="$(sha256_hex_of_hex_bytes "$PUBLIC_KEY_RAW_HEX")"
CREATOR_ID="0x${PUBLIC_KEY_FINGERPRINT:0:8}"

write_authors_json

tmp_manifest="$(mktemp)"
tmp_base_manifest="$(mktemp)"
trap 'rm -f "$tmp_manifest" "$tmp_base_manifest"' EXIT

write_manifest no > "$tmp_base_manifest"
BASE_MANIFEST_HASH="$(sha256sum "$tmp_base_manifest" | awk '{print $1}')"
RELEASE_TIMESTAMP="$(date -u +%s)"
write_release_json "$BASE_MANIFEST_HASH" "$RELEASE_TIMESTAMP"

write_manifest yes > "$tmp_manifest"
mv "$tmp_manifest" "$MANIFEST_FILE"

openssl pkeyutl \
  -sign \
  -rawin \
  -inkey "$PRIVATE_KEY_SOURCE" \
  -in "$MANIFEST_FILE" \
  -out "$SIGNATURE_FILE"

echo "Generated:"
echo "  $MANIFEST_FILE"
echo "  $SIGNATURE_FILE"
echo "  $PUBLIC_KEY_FILE"
echo "  $AUTHORS_FILE"
echo "  $RELEASE_FILE"
