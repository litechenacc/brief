#!/usr/bin/env bash
# GitHub-only release entry point. See docs/usage.md for the release workflow.
set -euo pipefail
cd "$(dirname "$0")"
exec python3 scripts/release.py "$@"
