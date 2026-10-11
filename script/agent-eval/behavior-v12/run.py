"""Run a frozen derived E12 checkpoint study; live modes require explicit owner invocation."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parent


def read(path):
    return json.loads(Path(path).read_text())


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def write(path, value):
    Path(path).write_text(json.dumps(value, indent=2) + "\n")


def check():
    runtime = shutil.which("bun")
    if not runtime or str(Path(runtime).resolve()) != read(ROOT / "study.json")["bunExecutable"]:
        raise ValueError("FROZEN_BUN_EXECUTABLE_CHANGED")
    source = read(ROOT / "study.json")["candidate"]
    status = subprocess.check_output(["git", "status", "--porcelain", "--untracked-files=normal", "--", "packages", "bun.lock", "package.json", "tsconfig.json"], cwd=source, text=True)
    if status:
        raise ValueError("CANDIDATE_WORKTREE_CHANGED")
    fixtures = list((ROOT / "fixtures").rglob("*"))
    if (ROOT / "fixtures").is_symlink() or any(path.is_symlink() for path in fixtures) or {str(path.relative_to(ROOT)): "directory" if path.is_dir() else "file" for path in fixtures} != read(ROOT / "fixture-inventory.json"):
        raise ValueError("FIXTURE_INVENTORY_CHANGED")
    baseline = Path(read(ROOT / "study.json")["baseline"])
    expected_inventory = read(ROOT / "baseline-source-inventory.json")
    directories = {name.split("/src/", 1)[0] + "/src" for name in expected_inventory if "/src/" in name}
    inventory = {str(path.relative_to(baseline)): "symlink" if path.is_symlink() else "directory" if path.is_dir() else "file" for name in directories for path in (baseline / name).rglob("*")}
    if inventory != expected_inventory:
        raise ValueError("BASELINE_SOURCE_INVENTORY_CHANGED")
    for name, expected in read(ROOT / "source-path-lock.json").items():
        path = Path(name)
        if {"resolved": str(path.resolve()), "link": str(path.readlink()) if path.is_symlink() else None} != expected:
            raise ValueError("FROZEN_SOURCE_PATH_CHANGED: " + name)
    for lock in ["harness-lock.json", "source-lock.json"]:
        for name, expected in read(ROOT / lock).items():
            if lock == "harness-lock.json" and (ROOT / name).is_symlink():
                raise ValueError("FROZEN_PATH_BECAME_SYMLINK: " + name)
            if digest(ROOT / name) != expected:
                raise ValueError("FROZEN_BYTES_CHANGED: " + name)
    if subprocess.check_output(["bun", "--version"], text=True).strip() != read(ROOT / "study.json")["bun"]:
        raise ValueError("FROZEN_BUN_CHANGED")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=["check", "preflight", "rehearse", "live-first", "live-second"])
    parser.add_argument("--accept-provider-spend", action="store_true")
    parser.add_argument("--offline-review-sha256")
    parser.add_argument("--first-block-review-sha256")
    args = parser.parse_args()
    check()
    if args.mode == "check":
        print(json.dumps({"integrity": "passed", "providerCalls": 0}))
        return
    live = args.mode.startswith("live-")
    if live:
        if not args.accept_provider_spend or not os.environ.get("E12_SIGNIN_DATA"):
            parser.error("Live modes require --accept-provider-spend and E12_SIGNIN_DATA from a fresh normal CLI sign-in")
        signin = Path(os.environ["E12_SIGNIN_DATA"]).absolute()
        if signin.resolve() != signin or not signin.is_relative_to(ROOT):
            parser.error("Use a fresh sign-in data directory inside this prepared study; never point at desktop data")
        preflight = read(ROOT / "runs/preflight/report.json")
        rehearsal = read(ROOT / "runs/rehearse/report.json")
        if preflight["status"] != "complete" or sum(row["status"] == "recorded" for row in preflight["rows"]) != 36 or rehearsal["status"] != "complete" or sum(row["status"] == "recorded" for row in rehearsal["rows"]) != 6:
            raise ValueError("OFFLINE_PREFLIGHT_AND_REHEARSAL_REQUIRED")
        if args.offline_review_sha256 != digest(ROOT / "offline-ready.json"):
            raise ValueError("EXPLICIT_OFFLINE_REVIEW_REQUIRED")
        for name, expected in read(ROOT / "offline-ready.json")["bindings"].items():
            if digest(ROOT / name) != expected:
                raise ValueError("OFFLINE_EVIDENCE_CHANGED")
        if args.mode == "live-second":
            first = ROOT / "runs/live-first/report.json"
            if args.first_block_review_sha256 != digest(first) or read(first)["status"] != "complete" or sum(row["status"] == "recorded" for row in read(first)["rows"]) != 6:
                raise ValueError("EXPLICIT_FIRST_BLOCK_PROTOCOL_REVIEW_REQUIRED")
    rows = read(ROOT / "schedule.json")
    selected = rows if args.mode == "preflight" else rows[6:] if args.mode == "live-second" else rows[:6]
    destination = ROOT / "runs" / args.mode
    destination.mkdir(parents=True, exist_ok=False, mode=0o700)
    report = {"mode": args.mode, "synthetic": not live, "candidateRevision": read(ROOT / "study.json")["candidateRevision"],
        "harnessLockSha256": digest(ROOT / "harness-lock.json"), "sourceLockSha256": digest(ROOT / "source-lock.json"),
        "status": "running", "startedAt": datetime.now(timezone.utc).isoformat(), "expected": 36,
        "rows": [{key: value for key, value in row.items() if key != "source"} | {"status": "not-started", "attempts": []} for row in rows], "providerInvocations": 0,
        "behavioralGate": "unreviewed", "actualBilledCost": None, "firstBlockReviewSha256": args.first_block_review_sha256}
    write(destination / "report.json", report)
    shapes = {}
    try:
        for row in selected:
            check()
            actor = destination / row["id"]
            case = ROOT / row["casePath"]
            environment = {**os.environ, "E12_MODE": args.mode}
            entry = next(item for item in report["rows"] if item["id"] == row["id"])
            entry.update(status="started", actorEvidence=f"{row['id']}/episodes.json")
            write(destination / "report.json", report)
            with (destination / (row["id"] + ".launcher.log")).open("x") as log:
                result = subprocess.run([sys.executable, str(ROOT / "actor-launch.py"), "--source", row["source"], "--case", str(case), "--output", str(actor), "--endpoint", "http://127.0.0.1:1"], env=environment, cwd=ROOT, stdout=log, stderr=subprocess.STDOUT)
            if (actor / "transport-attempts.json").exists():
                entry["attempts"] = read(actor / "transport-attempts.json")
                if live:
                    report["providerInvocations"] += len(entry["attempts"])
            if result.returncode:
                entry["status"] = "failed"
                raise ValueError("ACTOR_FAILED: " + row["id"])
            audit = subprocess.run(["bun", str(ROOT / "audit.ts"), str(actor)], cwd=ROOT, capture_output=True, text=True)
            (actor / "audit.log").write_text(audit.stdout + audit.stderr)
            if audit.returncode:
                entry["status"] = "failed"
                raise ValueError("SOURCE_OR_SHELL_AUDIT_FAILED: " + row["id"])
            evidence = read(actor / "audit.json")
            entry.update(status="recorded", audit=evidence, sourceConsumption=evidence["consumption"], shellReceiptIntegrity=evidence["shell"], stopReason=evidence["stop"])
            shapes[row["id"]] = evidence["shape"]
            write(destination / "report.json", report)
        check()
        report["status"] = "complete"
        if args.mode == "preflight":
            write(ROOT / "preflight-shapes.json", shapes)
    except BaseException as error:
        report["status"] = "failed"
        report["error"] = str(error)
        raise
    finally:
        report["completedAt"] = datetime.now(timezone.utc).isoformat()
        write(destination / "report.json", report)
    if args.mode == "rehearse" and (ROOT / "runs/preflight/report.json").exists():
        write(ROOT / "offline-ready.json", {"candidateRevision": report["candidateRevision"], "behavioralGate": "unreviewed", "providerCalls": 0,
            "bindings": {name: digest(ROOT / name) for name in ["runs/preflight/report.json", "runs/rehearse/report.json", "preflight-shapes.json", "harness-lock.json", "source-lock.json"]}})
    print(json.dumps({"status": report["status"], "episodes": sum(row["status"] == "recorded" for row in report["rows"]), "providerInvocations": report["providerInvocations"], "behavioralGate": "unreviewed"}))


if __name__ == "__main__":
    main()
