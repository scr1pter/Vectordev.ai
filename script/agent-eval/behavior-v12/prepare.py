"""Prepare a derived E12 study without reading credentials or executing provider work."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import sys

HERE = Path(__file__).resolve().parent
GIT_ENV = {**os.environ, "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_CONFIG_SYSTEM": "/dev/null",
    "GIT_ATTR_NOSYSTEM": "1", "GIT_TERMINAL_PROMPT": "0", "GIT_OPTIONAL_LOCKS": "0"}
PINNED = {
    "scenarios.json": "931bc371f73acca8e9fd6013abe6b1531d9021608b58622793acacb6d66137cb",
    "rubric-v4.json": "0d19d40cb9e2ccdb45caed3f2fd9f4f7239dd3395d9cffd74a43a52b53b78e5a",
    "completion.json": "7e10211f8835a657ae4d79c101d068311f72d217007c08357fa124638be51159",
}
COPIED = [
    *PINNED, "prepare-fixtures.py", "rehearse.py", "actor.template.ts", "actor-launch.py",
    "actor-control.ts", "policy.ts", "source-admission.ts", "shell-state.ts", "shell-receipts.ts",
    "decision-response.ts", "output-ledger.ts", "usage-projection.ts", "representation-normalizer.ts",
    "source-consumption.ts", "episode-stop.ts", "main-gate.ts", "seed-contracts.json",
    "blind-episodes.py", "output_ledger.py", "root-prospective-gate.json", "root-positive-sample-v11.json", "collector-lock.json",
]


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def write(path, value):
    Path(path).write_text(json.dumps(value, indent=2) + "\n")


def replace(text, old, new):
    if text.count(old) != 1:
        raise ValueError("ARCHIVED_SOURCE_SHAPE_CHANGED: " + old[:80])
    return text.replace(old, new)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", required=True, type=Path)
    parser.add_argument("--source", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args()
    archive, source, out = args.archive.resolve(), args.source.resolve(), args.out.absolute()
    if out.exists() or out.resolve() != out or sys.platform != "darwin":
        parser.error("Use a fresh canonical output directory on macOS (the original shell confinement requires Seatbelt)")
    if any(digest(archive / name) != expected for name, expected in PINNED.items()):
        raise ValueError("ORIGINAL_GATE_CHANGED")
    status = subprocess.check_output(["git", "status", "--porcelain", "--untracked-files=normal", "--", "packages", "bun.lock", "package.json", "tsconfig.json"], cwd=source, text=True)
    if status:
        raise ValueError("CANDIDATE_MUST_BE_A_CLEAN_COMMIT")
    revision = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=source, text=True).strip()
    baseline = archive.parents[2] / "vector-candidate-v4"
    if not (baseline / "packages/engine/src/plugin/openai/codex.ts").is_file():
        raise ValueError("ORIGINAL_BASELINE_MISSING")
    out.mkdir(parents=True, mode=0o700)
    original = out / "original"
    original.mkdir()
    names = COPIED + [str(path.relative_to(archive)) for path in sorted((archive / "shell").glob("*.py"))]
    provenance = {}
    for name in names:
        provenance[name] = digest(archive / name)
        for target in [out, original]:
            (target / name).parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(archive / name, target / name)
    for name in ["plugin.template.ts", "audit.ts", "capture.ts", "run.py", "review.py"]:
        shutil.copyfile(HERE / name, out / name)
    shutil.copyfile(HERE / "capture-proof.ts", out / "capture.test.ts")
    broker = (archive / "broker.ts").read_text()
    (out / "scripted.ts").write_text("export function scripted(" + broker.split("\nfunction scripted(", 1)[1])
    # The seed tools still execute natively. Only the known source-specific error contract gains a new path binding.
    contracts = json.loads((out / "seed-contracts.json").read_text())
    contracts["sources"][source.name] = contracts["sources"]["vector-candidate-v11"]
    write(out / "seed-contracts.json", contracts)
    actor = (out / "actor.template.ts").read_text()
    actor = replace(actor,
        '      yield* Effect.promise(() => fetch(process.env.EPISODE_CONTROL!, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: fixture.id, sessionID: session.id, model: model.id, turnCap: fixture.turnCap }) }).then(r => { if (!r.ok) throw new Error("CONTROL_FAILED") }))',
        '      yield* Effect.promise(() => Bun.write(join(process.env.EPISODE_OUTPUT!, "control.json"), JSON.stringify({ id: fixture.id, sessionID: session.id, model: model.id, turnCap: fixture.turnCap })))')
    (out / "actor.template.ts").write_text(actor)
    launcher = (out / "actor-launch.py").read_text()
    launcher = replace(launcher, " if source not in [ROUND/'vector-candidate-v4',ROUND/'vector-candidate-v11']:raise ValueError('SOURCE_NOT_ALLOWED')",
        " study=json.loads((ROOT/'study.json').read_text())\n if str(source) not in study['sources']:raise ValueError('SOURCE_NOT_ALLOWED')\n mode=os.environ['E12_MODE']\n live=mode.startswith('live-')")
    start = launcher.index(" plugin=output/'plugin.ts'")
    end = launcher.index("\n write(output/'cases.json'", start)
    launcher = launcher[:start] + " plugin=output/'plugin.ts';plugin.write_text((ROOT/'plugin.template.ts').read_text().replace('__SOURCE__',str(source)).replace('__HARNESS__',str(ROOT)).replace('__CONTROL__',str(runtime/'actor-control')))" + launcher[end:]
    launcher = replace(launcher, " contract=json.loads((ROOT/'seed-contracts.json').read_text())",
        " if live: config['provider']['openai']['options'].pop('baseURL')\n contract=json.loads((ROOT/'seed-contracts.json').read_text())")
    marker = " for key in ['HOME','XDG_DATA_HOME','XDG_CONFIG_HOME','XDG_CACHE_HOME','XDG_STATE_HOME']:pathlib.Path(env[key]).mkdir(parents=True,exist_ok=True)"
    launcher = replace(launcher, marker,
        " env.update(E12_MODE=mode,E12_STUDY=str(ROOT),E12_ROW=case['id'])\n if live:\n  env.pop('VECTOR_AUTH_CONTENT')\n  env['XDG_DATA_HOME']=os.environ['E12_SIGNIN_DATA']\n" + marker)
    # Only the actor runtime may use the owner's explicitly selected normal sign-in directory.
    # Model-requested shell commands retain the unchanged, deny-by-default shell sandbox.
    launcher = replace(launcher, " sandbox+=''.join('(deny file-write* (subpath '+json.dumps(str(path))+'))' for path in [output/'shell-audit',output/'shell-journal.jsonl',output/'shell-fault.json',shellbin,output/'shell-seed-bin'])",
        " if live: sandbox='(version 1)(allow default)'\n" + " sandbox+=''.join('(deny file-write* (subpath '+json.dumps(str(path))+'))' for path in [output/'shell-audit',output/'shell-journal.jsonl',output/'shell-fault.json',shellbin,output/'shell-seed-bin'])")
    launcher = replace(launcher, " command=['/usr/bin/sandbox-exec'",
        " if (source/'packages/core/src/workspace-trust/workspace-trust.ts').exists():\n  worker.write_text('import { WorkspaceTrust } from '+json.dumps(str(source/'packages/core/src/workspace-trust/workspace-trust'))+'\\nimport { Global } from '+json.dumps(str(source/'packages/core/src/global'))+'\\nawait WorkspaceTrust.approve(Global.Path.state, await WorkspaceTrust.snapshot('+json.dumps(case['directory'])+', ['+json.dumps(str(files/'vector.json'))+']))\\n'+worker.read_text())\n command=['/usr/bin/sandbox-exec'")
    launcher = replace(launcher, "shutil.which('bun'),'run'", "shutil.which('bun'),'--no-env-file','run'")
    launcher = replace(launcher, "'credentials':'No real credentials supplied; isolated HOME/config/auth; known real benchmark/OAuth auth locations denied to actor'",
        "'credentials':'Runtime normal sign-in owns credential access; harness reads no credential store' if live else 'Synthetic isolated auth only; upstream denied'")
    (out / "actor-launch.py").write_text(launcher)
    specification = importlib.util.spec_from_file_location("materialize", out / "prepare-fixtures.py")
    fixtures = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(fixtures)
    # Keep the exact original paired schedule and reviewer sample; source assignment is kept separately for blinding.
    archived_schedule = json.loads((archive / "schedule.json").read_text())
    arms = json.loads((archive / "arm-map.json").read_text())
    codes = {code: "arm-" + secrets.token_hex(8) for code in arms}
    schedule = []
    for row in archived_schedule:
        case = fixtures.materialize(row["scenario"], out / "fixtures" / row["id"])
        case.update(id=row["id"], scenario=row["scenario"], model=row["model"], turnCap=3)
        for command in [["init", "--quiet"], ["add", "."], ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "E12 fixture"]]:
            subprocess.run(["git", *command], cwd=case["directory"], env=GIT_ENV, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        marker = Path(case["directory"]) / ".git/vector"
        marker.mkdir()
        (marker / "project-id").write_text(subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=case["directory"], env=GIT_ENV, text=True).strip())
        (out / "cases").mkdir(exist_ok=True)
        write(out / "cases" / (row["id"] + ".json"), case)
        schedule.append({**row, "armCode": codes[row["armCode"]], "source": str(source if arms[row["armCode"]]["treatment"] == "candidate" else baseline)})
    write(out / "schedule.json", schedule)
    write(out / "fixture-inventory.json", {str(path.relative_to(out)): "directory" if path.is_dir() else "file" for path in (out / "fixtures").rglob("*")})
    candidate_files = subprocess.check_output(["git", "ls-files", "-z"], cwd=source).decode().split("\0")
    candidate_files = [name for name in candidate_files if name and (name.startswith("packages/") or name in ["bun.lock", "package.json", "tsconfig.json"]) and not any(part.startswith(".env") for part in Path(name).parts) and (source / name).is_file()]
    baseline_manifest = json.loads((archive.parents[2] / "source-manifest-v4.json").read_text())["files"]
    source_directories = {name.split("/src/", 1)[0] + "/src" for name in baseline_manifest if name.startswith("packages/") and "/src/" in name}
    write(out / "baseline-source-inventory.json", {str(path.relative_to(baseline)): "symlink" if path.is_symlink() else "directory" if path.is_dir() else "file" for name in source_directories for path in (baseline / name).rglob("*")})
    dependencies = {}
    for name, expected in json.loads((archive / "collector-lock.json").read_text())["sources"].items():
        if "/node_modules/" not in name:
            continue
        if str(baseline) + "/" in name:
            dependencies[name] = expected
        if "/vector-candidate-v11/" in name:
            rebound = source / name.split("/vector-candidate-v11/", 1)[1]
            if not rebound.is_file():
                raise ValueError("CANDIDATE_DEPENDENCY_MISSING: " + str(rebound))
            dependencies[str(rebound)] = digest(rebound)
    runtime = Path(shutil.which("bun")).resolve()
    source_lock = {**{str(source / name): digest(source / name) for name in candidate_files}, **{str(baseline / name): value for name, value in baseline_manifest.items()}, **dependencies, str(runtime): digest(runtime)}
    write(out / "source-lock.json", source_lock)
    write(out / "source-path-lock.json", {name: {"resolved": str(Path(name).resolve()), "link": str(Path(name).readlink()) if Path(name).is_symlink() else None} for name in source_lock})
    write(out / "study.json", {"original": str(archive), "originalHashes": provenance, "candidate": str(source), "candidateRevision": revision,
        "baseline": str(baseline), "sources": [str(source), str(baseline)], "bun": subprocess.check_output(["bun", "--version"], text=True).strip(), "bunExecutable": str(runtime),
        "candidateGate": 18, "episodes": 36, "turnCap": 3, "firstBlockSendCap": 18, "secondBlockSendCap": 90,
        "historicalCandidatePasses": 15, "historicalBaselinePasses": 14, "actualBilledCost": None,
        "qualification": "Derived actor-entrypoint checkpoint study. Original scenario/rubric bytes unchanged; normal source-runtime HTTP authentication replaces the direct archived WebSocket collector. This is not a timing comparison. Offline results cannot pass the behavioral gate."})
    write(out / "harness-lock.json", {str(path.relative_to(out)): digest(path) for path in out.rglob("*") if path.is_file() and "__pycache__" not in path.parts})
    print(json.dumps({"prepared": str(out), "candidateRevision": revision, "episodes": 36, "providerCalls": 0}))


if __name__ == "__main__":
    main()
