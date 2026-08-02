# Vector — scroll-world intake (locked 2026-07)

- SUBJECT: Vector — the AI software engineering workspace. Agents that plan, edit,
  run, and verify code on your machine, with your own model keys.
- BRAND_NAME: Vector
- PALETTE: void `#0B0A10` (scene background), panel `#16151C`, violet `#8B5CF6`
  (primary accent), lavender `#C4B5FD`, glow-white `#F5F3FF`
- TONE: premium, calm, engineered, night
- STYLE: Neon-night isometric miniature (dark variant of the diorama direction):
  miniature at night, warm interior glow and violet neon accents, moody rim light,
  wet reflective ground. Identical preamble across all six stills.
- MOBILE: yes (beta variants, 720p tight-GOP)

## Sections (in flight order)

| # | id | label | diorama subject |
|---|----|-------|-----------------|
| 1 | workspace | The Workspace | night tower, glass wall, agent desk with glowing chat timeline |
| 2 | codespace | The Codespace | machine-hall of floating editor panels, code as architecture |
| 3 | browser-lab | The Browser Lab | a browser window held mid-air, light-traces clicking through it |
| 4 | parallel-hall | The Parallel Hall | corridor of identical glass workrooms, one agent per room |
| 5 | vault | The Vault | checkpoint archive: sealed diff crates, risk seals, rollback lever |
| 6 | launch-deck | Launch Deck | rooftop overlooking the whole world, beacon, oversized Vector mark |

Copy (eyebrow / title / body / tags) lives in `src/pages/world.astro` — single source.

## Asset contract (what generation must produce)

- Stills → `public/scroll-world/assets/<id>.webp` (3:2, 2k, cwebp -q 84)
- Dive clips → `public/scroll-world/assets/vid/<id>.mp4` (1080p, crf 20, -g 8, +faststart, no audio)
- Connectors → `public/scroll-world/assets/vid/conn-<n>.mp4` (n = 1..5, frame-locked:
  start = previous dive's actual LAST frame, end = next dive's actual FIRST frame)
- Mobile variants → same names with `-m.mp4` (720p, -g 4)

## To run generation (owner steps first)

1. Create a Higgsfield account with credits, install the CLI, run `higgsfield auth login`
   (interactive OAuth — must be run by a human).
2. `brew install ffmpeg webp jq`
3. Follow the pipeline scripts in the scroll-world skill
   (https://github.com/oso95/scroll-world → `skills/scroll-world/references/pipeline.md`)
   with `NAMES="workspace codespace browser-lab parallel-hall vault launch-deck"`,
   `VMODEL=seedance_2_0`, prompts from `./prompts/`.
4. Drop outputs into the asset paths above — `/world` picks them up with no code change.
