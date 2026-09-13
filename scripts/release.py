#!/usr/bin/env python3
"""GitHub-only release of Brief. Run through release.sh."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parent.parent
REPO = "litechenacc/brief"


def run(*args, capture=False, check=True, env=None):
    return subprocess.run(args, cwd=ROOT, text=True, check=check,
                          stdout=subprocess.PIPE if capture else None,
                          stderr=subprocess.PIPE if capture else None, env=env)


def output(*args):
    return run(*args, capture=True).stdout.strip()


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def next_version(version, mode):
    require(re.fullmatch(r"\d+\.\d+\.\d+", version), "Expected a stable X.Y.Z version")
    numbers = list(map(int, version.split(".")))
    if mode != "current":
        index = {"major": 0, "minor": 1, "patch": 2}[mode]
        numbers[index] += 1
        numbers[index + 1:] = [0] * (2 - index)
    return ".".join(map(str, numbers))


def section(text, heading):
    match = re.search(r"^## \[" + re.escape(heading) + r"\]\s*\n(.*?)(?=^## |\Z)", text, re.M | re.S)
    require(match is not None, f"Missing CHANGELOG section [{heading}]")
    body = match.group(1).strip()
    require(bool(body) and re.search(r"^[-*] ", body, re.M), f"CHANGELOG [{heading}] needs release notes")
    return body


def promote(text, version):
    body = section(text, "Unreleased")
    require(f"## [{version}]" not in text, "Version already appears in CHANGELOG")
    text = re.sub(r"^## \[Unreleased\]\s*\n.*?(?=^## |\Z)",
                  lambda _: f"## [Unreleased]\n\n## [{version}]\n\n{body}\n\n", text, count=1, flags=re.M | re.S)
    text = re.sub(r"^\[Unreleased\]:.*$", f"[Unreleased]: https://github.com/{REPO}/compare/v{version}...HEAD", text, flags=re.M)
    return text.rstrip() + f"\n[{version}]: https://github.com/{REPO}/releases/tag/v{version}\n"


def archive_contents(path):
    with zipfile.ZipFile(path) as archive:
        return {name: hashlib.sha256(archive.read(name)).hexdigest() for name in archive.namelist()}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("bump", nargs="?", choices=["patch", "minor", "major"])
    parser.add_argument("--current", action="store_true", help="Publish/resume the prepared version without bumping")
    parser.add_argument("--dry-run", action="store_true", help="Read-only preflight and plan; no tests, build, edits, or publishing")
    parser.add_argument("--yes", action="store_true", help="Confirm the displayed release plan non-interactively")
    args = parser.parse_args()
    require(bool(args.bump) != args.current, "Choose patch/minor/major OR --current")
    mode = "current" if args.current else args.bump
    for tool in ["git", "node", "npm", "gh"]:
        require(shutil.which(tool), f"Required command missing: {tool}")
    require(output("git", "branch", "--show-current") == "main", "Release only from main")
    require(not output("git", "status", "--porcelain"), "Working tree is not clean; commit your work first")
    remote = output("git", "remote", "get-url", "origin")
    require(remote in [f"https://github.com/{REPO}.git", f"https://github.com/{REPO}", f"git@github.com:{REPO}.git"], "origin must point to " + REPO)
    run("gh", "auth", "status", "--hostname", "github.com")
    head = output("git", "rev-parse", "HEAD")
    remote_head = output("git", "ls-remote", "origin", "refs/heads/main").split()
    require(remote_head and remote_head[0] == head, "Push main to origin before releasing")
    package = json.loads((ROOT / "package.json").read_text())
    lock = json.loads((ROOT / "package-lock.json").read_text())
    current = package["version"]
    require(lock["version"] == current == lock["packages"][""]["version"], "Package and lockfile versions differ")
    version = next_version(current, mode)
    tag = "v" + version
    changelog = (ROOT / "CHANGELOG.md").read_text()
    notes = section(changelog, version if args.current else "Unreleased")
    next_changelog = changelog if args.current else promote(changelog, version)
    local_tag = run("git", "rev-parse", "--verify", f"refs/tags/{tag}^{{commit}}", capture=True, check=False)
    remote_tags = output("git", "ls-remote", "origin", f"refs/tags/{tag}", f"refs/tags/{tag}^{{}}")
    tag_refs = dict(line.split()[::-1] for line in remote_tags.splitlines())
    remote_tag = tag_refs.get(f"refs/tags/{tag}^{{}}", tag_refs.get(f"refs/tags/{tag}"))
    for existing in [local_tag.stdout.strip() if local_tag.returncode == 0 else None, remote_tag]:
        if existing:
            require(args.current and existing == head, f"{tag} exists at a different commit or bump target is already used")
    release = run("gh", "api", f"repos/{REPO}/releases/tags/{tag}", capture=True, check=False)
    if release.returncode:
        require("404" in release.stderr, "Cannot inspect GitHub Release: " + release.stderr)
        published = None
    else:
        require(args.current and remote_tag == head, "Existing release must have a matching remote tag; use --current")
        published = json.loads(release.stdout)
    print(f"Release plan: {REPO} | main {head[:12]} | {current} -> {version} | GitHub only", flush=True)
    print(f"Asset: brief-{version}.vsix; " + ("no version commit" if args.current else "create version commit and tag"), flush=True)
    if args.dry_run:
        return
    require(args.yes or input("Build and publish this release? [y/N] ").lower() in ["y", "yes"], "Cancelled")
    if not args.current:
        run("npm", "version", version, "--no-git-tag-version")
        (ROOT / "CHANGELOG.md").write_text(next_changelog)
    # Stable content for retries from the same source, independent of wall-clock time.
    env = dict(os.environ, BUILD_REV=tag, SOURCE_DATE_EPOCH="0")
    run("npm", "run", "package", env=env)
    vsix = ROOT / f"brief-{version}.vsix"
    run(sys.executable, "scripts/verify-vsix.py", str(vsix), version)
    run("git", "diff", "--check")
    if not args.current:
        changed = set(output("git", "diff", "--name-only").splitlines())
        require(changed <= {"package.json", "package-lock.json", "CHANGELOG.md"}, "Unexpected tracked changes; inspect before committing")
        run("git", "add", "package.json", "package-lock.json", "CHANGELOG.md")
        run("git", "commit", "-m", f"chore(release): {tag}")
    require(not output("git", "status", "--porcelain"), "Unexpected changes after build; inspect before publishing")
    if local_tag.returncode != 0 and not remote_tag:
        run("git", "tag", "-a", tag, "-m", f"Brief {version}")
    run("git", "push", "origin", "main")
    if not remote_tag:
        run("git", "push", "origin", f"refs/tags/{tag}")
    with tempfile.TemporaryDirectory(prefix="brief-release-") as tmp:
        if published:
            assets = published.get("assets", [])
            if any(asset["name"] == vsix.name for asset in assets):
                run("gh", "release", "download", tag, "--repo", REPO, "--pattern", vsix.name, "--dir", tmp)
                require(archive_contents(vsix) == archive_contents(Path(tmp) / vsix.name), "Published VSIX differs; refusing overwrite. Publish a new version")
                print("Existing VSIX matches; nothing to upload")
            else:
                run("gh", "release", "upload", tag, str(vsix), "--repo", REPO)
        else:
            note_path = Path(tmp) / "notes.md"
            note_path.write_text(notes + "\n")
            run("gh", "release", "create", tag, str(vsix), "--repo", REPO, "--verify-tag", "--title", f"Brief {version}", "--notes-file", str(note_path))
    print(f"GitHub Release ready: https://github.com/{REPO}/releases/tag/{tag}")


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, subprocess.CalledProcessError, EOFError) as error:
        print(f"Release stopped: {error}\nNo automatic rollback. Inspect git status; after a committed release, use --current to resume.", file=sys.stderr)
        sys.exit(1)
