#!/bin/sh
# Quick-install the Brief VS Code extension from source.
#
#   sh install.sh                                clone -> build -> install
#   LOCAL_DIR=/path/to/checkout sh install.sh    build from an existing checkout (dev)
#
set -eu

REPO_URL="https://github.com/litechenacc/brief"
PKG_NAME="brief"

fail() {
    echo "install.sh: error: $*" >&2
    exit 1
}

# --- prerequisites -------------------------------------------------------------

for cmd in git node npm; do
    command -v "$cmd" >/dev/null 2>&1 || fail "'$cmd' is required but not found on PATH."
done

if ! command -v code >/dev/null 2>&1; then
    echo "install.sh: error: 'code' is required but not found on PATH." >&2
    echo "install.sh: on macOS, run \"Shell Command: Install 'code' command in PATH\" from the VS Code Command Palette." >&2
    exit 1
fi

NODE_VERSION=$(node --version)
NODE_MAJOR=$(echo "$NODE_VERSION" | sed 's/^v//' | cut -d. -f1)
case $NODE_MAJOR in
    ''|*[!0-9]*) fail "could not parse node version '$NODE_VERSION'." ;;
esac
[ "$NODE_MAJOR" -ge 22 ] || fail "node >= 22 required (found $NODE_VERSION)."

# --- source tree ---------------------------------------------------------------

TMP_DIR=""
if [ -n "${LOCAL_DIR:-}" ]; then
    [ -d "$LOCAL_DIR" ] || fail "LOCAL_DIR '$LOCAL_DIR' is not a directory."
    [ -f "$LOCAL_DIR/package.json" ] || fail "LOCAL_DIR '$LOCAL_DIR' is not a checkout (no package.json)."
    SRC_DIR=$LOCAL_DIR
    echo "Using existing checkout: $SRC_DIR"
else
    TMP_DIR=$(mktemp -d)
    trap 'rm -rf "$TMP_DIR"' EXIT
    echo "Cloning $REPO_URL ..."
    git clone --quiet --depth 1 "$REPO_URL" "$TMP_DIR/$PKG_NAME"
    SRC_DIR="$TMP_DIR/$PKG_NAME"
fi

cd "$SRC_DIR"

# --- build + install ------------------------------------------------------------

echo "Installing dependencies ..."
npm ci

echo "Packaging extension ..."
npm run package

# By exact version, not newest-by-mtime: a dev checkout keeps older .vsix files
# around and installing one of those would look like a successful install.
VERSION=$(node -p "require('./package.json').version")
VSIX="$PKG_NAME-$VERSION.vsix"
[ -f "$VSIX" ] || fail "npm run package produced no $VSIX."

echo "Installing $VSIX ..."
code --install-extension "$VSIX" --force

echo
echo "Success: Brief installed into VS Code."
echo "Run Developer: Reload Window, then Brief: New Session from the Command Palette."
