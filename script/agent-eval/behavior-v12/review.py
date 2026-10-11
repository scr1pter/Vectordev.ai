"""Use the unchanged E12 blinder to prepare complete-episode review evidence; never award a pass."""
import argparse
import importlib.util
import json
from pathlib import Path
from run import ROOT, check, digest, read

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--reports", nargs="+", required=True, type=Path)
parser.add_argument("--out", required=True, type=Path)
args = parser.parse_args()
check()
reports = [read(path) for path in args.reports]
if len({report["synthetic"] for report in reports}) != 1:
    raise ValueError("MIXED_SYNTHETIC_AND_LIVE_EVIDENCE")
for path, report in zip(args.reports, reports):
    mode = report["mode"]
    if mode not in ["preflight", "rehearse", "live-first", "live-second"] or report["synthetic"] != (not mode.startswith("live-")):
        raise ValueError("REPORT_MODE_OR_ORIGIN_INVALID")
    if path.resolve() != ROOT / "runs" / mode / "report.json" or report["candidateRevision"] != read(ROOT / "study.json")["candidateRevision"]:
        raise ValueError("REPORT_STUDY_MISMATCH")
    if report["harnessLockSha256"] != digest(ROOT / "harness-lock.json") or report["sourceLockSha256"] != digest(ROOT / "source-lock.json"):
        raise ValueError("REPORT_BINDINGS_CHANGED")
specification = importlib.util.spec_from_file_location("blind", ROOT / "blind-episodes.py")
blind = importlib.util.module_from_spec(specification)
specification.loader.exec_module(blind)
bundle = blind.build_bundle(args.reports, ROOT)
bundle["derivedBindings"] = {name: digest(ROOT / name) for name in ["harness-lock.json", "source-lock.json", "study.json"]}
bundle["synthetic"] = reports[0]["synthetic"]
with args.out.open("x") as target:
    json.dump(bundle, target, indent=2)
    target.write("\n")
print(json.dumps({"episodes": len(bundle["episodes"]), "blinded": True, "synthetic": bundle["synthetic"], "behavioralPass": None}))
