# LGPL distribution evidence

The standalone Vector CLI compiles a Bun runtime into its executable. Bun
v1.3.14 statically links JavaScriptCore/WebKit and TinyCC; their LGPL terms
require more than license notices. The current desktop build runs the engine's
Node bundle inside Electron's utility process. Use of Bun as a build tool does
not, by itself, mean that the desktop embeds Bun or JavaScriptCore. Inspect each
actual shipped artifact and native dependency before deciding which obligations
apply.

## Native custom-runtime build support

Both `packages/engine/script/build.ts` and the separate experimental
`packages/cli/script/build.ts` accept `VECTOR_BUN_EXECUTABLE_PATH` with `--single`.
This passes Bun's supported `compile.executablePath` option to the compiler. The
selected regular executable is probed for the repository's pinned Bun version,
native operating system, architecture, and Linux libc ABI. The build compiler
must also match the version pin. A custom runtime cannot be used for the whole
target matrix, `--baseline`, a musl target, or a non-native target through this
option. Existing builds without the variable retain their target behavior.

From `packages/engine`, with installed dependencies, the reviewed
`VECTOR_RELEASE_CATALOG_PATH` and `VECTOR_RELEASE_CATALOG_SHA256` build inputs
described in [model-catalog.md](model-catalog.md), and a trusted locally rebuilt
compatible Bun runtime:

```sh
VECTOR_BUN_EXECUTABLE_PATH=/absolute/path/to/rebuilt/bun bun script/build.ts --single --skip-install
```

Rebuild Bun from its pinned `bun-v1.3.14` source using its own prerequisites and
local-library build instructions (`bun run build:release:local` in the pinned
Bun source). The WebKit pin and license evidence are
recorded in `licenses/bun/manifest.json` and `licenses/bun/provenance/webkit.ts`.
Use a local WebKit build containing the desired modifications, rather than the
prebuilt library path. The variable points to a runtime the operator trusts to
execute; it is not a source-integrity or provider-authorization certificate.

The focused test compiles and runs a small application using the selected
executable. It establishes that the runtime override works; it does not establish
that a modified LGPL library has been built or that production distributions
provide a complete relinking kit.

## Evidence required before declaring a release compliant

For every distributed standalone executable, container, and other artifact that
actually includes an LGPL component, the owner must retain and provide:

- Exact corresponding source for the LGPL libraries, including modifications,
  interface files, and scripts controlling compilation and installation. Preserve
  the Bun and library revisions used for the release and verify source archives.
- The complete machine-readable application form needed to reproduce the
  executable with a modified library: appropriate object files or source, all
  necessary data, utility programs, and instructions. Bun's own source and an
  application binary plus notices do not automatically supply Vector's missing
  application form. A proprietary application can use a permitted object form;
  it need not grant a general source redistribution license.
- An actual tested route to build the modified libraries, relink the compatible
  Bun runtime, and combine the Vector application form with that runtime. Verify
  more than `--version`: include a meaningful CLI session or equivalent runtime
  smoke check on each supported platform and ABI.
- Distribution terms permitting customer modifications for their own use and
  reverse engineering to debug those modifications, as required by the applicable
  LGPL terms. General update/security restrictions must preserve these rights.
- A distribution method meeting the applicable license section: accompanying
  materials, equivalent access from the release download location, or a written
  offer whose required scope and duration the owner can actually fulfil. Do not
  insert an unsupported promise of source availability or substitute moving
  upstream URLs for retained release evidence.

The current standalone archive format contains the executable and three notice
files. This change does not add corresponding-source or Vector object archives,
publish source materials, or verify historical releases. Those deliverables and
the source/object licensing boundary require owner review before claiming the
remaining distribution obligations are satisfied. Inspect already published
artifacts separately and provide any missing materials to their recipients.
