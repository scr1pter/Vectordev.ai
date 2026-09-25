# Dependency license sources

`script/dependency-notices.ts` regenerates `DEPENDENCY_NOTICES.md` from the installed runtime packages and `platform-notices.json`. Normal generation uses no network. The platform inventory covers every locked optional native package in the runtime dependency graph, including its transitive dependencies, so different build operating systems produce the same notices.

Each platform record identifies its exact package name, version, npm tarball source, lockfile SHA512 integrity, declared license and full license text. Missing, changed or unused records fail generation. The `.txt` files supply exact upstream notices when a package omits a license file; each records its source. Unused overrides and changed platform override text also fail generation.

After reviewing a lockfile change, run `bun script/dependency-notices.ts --update-platform-notices` from the repository root. This reads installed exact-version packages where available. For unavailable platform packages, it downloads the recorded npm tarball, verifies its SHA512 against `bun.lock`, and extracts only its package manifest and top-level license documents; it never installs or executes the package. Review both the inventory and generated notices before committing. If upstream omits legal text, add a sourced, exact-version override and run the command again.
