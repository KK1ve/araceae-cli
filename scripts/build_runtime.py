#!/usr/bin/env python3
"""Build a locked Codex source tree and assemble an identified runtime archive."""

from __future__ import annotations

import argparse
import importlib
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import tomllib

from runtime_common import ROOT, git, run, sha256, validate_source, write_json
from runtime_checks import check_removed_surface, selected_checks


def build(root, source, target, profile, output, entrypoint_only, jobs):
    lock, patches, state = validate_source(root, source)
    toolchain = lock["rust_toolchain"]
    workspace_metadata = tomllib.loads((source / "codex-rs/Cargo.toml").read_text(encoding="utf-8"))
    source_toolchain = tomllib.loads((source / "codex-rs/rust-toolchain.toml").read_text(encoding="utf-8"))
    if workspace_metadata["workspace"]["package"]["version"] != lock["upstream"]["version"]:
        raise ValueError("Workspace version differs from the source lock")
    if source_toolchain["toolchain"]["channel"] != toolchain:
        raise ValueError("Rust toolchain differs from the source lock")
    rustc = run(["rustc", f"+{toolchain}", "-vV"], capture=True)
    host = next(line.removeprefix("host: ") for line in rustc.splitlines() if line.startswith("host: "))
    target = target or host
    os.environ["CODEX_REPO_ROOT"] = str(source)
    sys.path.insert(0, str(source / "scripts"))
    targets = importlib.import_module("codex_package.targets")
    if target not in targets.TARGET_SPECS:
        raise ValueError(f"Unsupported package target: {target}")
    spec = targets.TARGET_SPECS[target]
    selection = lock["baseline"] if state["baseline"] else lock["runtime"]
    executables = selection["executables"]
    variant = targets.PACKAGE_VARIANTS.get(selection["variant"])
    if variant is None or variant.executable_stem != executables["entrypoint"]:
        raise ValueError(f"Package variant {selection['variant']} does not provide the "
                         f"{executables['entrypoint']} entrypoint declared by the source lock")
    identity = state["digest"][:12]
    kind = "baseline" if state["baseline"] else "runtime"
    name = f"{executables['entrypoint']}-{lock['upstream']['version']}-{kind}-{identity}-{target}-{profile}"
    if entrypoint_only:
        name += "-entrypoint"
    output.mkdir(parents=True, exist_ok=True)
    destination = output / name
    if destination.exists():
        raise ValueError(f"Artifact already exists: {destination}")
    cargo_target = root / ".cache/cargo-target"
    env = {**os.environ, "CARGO_TARGET_DIR": str(cargo_target), "RUSTUP_TOOLCHAIN": toolchain}
    if jobs:
        env["CARGO_BUILD_JOBS"] = str(jobs)
    workspace = source / "codex-rs"
    cargo = ["cargo", f"+{toolchain}"]
    target_args = ["--target", target] if target != host else []
    build_command = [*cargo, "build", "--locked", *target_args, "--profile", profile]
    binaries = (cargo_target / target if target_args else cargo_target) / profile
    helpers = {}
    if not entrypoint_only:
        if spec.is_linux:
            run([*build_command, "-p", "codex-bwrap", "--bin", "bwrap"], cwd=workspace, env=env)
            bwrap = binaries / "bwrap"
            if profile == "release":
                strip = shutil.which(f"{target}-strip") or shutil.which("llvm-strip")
                if not strip and target == host:
                    strip = shutil.which("strip")
                if not strip:
                    raise ValueError(f"A strip tool for {target} is required before hashing bwrap")
                run([strip, "--strip-debug", "--strip-unneeded", bwrap])
            env["CODEX_BWRAP_SHA256"] = sha256(bwrap)
            helpers["--bwrap-bin"] = bwrap
        env.update(importlib.import_module("codex_package.v8").resolve_codex_v8_cargo_env(spec))
        helper_command = [*build_command, "-p", "codex-code-mode-host", "--bin", executables["code_mode_host"]]
        if spec.is_windows:
            helper_command.extend(["-p", "codex-windows-sandbox", "--bin", executables["command_runner"],
                                   "--bin", executables["windows_sandbox_setup"]])
            helpers["--codex-command-runner-bin"] = binaries / f"{executables['command_runner']}.exe"
            helpers["--codex-windows-sandbox-setup-bin"] = binaries / f"{executables['windows_sandbox_setup']}.exe"
        run(helper_command, cwd=workspace, env=env)
        helpers["--code-mode-host-bin"] = binaries / f"{executables['code_mode_host']}{spec.exe_suffix}"
    run([*build_command, "-p", selection["package"], "--bin", selection["binary"]], cwd=workspace, env=env)
    packages = [selection["package"]]
    if not entrypoint_only:
        packages.append("codex-code-mode-host")
        if spec.is_linux:
            packages.append("codex-bwrap")
        if spec.is_windows:
            packages.append("codex-windows-sandbox")
    package_args = [argument for package in packages for argument in ("-p", package)]
    tree = run([*cargo, "tree", "--locked", "--target", target, *package_args,
                "--edges", "normal,build", "--prefix", "none", "--format", "{p}"],
               cwd=workspace, capture=True, env=env)
    checks = selected_checks(root, patches)
    check_removed_surface(checks, set(), {line.split()[0] for line in tree.splitlines() if line.strip()})
    validate_source(root, source)
    with tempfile.TemporaryDirectory(prefix=".assemble-", dir=output) as temporary:
        package = Path(temporary) / "package"
        binary = binaries / f"{selection['binary']}{spec.exe_suffix}"
        if entrypoint_only:
            (package / "bin").mkdir(parents=True)
            shutil.copy2(binary, package / "bin" / variant.entrypoint_name(spec))
        else:
            command = [sys.executable, source / "scripts/build_codex_package.py", "--variant", variant.name,
                       "--target", target, "--cargo-profile", profile, "--package-dir", package,
                       "--entrypoint-bin", binary, "--strip", "all" if profile == "release" else "none"]
            for flag, path in helpers.items():
                command.extend([flag, path])
            run(command, cwd=source, env=env)
        for filename in ("LICENSE", "NOTICE"):
            if (source / filename).is_file():
                shutil.copy2(source / filename, package / filename)
        (package / "dependencies.txt").write_text(tree, encoding="utf-8")
        files = {}
        for path in sorted(package.rglob("*")):
            if path.is_symlink():
                raise ValueError(f"Package contains an unexpected symbolic link: {path}")
            if path.is_file():
                files[path.relative_to(package).as_posix()] = {"sha256": sha256(path), "size": path.stat().st_size}
        write_json(package / "araceae-build.json", {
            "format": 1, "upstream": lock["upstream"], "baseline": state["baseline"],
            "series_sha256": state["digest"], "patches": patches,
            "source_tree": git(source, "rev-parse", "HEAD^{tree}").strip(),
            "cargo_lock_sha256": sha256(workspace / "Cargo.lock"),
            "rust_toolchain": toolchain, "rustc": rustc.strip(), "target": target, "profile": profile,
            "entrypoint_only": entrypoint_only, "files": files,
        })
        shutil.move(str(package), destination)
    archive_format = "zip" if spec.is_windows else "gztar"
    archive = Path(shutil.make_archive(str(output / name), archive_format, root_dir=destination))
    archive.with_name(archive.name + ".sha256").write_text(f"{sha256(archive)}  {archive.name}\n", encoding="utf-8")
    print(f"Package: {destination}\nArchive: {archive}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=ROOT)
    parser.add_argument("--worktree", type=Path)
    parser.add_argument("--target")
    parser.add_argument("--profile", choices=("release", "dev-small"), default="release")
    parser.add_argument("--output", type=Path)
    parser.add_argument("--entrypoint-only", action="store_true", help="Build an entrypoint test artifact without platform helpers")
    parser.add_argument("--jobs", type=int)
    args = parser.parse_args()
    root = args.root.resolve()
    build(root, (args.worktree or root / ".worktrees/runtime").resolve(), args.target,
          args.profile, (args.output or root / "dist").resolve(), args.entrypoint_only, args.jobs)


if __name__ == "__main__":
    try:
        main()
    except (ValueError, KeyError, OSError, subprocess.CalledProcessError) as error:
        print(f"error: {error}", file=sys.stderr)
        if isinstance(error, subprocess.CalledProcessError) and error.stderr:
            print(error.stderr, file=sys.stderr)
        sys.exit(1)
