# Dive/connector clips (Step 4 of the skill)

Dive prompt pattern (Seedance image-to-video, --start-image = the scene still):
  'Slow continuous forward camera flight toward and into the interior of the scene,
   smooth single take, no cuts, no camera shake, subjects animate subtly in place,
   lighting and palette unchanged.'

Connector n (between scene n and n+1): --start-image = ACTUAL last frame of dive n
(extract with ffmpeg), --end-image = ACTUAL first frame of dive n+1. Prompt:
  'Continuous forward camera flight leaving the scene and travelling through soft
   darkness with faint violet light streaks toward the next glowing miniature,
   single take, no cuts, palette unchanged.'
