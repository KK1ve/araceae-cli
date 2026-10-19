#!/usr/bin/env python3
"""Replay and validate each patch prefix without creating distributable partial packages."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import subprocess
import sys

from patches import apply, prepare
from runtime_common import ROOT, git, load_plan, run, validate_source, write_json
from runtime_checks import check_binary_references, selected_checks
from verify_runtime import verify_protocol


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=ROOT)
    parser.add_argument("--name", default="prefix-validation")
    parser.add_argument("--report", type=Path, default=ROOT / "artifacts/patch-prefixes.json")
    args = parser.parse_args()
    root = args.root.resolve()
    lock, patches, _ = load_plan(root)
    prepare(root, args.name, False)
    source = root / ".worktrees" / args.name
    target = root / ".cache/cargo-target"
    env = {**os.environ, "CARGO_TARGET_DIR": str(target), "RUSTUP_TOOLCHAIN": lock["rust_toolchain"]}
    cargo = ["cargo", "+" + lock["rust_toolchain"]]
    reports = []
    original_methods = None
    for patch in patches:
        apply(root, source, patch["name"])
        _, _, state = validate_source(root, source, complete=False)
        if not (source / "codex-rs/runtime-cli").is_dir():
            continue
        checks = selected_checks(root, state["applied"])
        run([*cargo, "build", "--locked", "--profile", "dev-small", "-p", lock["runtime"]["package"]], cwd=source / "codex-rs", env=env)
        binary = target / "dev-small" / (lock["runtime"]["binary"] + (".exe" if os.name == "nt" else ""))
        check_binary_references(checks, binary)
        tree = run([*cargo, "tree", "--locked", "-p", lock["runtime"]["package"], "--edges", "normal,build", "--prefix", "none", "--format", "{p}"], cwd=source / "codex-rs", env=env, capture=True)
        methods = verify_protocol(binary, checks, {line.split()[0] for line in tree.splitlines() if line.strip()}, env)
        if original_methods is None:
            original_methods = methods
        removed = {method for contract in checks.values() for method in contract.get("methods", [])}
        expected = original_methods - removed
        if methods != expected:
            raise ValueError(f"Unexpected protocol changes: removed {sorted(expected - methods)}, added {sorted(methods - expected)}")
        test_env = {**env, "ARACEAE_CODEX_BIN": str(binary), "ARACEAE_RUNTIME_CHECKS": json.dumps(checks)}
        run(["node", "--test", "tests/runtime-e2e.test.mjs", "tests/runtime-pruning.test.mjs",
             "tests/runtime-araceae-names.test.mjs"], cwd=root, env=test_env)
        reports.append({"patch": patch["name"], "source_tree": git(source, "rev-parse", "HEAD^{tree}").strip(), "checks": list(checks), "result": "passed"})
        write_json(args.report, {"prefixes": reports})


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, subprocess.SubprocessError) as error:
        print(f"error: {error}", file=sys.stderr)
        sys.exit(1)
