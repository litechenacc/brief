#!/usr/bin/env python3
"""Release checks use temporary manifests and never invoke external commands."""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import zipfile

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "release.py"
spec = importlib.util.spec_from_file_location("release", SCRIPT)
release = importlib.util.module_from_spec(spec)
sys.dont_write_bytecode = True
spec.loader.exec_module(release)
CHANGELOG = "# Changelog\n\n## [Unreleased]\n\n- New feature\n\n## [1.2.3]\n\n- Previous feature\n"


class HelpersTest(unittest.TestCase):
    def test_bump(self):
        for mode, expected in [("patch", "1.2.4"), ("minor", "1.3.0"),
                               ("major", "2.0.0"), ("current", "1.2.3")]:
            with self.subTest(mode=mode):
                self.assertEqual(release.next_version("1.2.3", mode), expected)

    def test_unstable_versions_rejected(self):
        for version in ["1.2", "v1.2.3", "1.2.3-beta", "1.2.3+build", ""]:
            with self.subTest(version=version), self.assertRaises(RuntimeError):
                release.next_version(version, "patch")

    def test_promote(self):
        text = CHANGELOG + "\n[Unreleased]: old-url\n"
        result = release.promote(text, "1.2.4")
        self.assertIn("## [Unreleased]\n\n## [1.2.4]\n\n- New feature", result)
        self.assertEqual(release.section(result, "1.2.4"), "- New feature")
        self.assertIn("## [1.2.3]\n\n- Previous feature", result)
        self.assertIn("[Unreleased]: https://github.com/litechenacc/brief/compare/v1.2.4...HEAD", result)
        self.assertIn("[1.2.4]: https://github.com/litechenacc/brief/releases/tag/v1.2.4", result)
        with self.assertRaises(RuntimeError):
            release.promote(CHANGELOG, "1.2.3")

    def test_missing_or_empty_notes(self):
        for text in ["# Changelog", "## [Unreleased]\n\n## [1.2.3]\n- Old", "## [Unreleased]\nNothing"]:
            with self.subTest(text=text), self.assertRaises(RuntimeError):
                release.section(text, "Unreleased")


class ReleaseTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        (self.root / "package.json").write_text(json.dumps({"version": "1.2.3"}))
        (self.root / "package-lock.json").write_text(json.dumps({"version": "1.2.3", "packages": {"": {"version": "1.2.3"}}}))
        (self.root / "CHANGELOG.md").write_text(CHANGELOG)
        self.tag = "v1.2.4"
        self.head = "a" * 40
        self.responses = {
            ("git", "branch", "--show-current"): "main",
            ("git", "status", "--porcelain"): "",
            ("git", "remote", "get-url", "origin"): "https://github.com/litechenacc/brief.git",
            ("git", "rev-parse", "HEAD"): self.head,
            ("git", "ls-remote", "origin", "refs/heads/main"): self.head + "\trefs/heads/main",
            ("git", "diff", "--name-only"): "package.json\npackage-lock.json\nCHANGELOG.md",
        }
        self.local_tag = ""
        self.remote_tag = ""
        self.published = None
        self.api_error = "404 Not Found"
        self.download_content = b"same source"
        self.calls = []
        self.allowed_mutations = False
        for mock in [patch.object(release, "ROOT", self.root),
                     patch.object(release.shutil, "which", lambda tool: "/bin/" + tool)]:
            mock.start()
            self.addCleanup(mock.stop)
        mock = patch.object(release.subprocess, "run", side_effect=self.command)
        self.subprocess = mock.start()
        self.addCleanup(mock.stop)

    def command(self, args, **kwargs):
        args = tuple(args)
        self.calls.append(args)
        code, stdout, stderr = 0, "", ""
        if args in self.responses:
            stdout = self.responses[args]
        elif args == ("gh", "auth", "status", "--hostname", "github.com"):
            pass
        elif args == ("git", "rev-parse", "--verify", f"refs/tags/{self.tag}^{{commit}}"):
            code, stdout = (0, self.local_tag) if self.local_tag else (1, "")
        elif args == ("git", "ls-remote", "origin", f"refs/tags/{self.tag}", f"refs/tags/{self.tag}^{{}}"):
            stdout = self.remote_tag
        elif args == ("gh", "api", f"repos/{release.REPO}/releases/tags/{self.tag}"):
            if self.published is None:
                code, stderr = 1, self.api_error
            else:
                stdout = json.dumps(self.published)
        else:
            self.assertTrue(self.allowed_mutations, f"Unexpected command: {args}")
            if args[:3] == ("npm", "run", "package"):
                self.assertEqual(kwargs["env"]["BUILD_REV"], self.tag)
                self.assertEqual(kwargs["env"]["SOURCE_DATE_EPOCH"], "0")
                self.write_archive(self.root / f"brief-{self.tag[1:]}.vsix", b"same source")
            elif args[:3] == ("gh", "release", "download"):
                self.write_archive(Path(args[args.index("--dir") + 1]) / f"brief-{self.tag[1:]}.vsix", self.download_content)
        if code and kwargs.get("check", True):
            raise subprocess.CalledProcessError(code, args, stdout, stderr)
        return subprocess.CompletedProcess(args, code, stdout, stderr)

    @staticmethod
    def write_archive(path, content):
        with zipfile.ZipFile(path, "w") as archive:
            archive.writestr("extension/source.js", content)

    def invoke(self, *args):
        with patch.object(sys, "argv", [str(SCRIPT), *args]), contextlib.redirect_stdout(io.StringIO()):
            release.main()

    def current(self, assets=None):
        self.tag = "v1.2.3"
        self.local_tag = self.head
        self.remote_tag = f"{self.head}\trefs/tags/{self.tag}"
        if assets is not None:
            self.published = {"assets": assets}

    def test_duplicate_changelog_version_fails_before_mutation(self):
        (self.root / "CHANGELOG.md").write_text(CHANGELOG + "\n## [1.2.4]\n\n- Already written\n")
        before = {p.name: p.read_bytes() for p in self.root.iterdir()}
        with self.assertRaisesRegex(RuntimeError, "Version already appears"):
            self.invoke("patch", "--dry-run")
        self.assertEqual(before, {p.name: p.read_bytes() for p in self.root.iterdir()})
        self.assertFalse(any(c[0] == "npm" for c in self.calls))

    def test_dry_run_is_read_only(self):
        before = {p.name: p.read_bytes() for p in self.root.iterdir()}
        self.invoke("patch", "--dry-run")
        self.assertEqual(before, {p.name: p.read_bytes() for p in self.root.iterdir()})
        self.assertFalse(any(c[0] == "npm" for c in self.calls))

    def test_preflight_failures(self):
        cases = [(("git", "branch", "--show-current"), "topic", "only from main"),
                 (("git", "status", "--porcelain"), " M file", "not clean"),
                 (("git", "remote", "get-url", "origin"), "https://example.com/repo", "origin must"),
                 (("git", "ls-remote", "origin", "refs/heads/main"), "b" * 40, "Push main")]
        for command, response, error in cases:
            with self.subTest(command=command), patch.dict(self.responses, {command: response}):
                with self.assertRaisesRegex(RuntimeError, error):
                    self.invoke("patch", "--dry-run")

    def test_missing_tool(self):
        with patch.object(release.shutil, "which", return_value=None), self.assertRaisesRegex(RuntimeError, "Required command missing"):
            self.invoke("patch", "--dry-run")
        self.assertEqual(self.calls, [])

    def test_version_mismatch(self):
        (self.root / "package-lock.json").write_text('{"version":"9.0.0","packages":{"":{"version":"1.2.3"}}}')
        with self.assertRaisesRegex(RuntimeError, "versions differ"):
            self.invoke("patch", "--dry-run")

    def test_api_failure_is_not_treated_as_missing_release(self):
        self.api_error = "403 Forbidden"
        with self.assertRaisesRegex(RuntimeError, "Cannot inspect"):
            self.invoke("patch", "--dry-run")

    def test_existing_bump_tag_rejected(self):
        self.local_tag = self.head
        with self.assertRaisesRegex(RuntimeError, "already used"):
            self.invoke("patch", "--dry-run")

    def test_current_wrong_tag_rejected(self):
        self.current()
        self.local_tag = "b" * 40
        with self.assertRaisesRegex(RuntimeError, "different commit"):
            self.invoke("--current", "--dry-run")

    def test_current_does_not_commit_or_edit_versions(self):
        self.current()
        self.allowed_mutations = True
        before = {p.name: p.read_bytes() for p in self.root.iterdir()}
        self.invoke("--current", "--yes")
        for name, content in before.items():
            self.assertEqual((self.root / name).read_bytes(), content)
        for call in self.calls:
            self.assertNotIn(call[:2], [("npm", "version"), ("git", "add"), ("git", "commit"), ("git", "tag")])
        self.assertTrue(any(c[:3] == ("gh", "release", "create") for c in self.calls))

    def test_resume_upload_missing_asset(self):
        self.current(assets=[])
        self.allowed_mutations = True
        self.invoke("--current", "--yes")
        self.assertTrue(any(c[:3] == ("gh", "release", "upload") for c in self.calls))
        self.assertFalse(any(c[:3] == ("gh", "release", "create") for c in self.calls))

    def test_resume_matching_asset_is_not_uploaded(self):
        self.current(assets=[{"name": "brief-1.2.3.vsix"}])
        self.allowed_mutations = True
        self.invoke("--current", "--yes")
        self.assertTrue(any(c[:3] == ("gh", "release", "download") for c in self.calls))
        self.assertFalse(any(c[:3] == ("gh", "release", "upload") for c in self.calls))

    def test_resume_collision_refuses_overwrite(self):
        self.current(assets=[{"name": "brief-1.2.3.vsix"}])
        self.allowed_mutations = True
        self.download_content = b"different source"
        with self.assertRaisesRegex(RuntimeError, "refusing overwrite"):
            self.invoke("--current", "--yes")
        self.assertFalse(any(c[:3] == ("gh", "release", "upload") for c in self.calls))


if __name__ == "__main__":
    unittest.main()
