#!/usr/bin/env python3
"""Project existing benchmark JSON into a public metric archive; never run benchmarks."""
import argparse
import collections
import hashlib
import json
import math
import os
from pathlib import Path
import re

SELECT = re.compile(r"summary|result|report|comparison|analysis|metrics|validation|performance|cohort|trial|outcome|score|acceptance|gate|behavior|measurement|benchmark", re.I)
DENY_FILE = re.compile(r"auth|credential|header|body|payload|transcript|request|response|event", re.I)
SAFE_KEY = re.compile(r"^[A-Za-z][A-Za-z0-9_.-]{0,99}$")
DENY_KEY = re.compile(r"auth|credential|secret|password|cookie|bearer|account|identity|sessionid|threadid|pid$|processid|environment", re.I)
DENY_TREE = {"messages", "message", "prompt", "prompts", "request", "requests", "response", "responses", "headers", "body", "payload", "transcript", "transcripts", "stdout", "stderr", "stdouttext", "stderrtext", "command", "commands", "args", "content", "text", "files", "sources", "diff", "patch", "events", "toolevents", "reportederrors", "artifacts", "configuration", "env", "findings", "notes", "reason", "detail", "details"}
METRIC = re.compile(r"(?:count|counts|total|sum|mean|median|average|avg|min|max|p\d\d|percentile|ratio|percent|pct|score|seconds?|millis|ms|bytes?|mib|kib|rss|memory|tokens?|usd|cost|price|rates?|usage|wall|elapsed|duration|latency|throughput|sample|pass|fail|skip|filter|timeout|error|exitcode|assert|expect|runs?|trials?|attempt|repeat|record|complete|incomplete|unknown|inconclusive|critical|normal|start|finish|expected|observed|scheduled|validated|reviewed|request|tool|calls?|input|output|reasoning|cache|addition|deletion|added|removed|changed|touched|lines|files|violations|peak|gap|threshold|value|version|n$|index$|lower|upper|bound|baseline|candidate|vector|codex|reduction|saved|speed|eligible|budget|accuracy|quality|successful|succeeded|rejected|accepted|denied|negative|positive|true|false|retained|steps|warm|cold)", re.I)
STATUS_FIELDS = {"status", "state", "outcome", "conclusion", "result", "classification", "eligibility", "verdict", "benchmarkStatus"}
STATUS = re.compile(r"^(?:pass(?:ed)?|fail(?:ed|ure)?|success|error|complete(?:d)?|incomplete|running|pending|queued|unknown|unavailable|timeout|timed.out|cancel(?:led|ed)|interrupted|inconclusive|not.run|skipped|blocked|ready|stopped|ran|priced|unpriced|plan|partial|rejected|accepted|invalid|valid|false|true|supported|unsupported|eligible|ineligible|no.go|go)$", re.I)
LABEL_FIELDS = {"runtime", "variant", "model", "modelID", "provider", "providerID", "effort", "reasoning", "category", "phase", "platform", "bun", "codexVersion", "taskId", "taskID", "cohort", "metric", "unit", "label", "name"}
LABEL = re.compile(r"^[A-Za-z][A-Za-z0-9._/+ -]{0,79}$")
SECRET_LITERAL = re.compile(r"sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{20,}|eyJ[A-Za-z0-9_-]{30,}\.")
MACHINE_PATH = re.compile(r"/(?:Users|home)/[^\s\"'`]+|[A-Za-z]:\\Users\\")
PRUNE = {"private", "node_modules", ".git", ".codex", ".vector", "dist", "build", ".cache", "cache", "home", "sessions", "transcripts", "fixture", "fixtures", "workspace", "workspaces", "repo", "repos"}
OMIT = object()


def digest(data):
    return hashlib.sha256(data).hexdigest()


def project(value, key="", depth=0):
    if depth > 24 or DENY_KEY.search(key) or key.lower() in DENY_TREE:
        return OMIT
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value if METRIC.search(key) and math.isfinite(value) else OMIT
    if value is None:
        return None if METRIC.search(key) or key in STATUS_FIELDS else OMIT
    if isinstance(value, str):
        if key in STATUS_FIELDS:
            return value if STATUS.fullmatch(value) else {"labelSha256": digest(value.encode())}
        if key.endswith(("Sha256", "sha256", "Commit", "commit")) or key in {"commit", "base", "head"}:
            return value if re.fullmatch(r"[0-9a-f]{7,64}", value) else OMIT
        if key in LABEL_FIELDS and LABEL.fullmatch(value) and not SECRET_LITERAL.search(value):
            return value
        if key in {"id", "trialId", "runId", "experimentId"}:
            return {"idSha256": digest(value.encode())}
        if key.endswith(("At", "Date")) or key == "date":
            return value if re.fullmatch(r"\d{4}-\d\d-\d\d(?:[T ][0-9:.+Z-]+)?", value) else OMIT
        return OMIT
    if isinstance(value, list):
        rows = []
        for i, item in enumerate(value):
            result = project(item, key, depth + 1)
            if result is not OMIT:
                rows.append({"sourceIndex": i, "value": result})
        return {"sourceLength": len(value), "retained": rows} if rows or not value else OMIT
    if isinstance(value, dict):
        result = {}
        for name, item in value.items():
            if not SAFE_KEY.fullmatch(name):
                continue
            selected = project(item, name, depth + 1)
            if selected is not OMIT:
                result[name] = selected
        return result if result else OMIT
    return OMIT


def inventory(root):
    files, excluded = [], collections.Counter()
    for current, dirs, names in os.walk(root, followlinks=False):
        parent = Path(current)
        keep = []
        for name in dirs:
            path = parent / name
            if path.is_symlink() or name in PRUNE or (path / ".git").exists() or ((path / "package.json").exists() and (path / "packages").is_dir()) or re.search(r"(?:^|[-_])(home|cache|state|transcripts|sessions|auth)(?:[-_]|$)", name):
                excluded["private_runtime_cache_or_checkout_directories"] += 1
            else:
                keep.append(name)
        dirs[:] = keep
        for name in names:
            path = parent / name
            if path.is_symlink():
                continue
            if name.endswith(".json") and SELECT.search(name) and not DENY_FILE.search(name):
                files.append(path)
    return sorted(files), excluded


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("destination", type=Path)
    args = parser.parse_args()
    args.destination.mkdir(parents=True, exist_ok=True)
    files, exclusions = inventory(args.source)
    groups, records, omitted = collections.defaultdict(list), [], []
    for path in files:
        relative = path.relative_to(args.source).as_posix()
        data = path.read_bytes()
        identity = {"source": relative, "sourceSha256": digest(data), "sourceBytes": len(data)}
        try:
            value = project(json.loads(data))
        except (ValueError, UnicodeError):
            omitted.append({**identity, "reason": "invalid_or_non_utf8_json"})
            continue
        if value is OMIT:
            omitted.append({**identity, "reason": "no_allowlisted_metrics"})
            continue
        group = relative.split("/")[0] if "/" in relative else "original"
        groups[group].append({**identity, "metrics": value})
        records.append(identity)
    exports = []
    for group, values in sorted(groups.items()):
        name = group + ".metrics.json"
        data = (json.dumps({"schemaVersion": 1, "records": values}, separators=(",", ":"), allow_nan=False) + "\n").encode()
        (args.destination / name).write_bytes(data)
        exports.append({"file": name, "sha256": digest(data), "bytes": len(data), "sourceRecords": len(values)})
    manifest = {"schemaVersion": 1, "sourceArchive": args.source.name, "exportKind": "allowlisted_metric_projection", "candidateJsonFiles": len(files), "exportedSourceRecords": len(records), "omittedSourceRecords": omitted, "excludedDirectoryCounts": dict(exclusions), "exports": exports, "semantics": ["No trials are selected by performance or success; failed, incomplete and inconclusive values use the same projection.", "Each array retains original row indexes and original length. A missing field was omitted by the projection; it does not mean zero, success or absence.", "Different files may repeat the same trials. Do not sum counts across source records.", "Opaque status and trial identifiers are hashed; free-text explanations and raw runtime data are omitted.", "Hashes bind the exact original bytes available at export time. They do not establish that a run is valid or independent.", "No source files are modified and no benchmark or provider request is executed by this exporter."]}
    (args.destination / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(json.dumps({"candidateJsonFiles": len(files), "exportedSourceRecords": len(records), "omittedSourceRecords": len(omitted), "metricBytes": sum(x["bytes"] for x in exports), "exports": exports}, indent=2))


if __name__ == "__main__":
    main()
