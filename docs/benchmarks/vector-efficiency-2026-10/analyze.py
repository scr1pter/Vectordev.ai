"""Recompute per-cell medians from the offline raw reports; no network or model calls."""

import json
import sys
from pathlib import Path
from statistics import median


def phase_rss(trials, phase):
    observations = [[sample["rssKiB"] for sample in trial["performance"]["samples"] if sample["phase"] == phase and sample["rssKiB"] > 0] for trial in trials]
    peaks = [max(samples) / 1024 for samples in observations if samples]
    return {
        "medianMiB": median(peaks) if peaks else None,
        "observedTrials": len(peaks),
        "sampleCount": sum(len(samples) for samples in observations),
    }


# With no arguments this rebuilds the canonical archive. A follow-up study passes its own directory (holding raw/) and
# its two state names; without a payload-sizes.json there, each request's size is the report's own UTF-8 measurement.
root = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else Path(__file__).resolve().parent
states = (sys.argv[2], sys.argv[3]) if len(sys.argv) > 3 else ("baseline", "integrated")
sizes = root / "payload-sizes.json"
payloads = json.loads(sizes.read_text())["reports"] if sizes.exists() else None
rows = []
for transport in ("http", "ws"):
    expected = {
        (runtime, scenario, session)
        for runtime in (("vector", "vector-openai", "claude-code", "codex") if transport == "http" else ("vector-openai", "codex"))
        for scenario in (("solo-fix", "delegate-explore", "delegate-general", "long-loop") if transport == "http" else ("long-loop",))
        for session in (1, 2)
    }
    for state in states:
        reports = [(path.name, json.loads(path.read_text())) for path in sorted((root / "raw").glob(f"{state}-{transport}-[123].json"))]
        if len(reports) != 3:
            raise ValueError(f"Expected three reports: {state}, {transport}")
        cells = {}
        for name, report in reports:
            if len(report["scenarios"]) != len(expected) or {(trial["runtime"], trial["scenario"], trial["session"]) for trial in report["scenarios"]} != expected:
                raise ValueError(f"Missing, repeated, or unexpected cells: {state}, {transport}")
            for trial in report["scenarios"]:
                key = (trial["runtime"], trial["scenario"], trial["session"])
                measured = (
                    payloads[name]["-".join(str(part) for part in key)]
                    if payloads
                    else [request["sentBytes"] for request in trial["requests"]]
                )
                if len(measured) != len(trial["requests"]):
                    raise ValueError(f"Payload size count mismatch: {name}, {key}")
                cells.setdefault(key, []).append({**trial, "payloadBytes": sum(measured), "payloadEncoding": report.get("payloadEncoding", "utf16-code-units")})
        for (runtime, scenario, session), trials in cells.items():
            if len(trials) != 3:
                raise ValueError(f"Expected three repetitions: {state}, {transport}, {runtime}, {scenario}, {session}")
            if any(trial["exitCode"] != 0 or trial["unplayed"] != 0 or trial.get("verification", {}).get("exitCode", 0) != 0 for trial in trials):
                raise ValueError("Failed or incomplete trials must not enter the comparison")
            if len({trial["payloadEncoding"] for trial in trials}) != 1:
                raise ValueError("Mixed payload encodings within one median cell")
            first = [next(i for i, request in enumerate(trial["requests"]) if request["who"] == "agent") for trial in trials]
            rows.append({
                "state": state,
                "transport": transport,
                "runtime": runtime,
                "scenario": scenario,
                "session": session,
                "repetitions": len(trials),
                **{key: median(trial["totals"][key] for trial in trials) for key in (
                    "requests", "subagentRequests", "sideRequests", "warmupRequests", "inputTokens",
                    "cacheRead", "cacheWrite", "uncached", "outputTokens", "costUsd",
                )},
                "sentBytes": median(trial["payloadBytes"] for trial in trials),
                "rawSentUnits": median(trial["totals"]["sentBytes"] for trial in trials),
                "rawSentUnitsEncoding": trials[0]["payloadEncoding"],
                "wallMs": median(trial["performance"]["wallMs"] for trial in trials),
                "firstPrimaryRequestMs": median(trial["performance"]["requestTimesMs"][index] for trial, index in zip(trials, first)),
                "firstPrimaryCacheRead": median(trial["requests"][index]["cacheRead"] for trial, index in zip(trials, first)),
                "firstPrimaryInputTokens": median(trial["requests"][index]["inputTokens"] for trial, index in zip(trials, first)),
                "postTerminalMs": median(trial["performance"]["postTerminalMs"] for trial in trials),
                "peakRssMiB": median(trial["performance"]["sampledPeakProcessTreeRssKiB"] / 1024 for trial in trials),
                "phasePeakRss": {
                    phase: phase_rss(trials, phase)
                    for phase in ("startup", "active", "tail")
                },
                "finalFixtureChecks": sum("verification" in trial for trial in trials),
            })

(root / "summary.json").write_text(json.dumps({
    "kind": "offline-scripted-replay",
    "decisiveLiveClaimPermitted": False,
    "cells": rows,
}, indent=2) + "\n")
print(f"Wrote {len(rows)} median cells to summary.json")
