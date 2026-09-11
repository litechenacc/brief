# Brief VS Code extension: build, package, and reinstall locally.
# Usage:
#   just              # package + install (default)
#   just install
#   just package      # only write brief-<version>.vsix
#   just uninstall

set shell := ["bash", "-eu", "-o", "pipefail", "-c"]

publisher := "litechenacc"
ext_name := "brief"

default: install

version:
    node -p "require('./package.json').version"

package:
    #!/usr/bin/env bash
    set -euo pipefail
    if [ -f package-lock.json ]; then
      npm ci
    else
      npm install
    fi
    npm run package
    v=$(node -p "require('./package.json').version")
    vsix="{{ext_name}}-${v}.vsix"
    test -f "$vsix"
    python3 scripts/verify-vsix.py "$vsix"

uninstall:
    #!/usr/bin/env bash
    set -euo pipefail
    code --uninstall-extension {{publisher}}.{{ext_name}} || true
    rm -rf "${HOME}/.vscode-server/extensions/{{publisher}}.{{ext_name}}-"*
    rm -rf "${HOME}/.vscode/extensions/{{publisher}}.{{ext_name}}-"*

install: package uninstall
    #!/usr/bin/env bash
    set -euo pipefail
    v=$(node -p "require('./package.json').version")
    vsix="{{ext_name}}-${v}.vsix"
    code --install-extension "$vsix" --force
    echo "Installed $vsix"
    echo "Reload VS Code: Command Palette -> Developer: Reload Window"
