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
activity = pkg["contributes"]["viewsContainers"]["activitybar"][0]["icon"]
if activity != "$(comment-discussion)":
    raise SystemExit(f"activitybar icon={activity!r}")
if "Microsoft.VisualStudio.Services.Icons.Default" not in manifest:
    raise SystemExit("vsixmanifest missing Icons.Default")
if "extension/media/icon.png" not in manifest:
    raise SystemExit("vsixmanifest missing icon.png path")
print(f"vsix ok: {vsix}")
print(f" marketplace icon: {pkg.get('icon')}")
print(f" activitybar icon: {activity}")
