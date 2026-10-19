"""Exercise patch maintenance through the command line against real Git repositories."""

import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts/patches.py"


class PatchWorkflowTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="araceae-patch-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.cache = self.root / "codex"
        self.cache.mkdir()
        self.git(self.cache, "init", "-q")
        # Git stores fixture bytes verbatim; LF keeps patch context intact during text-mode capture.
        for name in ("entrypoint", "remote", "telemetry"):
            (self.cache / name).write_text(f"{name}=enabled\ntransport=v1\n", encoding="utf-8", newline="\n")
        self.base = self.commit("upstream baseline")
        self.patch_dir = self.root / "patches/codex"
        self.patch_dir.mkdir(parents=True)
        self.metadata = {}
        self.names = []
        for name in ("entrypoint", "remote", "telemetry"):
            (self.cache / name).write_text(f"{name}=disabled\ntransport=v1\n", encoding="utf-8", newline="\n")
            self.commit(f"disable {name}")
            filename = f"{name}.patch"
            patch = self.git(self.cache, "format-patch", "-1", "--stdout", "--full-index", "--binary",
                             "--zero-commit", "--no-numbered", "--no-signature").stdout
            (self.patch_dir / filename).write_text(patch, encoding="utf-8", newline="\n")
            self.metadata[filename] = {"depends_on": [], "sha256": self.digest(filename)}
            self.names.append(filename)
        self.expected_tree = self.git(self.cache, "rev-parse", "HEAD^{tree}").stdout.strip()
        (self.patch_dir / "series").write_text("\n".join(self.names) + "\n", encoding="utf-8", newline="\n")
        self.save_metadata()
        (self.root / "manifests").mkdir()
        self.lock = {"format": 1, "upstream": {"url": str(self.cache), "commit": self.base,
                     "tag": "test", "version": "1.0.0"}, "baseline": {"patches": []}}
        self.save_lock()

    def git(self, source, *args):
        return subprocess.run(["git", "-C", str(source), "-c", "user.name=Patch Test",
                               "-c", "user.email=patch-test@example.invalid", "-c", "commit.gpgsign=false",
                               "-c", "core.autocrlf=false", *args], check=True, text=True, capture_output=True)

    def commit(self, message):
        self.git(self.cache, "add", ".")
        self.git(self.cache, "commit", "-qm", message)
        return self.git(self.cache, "rev-parse", "HEAD").stdout.strip()

    def invoke(self, *args, ok=True, root=None, env=None):
        result = subprocess.run([sys.executable, str(SCRIPT), "--root", str(root or self.root), *args],
                                text=True, capture_output=True, env=env)
        if ok:
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        else:
            self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        return result

    def digest(self, name):
        return hashlib.sha256((self.patch_dir / name).read_bytes()).hexdigest()

    def save_metadata(self):
        (self.patch_dir / "metadata.json").write_text(json.dumps(self.metadata), encoding="utf-8", newline="\n")

    def save_lock(self):
        (self.root / "manifests/runtime-source-lock.json").write_text(json.dumps(self.lock), encoding="utf-8", newline="\n")

    def register_submodule(self):
        remote = self.root / "upstream.git"
        self.git(self.root, "clone", "--bare", str(self.cache), str(remote))
        self.git(self.cache, "checkout", "-q", "--detach", self.base)
        self.lock["upstream"]["url"] = remote.as_posix()
        self.save_lock()
        self.git(self.root, "init", "-q")
        self.git(self.root, "submodule", "add", remote.as_posix(), "codex")
        self.git(self.root, "config", "--file", ".gitmodules", "submodule.codex.shallow", "true")
        self.git(self.root, "add", ".gitmodules", "codex", "manifests", "patches")
        self.git(self.root, "commit", "-qm", "Register pinned source submodule")

    def test_uninitialized_submodule_is_prepared_and_patches_replay(self):
        self.register_submodule()
        consumer = self.root / "consumer"
        self.git(self.root, "clone", str(self.root), str(consumer))
        self.assertFalse((consumer / "codex/.git").exists())
        env = {**os.environ, "GIT_ALLOW_PROTOCOL": "file"}
        self.invoke("check", root=consumer)
        self.invoke("prepare", root=consumer, env=env)
        self.invoke("apply", root=consumer)
        self.assertTrue((consumer / "codex/.git").is_file())
        self.assertEqual(self.git(consumer / "codex", "rev-parse", "HEAD").stdout.strip(), self.base)
        self.assertEqual(self.git(consumer / ".worktrees/runtime", "rev-parse", "HEAD^{tree}").stdout.strip(),
                         self.expected_tree)
        self.assertEqual(self.git(consumer, "status", "--porcelain", "--", "codex").stdout, "")

    def test_submodule_pin_mismatch_is_rejected_before_preparation(self):
        self.register_submodule()
        self.lock["upstream"]["commit"] = "f" * 40
        self.save_lock()
        for command in ("check", "prepare"):
            self.assertIn("submodule pin differs", self.invoke(command, ok=False).stderr)
        self.assertFalse((self.root / ".worktrees").exists())

    def test_submodule_url_mismatch_is_rejected(self):
        self.register_submodule()
        self.lock["upstream"]["url"] = "https://example.invalid/other-source.git"
        self.save_lock()
        self.assertIn("path or URL differs", self.invoke("prepare", ok=False).stderr)
        self.assertFalse((self.root / ".worktrees").exists())

    def test_initialized_submodule_checkout_and_worktrees_are_preserved(self):
        self.register_submodule()
        linked = self.root / "existing-worktree"
        self.git(self.cache, "worktree", "add", "--detach", str(linked), self.base)
        (self.cache / "entrypoint").write_text("local checkout change\n", encoding="utf-8", newline="\n")
        local_head = self.commit("Keep local checkout work")
        (self.cache / "remote").write_text("uncommitted local change\n", encoding="utf-8", newline="\n")
        self.invoke("prepare")
        self.invoke("apply")
        self.assertEqual(self.git(self.cache, "rev-parse", "HEAD").stdout.strip(), local_head)
        self.assertEqual((self.cache / "remote").read_text(), "uncommitted local change\n")
        self.assertEqual(self.git(linked, "rev-parse", "HEAD").stdout.strip(), self.base)
        self.assertEqual(self.git(self.root / ".worktrees/runtime", "rev-parse", "HEAD^{tree}").stdout.strip(),
                         self.expected_tree)

    def test_replay_is_reproducible_and_preserves_upstream_checkout(self):
        upstream_head = self.git(self.cache, "rev-parse", "HEAD").stdout
        for name in ("first", "second"):
            self.invoke("prepare", "--name", name)
            source = self.root / ".worktrees" / name
            self.invoke("apply", "--worktree", str(source))
            self.assertEqual(self.git(source, "rev-parse", "HEAD^{tree}").stdout.strip(), self.expected_tree)
            self.invoke("apply", "--worktree", str(source))
        self.assertEqual(self.git(self.cache, "rev-parse", "HEAD").stdout, upstream_head)

    def test_failure_stops_queue_and_only_repaired_patch_changes(self):
        old_hashes = [self.digest(name) for name in self.names]
        self.git(self.cache, "checkout", "-q", "--detach", self.base)
        (self.cache / "remote").write_text("remote=enabled\ntransport=v2\n", encoding="utf-8", newline="\n")
        self.lock["upstream"]["commit"] = self.commit("change upstream transport")
        self.save_lock()
        self.invoke("prepare")
        failed = self.invoke("apply", ok=False)
        self.assertIn("Stopped at remote.patch", failed.stderr)
        source = self.root / ".worktrees/runtime"
        self.assertIn("disabled", (source / "entrypoint").read_text())
        self.assertIn("enabled", (source / "telemetry").read_text())
        self.invoke("apply", ok=False)
        (source / "remote").write_text("remote=disabled\ntransport=v2\n", encoding="utf-8", newline="\n")
        self.git(source, "add", "remote")
        self.git(source, "am", "--continue")
        self.invoke("refresh", "--patch", "remote.patch")
        self.assertEqual([self.digest(name) != old for name, old in zip(self.names, old_hashes)], [False, True, False])
        self.invoke("apply")
        expected = self.git(source, "rev-parse", "HEAD^{tree}").stdout
        self.invoke("prepare", "--name", "repaired")
        repaired = self.root / ".worktrees/repaired"
        self.invoke("apply", "--worktree", str(repaired))
        self.assertEqual(self.git(repaired, "rev-parse", "HEAD^{tree}").stdout, expected)

    def test_corrupted_patch_is_rejected_before_preparation(self):
        with (self.patch_dir / "remote.patch").open("a") as stream:
            stream.write("tampered\n")
        self.assertIn("checksum mismatch", self.invoke("prepare", ok=False).stderr)
        self.assertFalse((self.root / ".worktrees/runtime").exists())

    def test_source_cache_can_be_created_from_the_locked_commit(self):
        remote = self.root / "upstream-source"
        self.cache.rename(remote)
        self.lock["upstream"]["url"] = str(remote)
        self.save_lock()
        self.invoke("prepare")
        self.invoke("apply")
        source = self.root / ".worktrees/runtime"
        self.assertEqual(self.git(source, "rev-parse", "HEAD^{tree}").stdout.strip(), self.expected_tree)

    def test_missing_baseline_patch_is_rejected(self):
        self.lock["baseline"]["patches"] = ["absent.patch"]
        self.save_lock()
        self.assertIn("Baseline patches are missing", self.invoke("prepare", "--baseline", ok=False).stderr)

    def test_missing_predecessor_is_rejected(self):
        self.metadata["entrypoint.patch"]["depends_on"] = ["remote.patch"]
        self.save_metadata()
        self.assertIn("requires earlier patches", self.invoke("check", ok=False).stderr)

    def test_dirty_worktree_and_unrecorded_commits_are_rejected(self):
        self.invoke("prepare")
        source = self.root / ".worktrees/runtime"
        (source / "untracked").write_text("local work", encoding="utf-8", newline="\n")
        self.assertIn("uncommitted changes", self.invoke("apply", ok=False).stderr)
        self.git(source, "add", "untracked")
        self.git(source, "commit", "-qm", "local work")
        self.assertIn("HEAD differs", self.invoke("apply", ok=False).stderr)

    def test_prefix_can_be_amended_without_reexporting_later_patches(self):
        self.invoke("prepare")
        self.invoke("apply", "--through", "entrypoint.patch")
        source = self.root / ".worktrees/runtime"
        untouched = self.digest("telemetry.patch")
        (source / "entrypoint").write_text("entrypoint=minimal\ntransport=v1\n", encoding="utf-8", newline="\n")
        self.git(source, "add", "entrypoint")
        self.git(source, "commit", "--amend", "--no-edit")
        self.invoke("refresh", "--patch", "entrypoint.patch")
        self.invoke("apply")
        self.assertEqual(self.digest("telemetry.patch"), untouched)
        self.assertIn("minimal", (source / "entrypoint").read_text())

    def test_baseline_uses_only_declared_build_repairs(self):
        self.lock["baseline"]["patches"] = ["entrypoint.patch"]
        self.save_lock()
        self.invoke("prepare", "--baseline")
        self.invoke("apply")
        source = self.root / ".worktrees/runtime"
        self.assertIn("disabled", (source / "entrypoint").read_text())
        self.assertIn("enabled", (source / "remote").read_text())

    def test_baseline_build_repair_can_be_refreshed(self):
        self.lock["baseline"]["patches"] = ["entrypoint.patch"]
        self.save_lock()
        self.invoke("prepare", "--baseline")
        self.invoke("apply")
        source = self.root / ".worktrees/runtime"
        (source / "entrypoint").write_text("entrypoint=repaired\ntransport=v1\n", encoding="utf-8", newline="\n")
        self.git(source, "add", "entrypoint")
        self.git(source, "commit", "--amend", "--no-edit")
        self.invoke("refresh", "--patch", "entrypoint.patch")
        self.invoke("apply")
        self.assertIn("repaired", (source / "entrypoint").read_text())
        self.assertIn("enabled", (source / "remote").read_text())

    def test_build_rejects_an_incomplete_series(self):
        self.invoke("prepare")
        self.invoke("apply", "--through", "entrypoint.patch")
        result = subprocess.run([sys.executable, str(ROOT / "scripts/build_runtime.py"),
                                 "--root", str(self.root), "--entrypoint-only"], capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("series is incomplete", result.stderr)


if __name__ == "__main__":
    unittest.main()
