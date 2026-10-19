"""Source identity and process helpers for Codex patch builds."""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parents[1]
GIT_IDENTITY = ["-c", "user.name=Araceae Runtime", "-c", "user.email=runtime@araceae.invalid",
                "-c", "commit.gpgsign=false", "-c", "core.autocrlf=false"]


def run(args, *, cwd=None, capture=False, env=None):
    return subprocess.run([str(arg) for arg in args], cwd=cwd, env=env, check=True,
                          text=True, stdout=subprocess.PIPE if capture else None,
                          stderr=subprocess.PIPE if capture else None).stdout


def git(source, *args, capture=True):
    return run(["git", "-C", source, *GIT_IDENTITY, *args], capture=capture)


def sha256(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def write_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    os.replace(temporary, path)


def read_lock(root):
    lock = json.loads((root / "manifests/runtime-source-lock.json").read_text(encoding="utf-8"))
    if lock["format"] != 1 or not re.fullmatch(r"[0-9a-f]{40}", lock["upstream"]["commit"]):
        raise ValueError("Unsupported source lock or invalid upstream commit")
    modules = root / ".gitmodules"
    if modules.is_file():
        path = git(root, "config", "--file", modules, "--get", "submodule.codex.path").strip()
        url = git(root, "config", "--file", modules, "--get", "submodule.codex.url").strip()
        if path != "codex" or url != lock["upstream"]["url"]:
            raise ValueError("Codex submodule path or URL differs from the source lock")
        entries = git(root, "ls-files", "--stage", "--", "codex").splitlines()
        expected = f"160000 {lock['upstream']['commit']} 0\tcodex"
        if entries != [expected]:
            raise ValueError("Codex submodule pin differs from the source lock; align the locked commit "
                             "and stage the codex gitlink with git add codex")
    return lock


def load_plan(root, *, baseline=False):
    lock = read_lock(root)
    directory = root / "patches/codex"
    patches = []
    baseline_names = lock["baseline"].get("patches", [])
    if len(baseline_names) != len(set(baseline_names)):
        raise ValueError("Duplicate baseline patches in source lock")
    if not baseline or lock["baseline"].get("patches"):
        metadata = json.loads((directory / "metadata.json").read_text(encoding="utf-8"))
        selected = set()
        for line in (directory / "series").read_text(encoding="utf-8").splitlines():
            name = line.strip()
            if not name or name.startswith("#"):
                continue
            if baseline and name not in lock["baseline"]["patches"]:
                continue
            if not re.fullmatch(r"[a-z0-9][a-z0-9-]*\.patch", name) or name in selected:
                raise ValueError(f"Invalid or duplicate patch in series: {name}")
            entry = metadata[name]
            missing = set(entry["depends_on"]) - selected
            if missing:
                raise ValueError(f"{name} requires earlier patches: {', '.join(sorted(missing))}")
            digest = sha256(directory / name)
            if digest != entry["sha256"]:
                raise ValueError(f"Patch checksum mismatch: {name}")
            patches.append({"name": name, "sha256": digest})
            selected.add(name)
        if baseline and selected != set(baseline_names):
            raise ValueError("Baseline patches are missing from series")
    identity = {"base": lock["upstream"]["commit"], "patches": patches}
    digest = hashlib.sha256(json.dumps(identity, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    return lock, patches, digest


def state_path(source):
    return Path(git(source, "rev-parse", "--absolute-git-dir").strip()) / "araceae-patches.json"


def read_state(source):
    return json.loads(state_path(source).read_text(encoding="utf-8"))


def save_state(source, state):
    write_json(state_path(source), state)


def require_clean(source):
    if git(source, "status", "--porcelain").strip():
        raise ValueError(f"Worktree contains uncommitted changes: {source}")
    am_path = Path(git(source, "rev-parse", "--git-path", "rebase-apply").strip())
    if not am_path.is_absolute():
        am_path = source / am_path
    if am_path.exists():
        raise ValueError("An unfinished git am operation exists; resolve it before continuing")


def validate_source(root, source, *, complete=True):
    state = read_state(source)
    lock, patches, digest = load_plan(root, baseline=state["baseline"])
    if state["digest"] != digest or state["base"] != lock["upstream"]["commit"]:
        raise ValueError("Worktree does not match the locked patch series; prepare a separate worktree")
    if state.get("failed"):
        raise ValueError(f"Resolve and refresh failed patch: {state['failed']['name']}")
    require_clean(source)
    applied = state["applied"]
    if [item["name"] for item in applied] != [item["name"] for item in patches[:len(applied)]]:
        raise ValueError("Applied patch sequence does not match series")
    parent = state["base"]
    for item in applied:
        if git(source, "rev-parse", f"{item['commit']}^").strip() != parent:
            raise ValueError(f"Unexpected patch history: {item['name']}")
        parent = item["commit"]
    if git(source, "rev-parse", "HEAD").strip() != parent:
        raise ValueError("Worktree HEAD differs from the recorded patch history")
    if complete and len(applied) != len(patches):
        raise ValueError("Patch series is incomplete; apply the remaining patches before building")
    return lock, patches, state
