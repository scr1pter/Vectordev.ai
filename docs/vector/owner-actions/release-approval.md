# Release approval and external prerequisites

Status checked October 2, 2026. The owner selected **1.999.99** for desktop and CLI,
approved unsigned builds, and requested publication across supported operating
systems plus replacement of the local Mac app after verification. Version 2 is
reserved. The latest instruction holds further pushes to `main`; prepare and
commit release work on the candidate branch until that restriction is lifted.
The publication request does not authorize purchases or changes to billing.

## Source parity

At the comparison checkpoint, `free-only-safety` and fetched `origin/main` both
resolve to `12c3ffd78fdd03219310f88573a188d3b2a32b77`. The complete `free-models`,
`independence-rebuild`, and `release-ready` histories are ancestors of that commit.
No runtime or test files were lost in the comparison; removed website pages were
consolidated into the current feature documentation. Recheck the final release
commit after any further changes. The separate shared working checkout contains
other work and is not the release workspace.

## Remaining release inputs

- Supply the owner-controlled public catalog fork, its committed `vector/api.json`
  export, and an exact reviewed commit. Follow [model catalog preparation](model-catalog.md).
  Old caches generated from the original live service do not establish fork
  provenance and cannot substitute for this input.
- Authenticate npm on the publishing machine. `npm whoami` returned `E401` at this
  checkpoint. Run `npm login` yourself; never paste a token or password into source,
  a task, or logs.
- Provide publication credentials through the existing protected release
  environment. Do not copy credential stores or print secret values. A local
  unsigned Mac build does not require npm authentication, but still needs the
  reviewed catalog and must pass the same artifact audit.
- Verify the exact release source in CI before publication. Local passing suites
  do not replace the macOS, Windows, and Linux release jobs.

The catalog and npm inputs remain incomplete. No 1.999.99 installers, npm packages,
or standalone archives are claimed as published. Public desktop downloads remain
at 1.99.8 and npm CLI at 1.99.7. The Mac's separately installed 1.99.91 app is an
older local build and must not be relabelled as this candidate.

## GitHub Actions is executing

The repository is public at this checkpoint. The previous account-level Actions
block is no longer the observed state: source `12c3ffd78` passed
[Verify](https://github.com/scr1pter/Vectordev.ai/actions/runs/37042607157),
[typecheck](https://github.com/scr1pter/Vectordev.ai/actions/runs/37042607079), and
[production schema checks](https://github.com/scr1pter/Vectordev.ai/actions/runs/37042860451).
The [test workflow](https://github.com/scr1pter/Vectordev.ai/actions/runs/37042607500)
failed in Linux installer fixtures that omitted `gzip` from their restricted PATH
and a Windows app assertion that waited a fixed 10 ms. Both test-only repairs
passed focused local checks; native CI confirmation on the new branch is still
required. No payment, spending-limit change, or credit purchase is required or
authorized by this preparation.

## Publication order and unsigned policy

1. Prepare the immutable catalog and record its digest and fork provenance. Build
   and audit all artifacts from the reviewed source and these same catalog bytes.
2. Publish the matching plugin, CLI, and all six npm platform packages, then the
   standalone CLI archives required by desktop and WSL. See the
   [plugin](npm-plugin.md) and [standalone CLI](standalone-cli-release.md) procedures.
3. Dispatch the desktop workflow from the exact candidate ref with tag
   `v1.999.99`, `allow_unsigned=true`, and the stable channel. A plain tag push uses
   the signed path and does not select the approved unsigned policy.
4. Verify all six installers, checksums, sizes, CLI provenance, and the public
   download manifest before advancing `publishedDesktopVersion` or describing the
   release as available. Update the public notes and the more detailed system
   design notes to match the actual published result.
5. Keep a recoverable copy of the existing local Mac app, install the verified
   candidate, and launch it. The owner handles any operating-system password or
   keychain prompt; the agent must not enter those credentials.

Unsigned releases update manual downloads, not the signed automatic-update feed.
Preserve the existing signed feed and the workflow's complete-platform gate. Do
not advertise a partial upload as the latest release.

## Free-model scope

Personal access uses each user's own free OpenRouter account. Keep the shared
service off; do not buy credits, enable automatic top-ups, attach paid upstream
BYOK keys, or enable default or enforced paid plugins. The guarded route stops
when eligible zero-price endpoints or the account allowance are unavailable.
See [free-model setup](openrouter.md) for account requirements and the owner-run
acceptance checks. No live account billing acceptance is claimed from fixture or
local mock tests. Other hosted services and disabled OAuth registrations remain
subject to their existing owner setup requirements.
