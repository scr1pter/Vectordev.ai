# Desktop 1.99.110: owner steps

Desktop 1.99.110 is the self-evolving AI agentic harness: Vector Brain. It builds from one main commit, like every release. The npm CLI stays at 1.99.99 (`vectorRequiredCliVersion`), so `vector memory`, `vector memory doc` and `vector memory model`, the linked requirements `vector review` gets, and the `vector run` fixes for piped text arrive only with a new CLI release. Windows WSL servers keep the 1.99.99 engine, which has no brain, until a later desktop release requires that CLI.

## Before you release the desktop

1. **The website deploys with the push to main.** Desktop 1.99.110 shows its What's new from `https://vectordev.ai/changelog.json`, and the Brain, Documents and code links, and Search by meaning docs pages ship with the same commit. Wait for the Vercel deploy of the release commit, then check that `https://vectordev.ai/changelog.json` lists `v1.99.110` first. The site keeps saying the brain is coming in desktop 1.99.110 until step 7.
2. **Upload the search model's three files to the public Blob store.** Search by meaning downloads them only when someone asks, from Vector's copy first and then from Hugging Face at the pinned revision (`packages/core/src/brain/embed-manifest.ts`). Until you upload, every download goes on to Hugging Face, so the release does not wait on this, but do it before the release is announced. The folder is `releases/knowledge-pack-1/` in the store whose public host is `42qryducihx01gl0.public.blob.vercel-storage.com` (the one with the `releases/vector-v<version>/` installer folders). Take the files from `https://huggingface.co/Snowflake/snowflake-arctic-embed-xs/resolve/d8c86521100d3556476a063fc2342036d45c106f/<Hugging Face file>`; names are case-sensitive and must not get a random suffix:

   | Pathname in the store | Hugging Face file | Bytes | sha256 |
   | --- | --- | ---: | --- |
   | `releases/knowledge-pack-1/arctic-embed-xs-q8-model_quantized.onnx` | `onnx/model_quantized.onnx` | 22,972,992 | `e6aa5e656466a73d7c3111e9a3378bd13e5b93af30eaac2b3f13fd56692589a1` |
   | `releases/knowledge-pack-1/arctic-embed-xs-q8-tokenizer.json` | `tokenizer.json` | 711,649 | `91f1def9b9391fdabe028cd3f3fcc4efd34e5d1f08c3bf2de513ebb5911a1854` |
   | `releases/knowledge-pack-1/arctic-embed-xs-q8-tokenizer_config.json` | `tokenizer_config.json` | 1,433 | `9ca59277519f6e3692c8685e26b94d4afca2d5438deff66483db495e48735810` |

   Check each file's size and `shasum -a 256` before uploading, upload with the Vercel dashboard (Storage, the Blob store, `releases/`, new folder `knowledge-pack-1`), and leave everything else under `releases/` alone. Then download each public URL anonymously and compare its sha256 with the table; a range request (`curl -r 0-99`) for the model file should answer `206`, because Vector resumes a cut download that way. Never put a store token in a file or a chat.
3. **Legal review.** The privacy policy (section 3) still describes one local memory file. 1.99.110 also keeps `brain.db` on the computer (what Vector learned, documents read into records, code links and search vectors), copies of added files when **Keep copies of added files** is on, and sends recalled memory and document cards with requests to the chosen model. The optional search model download reaches Vector's Blob store and then Hugging Face, which receive the download request, as the dictation model's host does. Review the policy before the release is announced; legal text changes only with your sign-off.
4. **Start the release** with Prompt C, or by hand: Actions, Vector desktop release, Run workflow from `main`, tag `v1.99.110`, prerelease unchecked, allow unsigned checked (1.99.110 is in `packages/desktop/release-policy.json`), then approve `production-release` for that run only.

## After the release

5. **Check the four update feeds** (`latest.yml`, `latest-mac.yml`, `latest-linux.yml`, `latest-linux-arm64.yml` under `releases/vector-updates/` in the Blob store) all say `version: 1.99.110`.
6. **Try it.** In a signed-in 1.99.110 with a free model: in a repository, open Settings → Memory and add a preference; tell the agent a preference in a session and see the Learned line, then Undo it there and see it leave Recently learned; add a PDF in Documents and ask a question it answers, and check the citation chip; change a number in a linked spec so it disagrees with the code and see Needs a look; say "hi" and see that the turn uses no memory. Download the search model from Settings → Memory → Search model and check it reports the 24 MB model as checked on this computer.
7. **Mark 1.99.110 published** (a repository change; ask Claude). Set `publishedDesktopVersion` to `1.99.110` in `packages/web/src/data/vector-releases.ts`. `packages/web/test/brain-docs.test.ts` then requires the README to say "From desktop 1.99.110" and its section heading to match, `packages/web/src/pages/docs/local-memory.astro` and its sidebar entry to go, `docsMoved["local-memory"]` to be `"brain"`, a `/docs/local-memory` to `/docs/brain` redirect in `vercel.json`, and the brain page to stop linking to Local memory. Move `shipped` in `packages/web/test/release-copy.test.ts` and `lastShipped` in `test/no-project-wording.test.ts` on, and add the 1.99.109 and 1.99.110 entries to the docs changelog in `packages/web/src/data/docs-content.ts` (1.99.109 was never added there).
8. **CLI.** `vector memory` and the rest of the terminal side come only with a new CLI release (npm needs your 2FA). Publishing it is a separate decision; Windows WSL servers get the brain once a later desktop release requires that CLI.

## Not in this release

- **Find more with a model** on a document's page is off unless Vector starts with `VECTOR_KNOWLEDGE_DISTILL=1`, so it is not announced.
- **The full-precision search model** is offered only when the int8 one fails its check on a computer and is labelled not yet verified: its file has never been downloaded and checked, and it is checked against the int8 vectors until it has its own (`cd packages/core && bun script/embed-golden.ts <folder> --variant fp32`).
- **The Code-aware preview** stays a preview until its two tokenizer files' sha256 are pinned in `embed-manifest.ts`, its check vectors are written with `bun script/embed-golden.ts <folder> --model granite-small-r2-q8`, and its floor is set from the knowledge eval.
- **Vectorscope in the desktop app** does not get linked requirements yet; only `vector review` in the terminal does, with the next CLI release.

## Changes people will notice

- Settings → General no longer shows the memory file. `MEMORY.md` is the same file, now on Settings → Memory, and each request sends about its first 800 tokens and the rest only when it bears on the request, where 1.99.109 sent the whole file every time.
- A repository's `BRAIN.md` is used only once the repository is trusted; until then it waits for review.
- Vector's record of failing checks and the repairs that worked moves from the repository's `.vector/failure-memory.json` to Vector's data folder on the first read. The old file stays in the repository until Clear history removes both, so people who committed it can delete it.
- The model picker says **Provided by Vector** for free models inside of Vector, and limit notices say when they are expected to be available again.
