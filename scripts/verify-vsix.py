#!/usr/bin/env python3
import json
import sys
import zipfile

vsix = sys.argv[1]
with zipfile.ZipFile(vsix) as z:
    names = z.namelist()
    manifest = z.read("extension.vsixmanifest").decode()
    pkg = json.loads(z.read("extension/package.json"))

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
