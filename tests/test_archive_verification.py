"""Verify download integrity through the artifact verifier command line."""

import hashlib
import io
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest
import zipfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from runtime_common import load_plan


class ArchiveVerificationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="araceae-archive-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.package = self.root / "package"
        self.lock, patches, digest = load_plan(ROOT)
        self.entrypoint = f"bin/{self.lock['runtime']['executables']['entrypoint']}"
        self.metadata = {
            "format": 1, "upstream": self.lock["upstream"], "baseline": False, "patches": patches,
            "series_sha256": digest, "rust_toolchain": self.lock["rust_toolchain"], "profile": "dev-small",
            "target": "x86_64-unknown-linux-gnu", "entrypoint_only": True, "files": {},
        }
        self.package_files({self.entrypoint: b"integrity fixture; execution is disabled\n"})

    def package_files(self, files):
        shutil.rmtree(self.package, ignore_errors=True)
        for name, content in files.items():
            (self.package / name).parent.mkdir(parents=True, exist_ok=True)
            (self.package / name).write_bytes(content)
        self.metadata["files"] = {name: {"sha256": hashlib.sha256(content).hexdigest(), "size": len(content)}
                                  for name, content in files.items()}
        self.save_manifest()

    def package_linux_layout(self, layout):
        executables = self.lock["runtime"]["executables"]
        manifest = {"version": self.lock["upstream"]["version"], "target": self.metadata["target"],
                    "entrypoint": self.entrypoint, "resourcesDir": layout["resources"], "pathDir": layout["path"]}
        self.metadata["entrypoint_only"] = False
        self.package_files({
            self.entrypoint: b"entrypoint fixture\n", f"bin/{executables['code_mode_host']}": b"host fixture\n",
            f"{layout['path']}/rg": b"rg fixture\n", f"{layout['resources']}/bwrap": b"bwrap fixture\n",
            layout["manifest"]: json.dumps(manifest).encode(),
        })

    def save_manifest(self):
        (self.package / "araceae-build.json").write_text(json.dumps(self.metadata))

    def checksum(self, archive):
        digest = hashlib.sha256(archive.read_bytes()).hexdigest()
        archive.with_name(archive.name + ".sha256").write_text(f"{digest}  {archive.name}\n")

    def archive(self, kind):
        archive = self.root / f"runtime.{kind}"
        if kind == "zip":
            with zipfile.ZipFile(archive, "w") as stream:
                for path in self.package.rglob("*"):
                    if path.is_file():
                        stream.write(path, path.relative_to(self.package))
        else:
            with tarfile.open(archive, "w:gz") as stream:
                stream.add(self.package, arcname=".")
        self.checksum(archive)
        return archive

    def invoke(self, *args, ok=True):
        result = subprocess.run([sys.executable, str(ROOT / "scripts/verify_runtime.py"), "--integrity-only", *map(str, args)],
                                capture_output=True, text=True)
        if ok:
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        else:
            self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        return result

    def test_zip_and_tar_downloads_verify_without_claiming_execution(self):
        for kind in ("zip", "tar.gz"):
            with self.subTest(kind=kind):
                result = self.invoke("--archive", self.archive(kind))
                self.assertEqual(json.loads(result.stdout)["execution"], "not-run")

    def test_archive_corruption_is_rejected_before_extraction(self):
        archive = self.archive("tar.gz")
        with archive.open("ab") as stream:
            stream.write(b"changed")
        self.assertIn("Archive checksum mismatch", self.invoke("--archive", archive, ok=False).stderr)

    def test_file_corruption_and_undeclared_files_are_rejected(self):
        (self.package / self.entrypoint).write_bytes(b"different binary")
        self.assertIn("file checksum mismatch", self.invoke("--package", self.package, ok=False).stderr)
        (self.package / "extra").write_text("not declared")
        self.assertIn("file list differs", self.invoke("--package", self.package, ok=False).stderr)

    def test_runtime_package_requires_the_araceae_entrypoint(self):
        self.package_files({"bin/codex": b"upstream entrypoint name\n"})
        self.assertIn("Missing package resources", self.invoke("--package", self.package, ok=False).stderr)

    def test_entrypoint_that_still_names_codex_helpers_is_rejected(self):
        self.package_files({self.entrypoint: b"helper lookup: codex-command-runner.exe\n"})
        result = self.invoke("--package", self.package, ok=False)
        self.assertIn("araceae-executable-names failed", result.stderr)
        self.assertIn("codex-command-runner", result.stderr)

    def test_baseline_package_keeps_the_upstream_entrypoint(self):
        lock, patches, digest = load_plan(ROOT, baseline=True)
        self.metadata.update({"baseline": True, "patches": patches, "series_sha256": digest})
        self.package_files({f"bin/{lock['baseline']['executables']['entrypoint']}": b"baseline fixture\n"})
        self.assertEqual(json.loads(self.invoke("--package", self.package).stdout)["integrity"], "passed")

    def test_full_runtime_package_uses_the_araceae_layout(self):
        self.package_linux_layout(self.lock["runtime"]["layout"])
        self.assertEqual(json.loads(self.invoke("--package", self.package).stdout)["integrity"], "passed")

    def test_full_runtime_package_with_upstream_layout_names_is_rejected(self):
        self.package_linux_layout(self.lock["baseline"]["layout"])
        result = self.invoke("--package", self.package, ok=False)
        self.assertIn("Missing package resources", result.stderr)
        self.assertIn(self.lock["runtime"]["layout"]["manifest"], result.stderr)

    def test_stale_patch_identity_is_rejected(self):
        self.metadata["series_sha256"] = "0" * 64
        self.save_manifest()
        self.assertIn("source identity differs", self.invoke("--package", self.package, ok=False).stderr)

    def test_tar_paths_cannot_escape_the_extraction_directory(self):
        archive = self.root / "unsafe.tar.gz"
        with tarfile.open(archive, "w:gz") as stream:
            entry = tarfile.TarInfo("../escaped")
            entry.size = 4
            stream.addfile(entry, io.BytesIO(b"data"))
        self.checksum(archive)
        self.assertIn("unsafe path", self.invoke("--archive", archive, ok=False).stderr)

    def test_zip_paths_cannot_escape_the_extraction_directory(self):
        archive = self.root / "unsafe.zip"
        with zipfile.ZipFile(archive, "w") as stream:
            stream.writestr("../escaped", b"data")
        self.checksum(archive)
        self.assertIn("unsafe path", self.invoke("--archive", archive, ok=False).stderr)


if __name__ == "__main__":
    unittest.main()
