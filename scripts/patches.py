#!/usr/bin/env python3
"""Prepare, replay, and refresh a Codex patch series in isolated Git worktrees."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import re
import subprocess
import sys

from runtime_common import ROOT, git, load_plan, read_state, require_clean, run
from runtime_common import save_state, sha256, validate_source, write_json


def prepare(root, name, baseline):
    if not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_-]*", name):
        raise ValueError("Worktree names must contain only letters, numbers, hyphens, and underscores")
    lock, _, digest = load_plan(root, baseline=baseline)
    cache = root / "codex"
    destination = root / ".worktrees" / name
    if destination.exists():
        raise ValueError(f"Worktree already exists: {destination}; choose a different --name")
    if (root / ".gitmodules").is_file() and not (cache / ".git").exists():
        git(root, "submodule", "update", "--init", "--depth", "1", "--", "codex", capture=False)
    elif not cache.exists():
        run(["git", "init", "--quiet", cache])
        git(cache, "remote", "add", "origin", lock["upstream"]["url"])
    if Path(git(cache, "rev-parse", "--show-toplevel").strip()).resolve() != cache.resolve():
        raise ValueError(f"Upstream cache is not an independent Git repository: {cache}")
    commit = lock["upstream"]["commit"]
    try:
        git(cache, "cat-file", "-e", f"{commit}^{{commit}}")
    except subprocess.CalledProcessError:
        empty = not git(cache, "rev-list", "--all", "--max-count=1").strip()
        shallow = git(cache, "rev-parse", "--is-shallow-repository").strip() == "true"
        depth = ["--depth", "1"] if empty or shallow else []
        git(cache, "fetch", *depth, lock["upstream"]["url"], commit, capture=False)
    destination.parent.mkdir(parents=True, exist_ok=True)
    git(cache, "worktree", "add", "--detach", destination, commit, capture=False)
    save_state(destination, {"format": 1, "baseline": baseline, "base": commit,
                             "digest": digest, "applied": [], "failed": None})
    print(destination)


def apply(root, source, through):
    _, patches, state = validate_source(root, source, complete=False)
    names = [patch["name"] for patch in patches]
    if through and through not in names:
        raise ValueError(f"Patch is not selected: {through}")
    count = names.index(through) + 1 if through else len(patches)
    if count < len(state["applied"]):
        raise ValueError("Requested prefix is already exceeded; prepare another worktree")
    for patch in patches[len(state["applied"]):count]:
        print(f"Applying {patch['name']}", flush=True)
        parent = git(source, "rev-parse", "HEAD").strip()
        try:
            git(source, "-c", "am.threeWay=false", "am", "--no-3way",
                "--committer-date-is-author-date", root / "patches/codex" / patch["name"], capture=False)
        except subprocess.CalledProcessError:
            state["failed"] = {"name": patch["name"], "parent": parent}
            save_state(source, state)
            raise ValueError(f"Stopped at {patch['name']}. Resolve the patch, git add the resolution, "
                             "run git am --continue, then use patches.py refresh --patch " + patch["name"])
        state["applied"].append({**patch, "commit": git(source, "rev-parse", "HEAD").strip(),
                                 "tree": git(source, "rev-parse", "HEAD^{tree}").strip()})
        save_state(source, state)
    print(json.dumps({"applied": len(state["applied"]), "selected": len(patches),
                      "tree": git(source, "rev-parse", "HEAD^{tree}").strip(),
                      "series_sha256": state["digest"]}))


def refresh(root, source, name):
    state = read_state(source)
    _, _, digest = load_plan(root, baseline=state["baseline"])
    if digest != state["digest"]:
        raise ValueError("Refresh requires an unchanged series and its prepared patch worktree")
    require_clean(source)
    failed = state.get("failed")
    if failed:
        expected_name, parent = failed["name"], failed["parent"]
    elif state["applied"]:
        expected_name = state["applied"][-1]["name"]
        parent = state["applied"][-2]["commit"] if len(state["applied"]) > 1 else state["base"]
    else:
        raise ValueError("No applied or failed patch to refresh")
    if name != expected_name or git(source, "rev-parse", "HEAD^").strip() != parent:
        raise ValueError("Refresh accepts exactly one commit at the end of the applied prefix")
    patch = git(source, "format-patch", "-1", "--stdout", "--full-index", "--binary",
                "--zero-commit", "--no-numbered", "--no-signature")
    path = root / "patches/codex" / name
    path.write_bytes(patch.encode("utf-8"))
    metadata_path = root / "patches/codex/metadata.json"
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    metadata[name]["sha256"] = sha256(path)
    write_json(metadata_path, metadata)
    _, _, state["digest"] = load_plan(root, baseline=state["baseline"])
    record = {"name": name, "sha256": metadata[name]["sha256"],
              "commit": git(source, "rev-parse", "HEAD").strip(),
              "tree": git(source, "rev-parse", "HEAD^{tree}").strip()}
    if failed:
        state["applied"].append(record)
    else:
        state["applied"][-1] = record
    state["failed"] = None
    save_state(source, state)
    print(f"Refreshed {name}; replay the remaining series and verify a fresh worktree")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=ROOT)
    commands = parser.add_subparsers(dest="command", required=True)
    command = commands.add_parser("prepare")
    command.add_argument("--name", default="runtime")
    command.add_argument("--baseline", action="store_true")
    for verb in ("apply", "refresh", "status"):
        command = commands.add_parser(verb)
        command.add_argument("--worktree", type=Path)
        if verb == "apply":
            command.add_argument("--through")
        elif verb == "refresh":
            command.add_argument("--patch", required=True)
    commands.add_parser("check")
    args = parser.parse_args()
    root = args.root.resolve()
    if args.command == "prepare":
        prepare(root, args.name, args.baseline)
    elif args.command == "check":
        lock, patches, digest = load_plan(root)
        print(json.dumps({"base": lock["upstream"]["commit"], "patches": patches,
                          "series_sha256": digest}, indent=2))
    else:
        source = (args.worktree or root / ".worktrees/runtime").resolve()
        if args.command == "apply":
            apply(root, source, args.through)
        elif args.command == "refresh":
            refresh(root, source, args.patch)
        else:
            print(json.dumps(read_state(source), indent=2))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, KeyError, OSError, subprocess.CalledProcessError) as error:
        print(f"error: {error}", file=sys.stderr)
        if isinstance(error, subprocess.CalledProcessError) and error.stderr:
            print(error.stderr, file=sys.stderr)
        sys.exit(1)
