#!/usr/bin/env python3
"""Verify runtime package integrity, protocol schema, and internal patch dispatch."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import zipfile

from runtime_common import ROOT, load_plan, sha256, write_json
from runtime_checks import check_binary_references, check_removed_surface, selected_checks
from network_checks import check_loopback_connections

METHODS = {
    "initialize", "thread/start", "thread/resume", "turn/start", "turn/steer", "turn/interrupt",
    "collaborationMode/list", "skills/list", "skills/config/write", "thread/backgroundTerminals/list",
    "thread/backgroundTerminals/terminate", "thread/backgroundTerminals/clean", "item/tool/call",
    "item/tool/requestUserInput", "item/commandExecution/requestApproval", "item/fileChange/requestApproval",
    "item/permissions/requestApproval", "mcpServer/elicitation/request",
    "mcpServer/oauth/login", "mcpServer/oauthLogin/completed", "config/mcpServer/reload",
    "thread/compact/start", "model/list", "thread/tokenUsage/updated",
}
FIELDS = {"dynamicTools", "outputSchema", "approvalPolicy", "approvalsReviewer", "sandboxPolicy", "additionalContext"}


def verify_protocol(binary, checks, dependencies, env=None):
    """Check stable and experimental JSON/TypeScript exports from the actual binary."""
    experimental_methods = set()
    with tempfile.TemporaryDirectory(prefix="araceae-protocol-") as directory:
        for experimental in (False, True):
            for kind in ("generate-json-schema", "generate-ts"):
                destination = Path(directory) / f"{kind}-{experimental}"
                command = [str(binary), "app-server", kind, "--out", str(destination)]
                if experimental:
                    command.append("--experimental")
                subprocess.run(command, env=env, check=True, capture_output=True, timeout=60)
                methods, fields = set(), set()
                if kind == "generate-json-schema":
                    for path in destination.rglob("*.json"):
                        schema_surface(json.loads(path.read_text(encoding="utf-8")), methods, fields)
                    if experimental and not FIELDS <= fields:
                        raise ValueError(f"Missing protocol fields: {sorted(FIELDS - fields)}")
                else:
                    for path in destination.rglob("*.ts"):
                        methods.update(re.findall(r'"method"\s*:\s*"([^"]+)"', path.read_text(encoding="utf-8")))
                if experimental and not METHODS <= methods:
                    raise ValueError(f"Missing {kind} methods: {sorted(METHODS - methods)}")
                check_removed_surface(checks, methods, dependencies)
                if experimental and kind == "generate-json-schema":
                    experimental_methods = methods
    return experimental_methods


def schema_surface(value, methods, fields):
    if isinstance(value, dict):
        fields.update(value.get("properties", {}).keys())
        method = value.get("properties", {}).get("method", {})
        methods.update(method.get("enum", []))
        if isinstance(method.get("const"), str):
            methods.add(method["const"])
        for child in value.values():
            schema_surface(child, methods, fields)
    elif isinstance(value, list):
        for child in value:
            schema_surface(child, methods, fields)


def verify(root, package, execute, report, e2e=False, network_trace=None):
    metadata = json.loads((package / "araceae-build.json").read_text(encoding="utf-8"))
    lock, patches, digest = load_plan(root, baseline=metadata["baseline"])
    if metadata["format"] != 1 or metadata["upstream"] != lock["upstream"] or metadata["series_sha256"] != digest or metadata["patches"] != patches:
        raise ValueError("Package source identity differs from the selected lock and patch series")
    if metadata["rust_toolchain"] != lock["rust_toolchain"] or metadata["profile"] not in ("release", "dev-small"):
        raise ValueError("Package toolchain or build profile is invalid")
    actual = set()
    for path in package.rglob("*"):
        if path.is_symlink():
            raise ValueError(f"Package contains an unexpected symbolic link: {path}")
        if path.is_file():
            actual.add(path.relative_to(package).as_posix())
    if actual != set(metadata["files"]) | {"araceae-build.json"}:
        raise ValueError("Package file list differs from its build manifest")
    for name, expected in metadata["files"].items():
        path = package / name
        if path.stat().st_size != expected["size"] or sha256(path) != expected["sha256"]:
            raise ValueError(f"Package file checksum mismatch: {name}")
    checks = selected_checks(root, patches)
    dependencies = set()
    if (package / "dependencies.txt").exists():
        dependencies = {line.split()[0] for line in (package / "dependencies.txt").read_text(encoding="utf-8").splitlines() if line.strip()}
    check_removed_surface(checks, set(), dependencies)
    selection = lock["baseline"] if metadata["baseline"] else lock["runtime"]
    executables, layout = selection["executables"], selection["layout"]
    windows = "windows" in metadata["target"]
    suffix = ".exe" if windows else ""
    entrypoint = f"bin/{executables['entrypoint']}{suffix}"
    required = {entrypoint}
    if not metadata["entrypoint_only"]:
        required |= {layout["manifest"], f"bin/{executables['code_mode_host']}{suffix}", f"{layout['path']}/rg{suffix}"}
        if windows:
            required |= {f"{layout['resources']}/{executables['command_runner']}.exe",
                         f"{layout['resources']}/{executables['windows_sandbox_setup']}.exe"}
        elif "linux" in metadata["target"]:
            required.add(f"{layout['resources']}/bwrap")
    if not required <= actual:
        raise ValueError(f"Missing package resources: {sorted(required - actual)}")
    if not metadata["entrypoint_only"]:
        upstream_manifest = json.loads((package / layout["manifest"]).read_text(encoding="utf-8"))
        expected_manifest = {"version": lock["upstream"]["version"], "target": metadata["target"], "entrypoint": entrypoint,
                             "resourcesDir": layout["resources"], "pathDir": layout["path"]}
        if any(upstream_manifest.get(key) != value for key, value in expected_manifest.items()):
            raise ValueError("Upstream package layout manifest differs from the expected version, target, entrypoint, or directories")
    check_binary_references(checks, package / entrypoint)
    result = {"series_sha256": digest, "target": metadata["target"], "integrity": "passed", "execution": "not-run"}
    if execute:
        binary = package / entrypoint
        with tempfile.TemporaryDirectory(prefix="araceae-runtime-verify-") as directory:
            temporary = Path(directory)
            env = {**os.environ, "CODEX_HOME": str(temporary / "home"), "CODEX_SQLITE_HOME": str(temporary / "state")}
            def invoke(*args, check=True):
                return subprocess.run([str(binary), *args], cwd=temporary, env=env, text=True,
                                      capture_output=True, check=check, timeout=60)
            version = invoke("--version").stdout.strip()
            if lock["upstream"]["version"] not in version:
                raise ValueError(f"Unexpected binary version: {version}")
            if "app-server" not in invoke("--help").stdout:
                raise ValueError("Runtime help does not expose app-server")
            if not metadata["baseline"]:
                for command in ("exec", "login", "review", "cloud", "completion"):
                    if invoke(command, "--help", check=False).returncode == 0:
                        raise ValueError(f"Removed command remains available: {command}")
            methods = verify_protocol(binary, checks, dependencies, env)
            patch = "*** Begin Patch\n*** Add File: helper-marker.txt\n+HELPER_DISPATCH_OK\n*** End Patch"
            invoke("--codex-run-as-apply-patch", patch)
            if (temporary / "helper-marker.txt").read_text(encoding="utf-8") != "HELPER_DISPATCH_OK\n":
                raise ValueError("Internal apply_patch dispatch did not create the expected file")
            result.update({"execution": "passed", "version": version, "methods": sorted(methods), "required_fields": sorted(FIELDS)})
        if e2e:
            command = ["node", "--test", str(root / "tests/runtime-e2e.test.mjs"), str(root / "tests/runtime-pruning.test.mjs"),
                       str(root / "tests/runtime-araceae-names.test.mjs"), str(root / "tests/runtime-features.test.mjs"),
                       str(root / "tests/runtime-chat.test.mjs")]
            if network_trace:
                if sys.platform != "linux" or not shutil.which("strace"):
                    raise ValueError("--network-trace requires Linux and strace")
                network_trace = network_trace.resolve()
                network_trace.parent.mkdir(parents=True, exist_ok=True)
                command = ["strace", "-f", "-qq", "-s", "0", "-e", "trace=connect", "-o", str(network_trace), *command]
            subprocess.run(command, cwd=root,
                           env={**os.environ, "ARACEAE_CODEX_BIN": str(binary), "ARACEAE_RUNTIME_CHECKS": json.dumps(checks)}, check=True, timeout=600)
            result["model_e2e"] = "passed"
            result["patch_checks"] = list(checks)
            if network_trace:
                result["network_observation"] = check_loopback_connections(network_trace)
    if report:
        write_json(report, result)
    print(json.dumps({key: value for key, value in result.items() if key != "methods"}, indent=2))


def verify_archive(root, archive, execute, report, e2e, network_trace=None):
    checksum = archive.with_name(archive.name + ".sha256").read_text(encoding="utf-8").split()
    if len(checksum) != 2 or checksum[1] != archive.name or sha256(archive) != checksum[0]:
        raise ValueError("Archive checksum mismatch")
    with tempfile.TemporaryDirectory(prefix="araceae runtime archive-") as temporary:
        package = Path(temporary).resolve()
        if archive.name.endswith(".zip"):
            with zipfile.ZipFile(archive) as stream:
                for member in stream.infolist():
                    path = (package / member.filename).resolve()
                    if not path.is_relative_to(package) or (member.external_attr >> 16) & 0o170000 == 0o120000:
                        raise ValueError("Archive contains an unsafe path or symbolic link")
                stream.extractall(package)
        elif archive.name.endswith(".tar.gz"):
            with tarfile.open(archive) as stream:
                for member in stream.getmembers():
                    path = (package / member.name).resolve()
                    if not path.is_relative_to(package) or not (member.isfile() or member.isdir()):
                        raise ValueError("Archive contains an unsafe path or special file")
                stream.extractall(package, filter="data")
        else:
            raise ValueError("Supported archive formats are .tar.gz and .zip")
        verify(root, package, execute, report, e2e, network_trace)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=ROOT)
    inputs = parser.add_mutually_exclusive_group(required=True)
    inputs.add_argument("--package", type=Path)
    inputs.add_argument("--archive", type=Path, help="Check the sidecar hash and verify an extracted download archive")
    parser.add_argument("--integrity-only", action="store_true", help="Do not execute binaries built for another host")
    parser.add_argument("--report", type=Path)
    parser.add_argument("--e2e", action="store_true", help="Run AIMock end-to-end tests against the verified binary")
    parser.add_argument("--network-trace", type=Path, help="Observe Linux fixture connect syscalls with strace and reject non-loopback destinations")
    args = parser.parse_args()
    if args.integrity_only and args.e2e:
        parser.error("--e2e cannot be combined with --integrity-only")
    if args.network_trace and not args.e2e:
        parser.error("--network-trace requires --e2e")
    if args.archive:
        verify_archive(args.root.resolve(), args.archive.resolve(), not args.integrity_only, args.report, args.e2e, args.network_trace)
    else:
        verify(args.root.resolve(), args.package.resolve(), not args.integrity_only, args.report, args.e2e, args.network_trace)


if __name__ == "__main__":
    try:
        main()
    except (ValueError, KeyError, OSError, subprocess.SubprocessError, tarfile.TarError, zipfile.BadZipFile) as error:
        print(f"error: {error}", file=sys.stderr)
        if isinstance(error, subprocess.CalledProcessError) and error.stderr:
            print(error.stderr, file=sys.stderr)
        sys.exit(1)
