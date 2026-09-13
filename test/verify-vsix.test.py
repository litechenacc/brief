#!/usr/bin/env python3
"""Exercise the verifier against standalone synthetic VSIX archives."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import warnings
import zipfile

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "verify-vsix.py"
ASSETS = """
package.json readme.md README.zh-TW.md LICENSE.txt changelog.md
THIRD_PARTY_NOTICES.md dist/extension.js media/activity.svg media/tab-light.svg
media/tab-dark.svg media/icon.svg media/icon.png media/icon-32.png
media/icon-64.png media/icon-128.png media/icon-256.png media/main.css
media/main.js media/screenshots/editor-tabs.png media/screenshots/sidebar.png
""".split()


class VerifyVsixTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.archive = Path(self.temp.name) / "test.vsix"
        self.pkg = {
            "version": "1.2.3",
            "icon": "media/icon.png",
            "activationEvents": ["onWebviewPanel:brief.chatPanel"],
            "contributes": {
                "views": {"brief": [{"id": "brief.chat"}]},
                "configuration": {"properties": {
                    "brief.chatLocation": {"enum": ["editor", "sidebar"]}
                }},
            },
        }
        self.files = {"extension/" + name: b"fixture" for name in ASSETS}
        self.files["[Content_Types].xml"] = "<Types/>"
        self.files["extension.vsixmanifest"] = (
            '<PackageManifest xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">'
            '<Metadata><Identity Version="1.2.3"/></Metadata>'
            '<Assets><Asset Type="Microsoft.VisualStudio.Services.Icons.Default" '
            'Path="extension/media/icon.png"/></Assets></PackageManifest>'
        )

    def verify(self, version=None, duplicate=None):
        if "extension/package.json" in self.files:
            self.files["extension/package.json"] = json.dumps(self.pkg)
        with zipfile.ZipFile(self.archive, "w") as archive:
            for name, content in self.files.items():
                archive.writestr(name, content)
            if duplicate:
                with warnings.catch_warnings():
                    warnings.simplefilter("ignore", UserWarning)
                    archive.writestr(duplicate, self.files[duplicate])
        args = [sys.executable, str(SCRIPT), str(self.archive)]
        if version is not None:
            args.append(version)
        return subprocess.run(args, capture_output=True, text=True)

    def assertRejected(self, text, **kwargs):
        result = self.verify(**kwargs)
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertIn(text, result.stderr)

    def test_valid_archive_with_and_without_expected_version(self):
        for version in (None, "1.2.3"):
            with self.subTest(version=version):
                result = self.verify(version)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn("vsix ok:", result.stdout)

    def test_unknown_files(self):
        for name in (
            "extension/dist/controller.cjs", "extension/dist/process-tracker.cjs",
            "extension/dist/background-task-tracker.cjs",
            "extension/dist/background-jobs.cjs", "extension/dist/agent-jobs.cjs",
            "extension/.env", "extension/.env.local", "extension/image.png",
            "extension/media/screenshots/raw.png", "extension/media/main.js.map",
            "extension/new-file.txt", "secret.txt", "extension/../secret.txt",
        ):
            with self.subTest(name=name):
                self.files[name] = "unwanted"
                self.assertRejected(name)
                del self.files[name]

    def test_each_required_file(self):
        for name in list(self.files):
            with self.subTest(name=name):
                content = self.files.pop(name)
                self.assertRejected(name)
                self.files[name] = content

    def test_duplicate_entry(self):
        self.assertRejected("duplicate entries", duplicate="extension/package.json")

    def test_package_version_mismatch(self):
        self.pkg["version"] = "9.9.9"
        self.assertRejected("package.json version=", version="1.2.3")

    def test_manifest_version_mismatch(self):
        self.files["extension.vsixmanifest"] = self.files["extension.vsixmanifest"].replace(
            'Version="1.2.3"', 'Version="9.9.9"'
        )
        self.assertRejected("Identity Version=", version="1.2.3")

    def test_missing_manifest_identity(self):
        self.files["extension.vsixmanifest"] = self.files["extension.vsixmanifest"].replace(
            '<Identity Version="1.2.3"/>', ""
        )
        self.assertRejected("Identity Version=None", version="1.2.3")

    def test_functional_package_assertions(self):
        for field, value, message in (
            ("icon", "wrong.png", "package.json icon="),
            ("activationEvents", [], "restore activation"),
        ):
            with self.subTest(field=field):
                original = self.pkg[field]
                self.pkg[field] = value
                self.assertRejected(message)
                self.pkg[field] = original
        self.pkg["contributes"]["views"]["brief"] = []
        self.assertRejected("Brief sidebar view")
        self.pkg["contributes"]["views"]["brief"] = [{"id": "brief.chat"}]
        self.pkg["contributes"]["configuration"]["properties"]["brief.chatLocation"]["enum"] = ["editor"]
        self.assertRejected("editor/sidebar location setting")

    def test_functional_manifest_assertions(self):
        original = self.files["extension.vsixmanifest"]
        for text, message in (
            ("Microsoft.VisualStudio.Services.Icons.Default", "missing Icons.Default"),
            ("extension/media/icon.png", "missing icon.png path"),
        ):
            with self.subTest(text=text):
                self.files["extension.vsixmanifest"] = original.replace(text, "wrong")
                self.assertRejected(message)
        self.files["extension.vsixmanifest"] = original


if __name__ == "__main__":
    unittest.main()
