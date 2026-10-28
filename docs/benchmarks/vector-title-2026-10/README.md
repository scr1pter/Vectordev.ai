# Desktop initial-title evidence

The baseline was recorded before changing desktop session creation, on source
`e8bd513e1e37fe458b6187f82f4df8af4cdd781b`. The manual production benchmark is
[run 40783424228, job 123150544735](https://github.com/scr1pter/claudeondfsfdaf/actions/runs/40783424228/job/123150544735).
The job built the production app and ran the existing navigation fixture on
Chromium/Linux, one worker, with three repeats. It used mocked engine/provider
responses and no model keys or paid inference. No browser benchmark ran locally.

`before.json` preserves every emitted BENCHMARK record, including all samples,
repeat indexes, and failures: nine initial results and six retries. Six initial
results contain metrics. All three unvisited-task and all three new-session-page
runs passed, with no blank or unknown samples. First destination observations
were 151.4/156.4/158.5 ms and 157.4/136.7/161.2 ms respectively.

The job failed because the child-session scenario could not find its task-card
link before the existing 60-second deadline. That happened before the title
implementation in every repeat and both retries. Those nine records contain
`metrics: null`; they are failures, not zero-duration or successful measurements.
No timeout, assertion, scenario, or fixture has been relaxed. Repeat this same
workload after the change and retain the same distinction in the comparison.

This navigation benchmark does not measure title-generation cost or prove a
performance advantage. The separate existing offline engine case, `title
generation sends only what the user typed`, passed before the change (one test,
ten assertions). It records two provider requests: one main response and one
title request, with one ancillary-usage row. A client-named-session regression
will check the corresponding path after the change. These are request counts
against a fake provider, not measured live dollars or provider caching.
