#!/usr/bin/env python3
import json
import sys
import zipfile
import xml.etree.ElementTree as ET

# Check the actual archive, not the source tree or vsce's proposed file list.
EXPECTED_FILES = {
    "extension.vsixmanifest",
    "[Content_Types].xml",
    "extension/package.json",
    "extension/readme.md",
    "extension/README.zh-TW.md",
    "extension/LICENSE.txt",
    "extension/changelog.md",
    "extension/THIRD_PARTY_NOTICES.md",
    "extension/dist/extension.js",
    "extension/dist/prime-auth-helper.mjs",
    "extension/media/activity.svg",
    "extension/media/tab-light.svg",
    "extension/media/tab-dark.svg",
    "extension/media/icon.svg",
    "extension/media/icon.png",
    "extension/media/icon-32.png",
    "extension/media/icon-64.png",
    "extension/media/icon-128.png",
    "extension/media/icon-256.png",
    "extension/media/main.css",
    "extension/media/main.js",
    "extension/media/screenshots/editor-tabs.png",
    "extension/media/screenshots/sidebar.png",
}

if len(sys.argv) not in (2, 3):
    raise SystemExit("usage: verify-vsix.py VSIX [EXPECTED_VERSION]")
vsix = sys.argv[1]
with zipfile.ZipFile(vsix) as z:
    names = z.namelist()
    if len(names) != len(set(names)):
        raise SystemExit("vsix contains duplicate entries")
    unexpected = set(names) - EXPECTED_FILES
    missing = EXPECTED_FILES - set(names)
    if unexpected or missing:
        raise SystemExit(
            f"vsix file mismatch: unexpected={sorted(unexpected)}, missing={sorted(missing)}"
        )
    manifest = z.read("extension.vsixmanifest").decode()
    pkg = json.loads(z.read("extension/package.json"))

if len(sys.argv) == 3:
    expected_version = sys.argv[2]
    if pkg.get("version") != expected_version:
        raise SystemExit(f"package.json version={pkg.get('version')!r}, expected {expected_version!r}")
    identity = ET.fromstring(manifest).find(
        "{http://schemas.microsoft.com/developer/vsx-schema/2011}Metadata/"
        "{http://schemas.microsoft.com/developer/vsx-schema/2011}Identity"
    )
    version = identity.get("Version") if identity is not None else None
    if version != expected_version:
        raise SystemExit(f"vsixmanifest Identity Version={version!r}, expected {expected_version!r}")

if "extension/media/icon.png" not in names:
    raise SystemExit("vsix missing: extension/media/icon.png")
if pkg.get("icon") != "media/icon.png":
    raise SystemExit(f"package.json icon={pkg.get('icon')!r}")
if not any(view.get("id") == "brief.chat" for view in pkg["contributes"].get("views", {}).get("brief", [])):
    raise SystemExit("package missing Brief sidebar view")
if pkg["contributes"]["configuration"]["properties"]["brief.chatLocation"]["enum"] != ["editor", "sidebar"]:
    raise SystemExit("package missing editor/sidebar location setting")
if "onWebviewPanel:brief.chatPanel" not in pkg.get("activationEvents", []):
    raise SystemExit("package missing editor panel restore activation")
if "Microsoft.VisualStudio.Services.Icons.Default" not in manifest:
    raise SystemExit("vsixmanifest missing Icons.Default")
if "extension/media/icon.png" not in manifest:
    raise SystemExit("vsixmanifest missing icon.png path")
print(f"vsix ok: {vsix}")
print(f" marketplace icon: {pkg.get('icon')}")
print(" chat layout: native editor tabs + sidebar")
