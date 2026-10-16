"""Medians of the 16 October warm-solo addendum; no network or model calls. Refuses failed or incomplete cells."""

import json
from pathlib import Path
from statistics import median

root = Path(__file__).resolve().parent
cells = {}
for path in sorted(root.glob("*-[123].json")):
    state = path.stem.rsplit("-", 1)[0]
    for trial in json.loads(path.read_text())["scenarios"]:
        if trial["exitCode"] != 0 or trial["unplayed"] != 0 or trial.get("verification", {}).get("exitCode", 1) != 0:
            raise ValueError(f"Failed or incomplete trial: {path.name}, {trial['runtime']}, session {trial['session']}")
        first = next(i for i, request in enumerate(trial["requests"]) if request["who"] == "agent")
        cells.setdefault((trial["runtime"], trial["session"], state), []).append(
            {
                "peakRssMiB": trial["performance"]["sampledPeakProcessTreeRssKiB"] / 1024,
                "firstPrimarySeconds": trial["performance"]["requestTimesMs"][first] / 1000,
                "wallSeconds": trial["performance"]["wallMs"] / 1000,
                "requests": trial["totals"]["requests"],
            }
        )
for (runtime, session, state), trials in sorted(cells.items()):
    if len(trials) != 3:
        raise ValueError(f"Expected three repetitions: {runtime}, session {session}, {state}")
    peaks = [trial["peakRssMiB"] for trial in trials]
    print(
        json.dumps(
            {
                "runtime": runtime,
                "session": session,
                "state": state,
                "peakRssMiB": round(median(peaks)),
                "peakRssRangeMiB": [round(min(peaks)), round(max(peaks))],
                "firstPrimarySeconds": round(median(trial["firstPrimarySeconds"] for trial in trials), 2),
                "wallSeconds": round(median(trial["wallSeconds"] for trial in trials), 2),
                "requests": median(trial["requests"] for trial in trials),
            }
        )
    )
