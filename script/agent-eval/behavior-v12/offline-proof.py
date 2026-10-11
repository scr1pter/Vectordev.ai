"""Exercise freeze and evidence rejection paths against disposable, credential-free studies."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
specification = importlib.util.spec_from_file_location("runner", HERE / "run.py")
runner = importlib.util.module_from_spec(specification)
specification.loader.exec_module(runner)


class FrozenStudy(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="e12-freeze-proof-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        runner.ROOT = self.root
        self.source = self.root / "candidate"
        self.baseline = self.root / "baseline"
        for source in [self.source, self.baseline]:
            (source / "packages/core/src").mkdir(parents=True)
            (source / "packages/core/src/value.ts").write_text("export const value = 1\n")
        (self.baseline / "packages/core/src/link.ts").symlink_to("value.ts")
        env = {**os.environ, "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_CONFIG_SYSTEM": "/dev/null", "GIT_TERMINAL_PROMPT": "0"}
        for command in [["init", "--quiet"], ["add", "."], ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "fixture"]]:
            subprocess.run(["git", *command], cwd=self.source, env=env, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        self.fixture = self.root / "fixtures/case/src/value.ts"
        self.fixture.parent.mkdir(parents=True)
        self.fixture.write_text("export const fixture = true\n")
        runner.write(self.root / "study.json", {"candidate": str(self.source), "baseline": str(self.baseline), "candidateRevision": "fixture-revision", "bun": subprocess.check_output(["bun", "--version"], text=True).strip(), "bunExecutable": str(Path(shutil.which("bun")).resolve())})
        runner.write(self.root / "fixture-inventory.json", {str(path.relative_to(self.root)): "directory" if path.is_dir() else "file" for path in (self.root / "fixtures").rglob("*")})
        runner.write(self.root / "baseline-source-inventory.json", {str(path.relative_to(self.baseline)): "symlink" if path.is_symlink() else "directory" if path.is_dir() else "file" for path in (self.baseline / "packages/core/src").rglob("*")})
        sources = [self.source / "packages/core/src/value.ts", self.baseline / "packages/core/src/value.ts", self.baseline / "packages/core/src/link.ts"]
        runner.write(self.root / "source-lock.json", {str(path): runner.digest(path) for path in sources})
        runner.write(self.root / "source-path-lock.json", {str(path): {"resolved": str(path.resolve()), "link": str(path.readlink()) if path.is_symlink() else None} for path in sources})
        for name in ["run.py", "review.py"]:
            shutil.copyfile(HERE / name, self.root / name)
        names = ["study.json", "fixture-inventory.json", "baseline-source-inventory.json", "source-lock.json", "source-path-lock.json", "run.py", "review.py", str(self.fixture.relative_to(self.root))]
        runner.write(self.root / "harness-lock.json", {name: runner.digest(self.root / name) for name in names})
        runner.check()

    def test_changed_fixture_bytes_fail(self):
        self.fixture.write_text("changed scenario\n")
        with self.assertRaisesRegex(ValueError, "FROZEN_BYTES_CHANGED"):
            runner.check()

    def test_added_fixture_file_fails(self):
        (self.fixture.parent / "extra.ts").write_text("extra scenario input\n")
        with self.assertRaisesRegex(ValueError, "FIXTURE_INVENTORY_CHANGED"):
            runner.check()

    def test_fixture_symlink_fails_even_with_same_bytes(self):
        self.fixture.unlink()
        self.fixture.symlink_to(self.source / "packages/core/src/value.ts")
        with self.assertRaisesRegex(ValueError, "FIXTURE_INVENTORY_CHANGED"):
            runner.check()

    def test_untracked_candidate_source_fails(self):
        (self.source / "packages/core/src/extra.ts").write_text("export const extra = true\n")
        with self.assertRaisesRegex(ValueError, "CANDIDATE_WORKTREE_CHANGED"):
            runner.check()

    def test_added_baseline_source_fails(self):
        (self.baseline / "packages/core/src/extra.ts").write_text("export const extra = true\n")
        with self.assertRaisesRegex(ValueError, "BASELINE_SOURCE_INVENTORY_CHANGED"):
            runner.check()

    def test_changed_existing_source_link_fails(self):
        link = self.baseline / "packages/core/src/link.ts"
        link.unlink()
        link.symlink_to(self.source / "packages/core/src/value.ts")
        with self.assertRaisesRegex(ValueError, "FROZEN_SOURCE_PATH_CHANGED"):
            runner.check()

    def test_different_bun_executable_fails_before_execution(self):
        executable = self.root / "alternate-bin/bun"
        executable.parent.mkdir()
        executable.write_text("#!/bin/sh\nexit 99\n")
        executable.chmod(0o700)
        with patch.dict(os.environ, {"PATH": str(executable.parent) + os.pathsep + os.environ["PATH"]}):
            with self.assertRaisesRegex(ValueError, "FROZEN_BUN_EXECUTABLE_CHANGED"):
                runner.check()

    def test_mixed_live_and_synthetic_reports_fail(self):
        reports = []
        for mode in ["rehearse", "live-second"]:
            path = self.root / "runs" / mode / "report.json"
            path.parent.mkdir(parents=True)
            runner.write(path, {"mode": mode, "synthetic": mode == "rehearse"})
            reports.append(str(path))
        result = subprocess.run(["python3", str(self.root / "review.py"), "--reports", *reports, "--out", str(self.root / "blinded.json")], capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("MIXED_SYNTHETIC_AND_LIVE_EVIDENCE", result.stderr)
        self.assertFalse((self.root / "blinded.json").exists())

    def test_mislabeled_origin_fails(self):
        path = self.root / "runs/rehearse/report.json"
        path.parent.mkdir(parents=True)
        runner.write(path, {"mode": "rehearse", "synthetic": False})
        result = subprocess.run(["python3", str(self.root / "review.py"), "--reports", str(path), "--out", str(self.root / "blinded.json")], capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("REPORT_MODE_OR_ORIGIN_INVALID", result.stderr)
        self.assertFalse((self.root / "blinded.json").exists())


if __name__ == "__main__":
    unittest.main()
