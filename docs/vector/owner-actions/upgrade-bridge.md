# Ambiguous historical environment variable

Status: waiting for the owner's choice, requested September 25, 2026. The normal upgrade fixture passes; this is a narrow remaining identification limit.

A standalone arbitrary environment variable ending in `_DB` cannot safely be attributed to Vector solely from its suffix. It may belong to another program or contain `:memory:` rather than a recognizable file. The new importer recognizes a historical prefix when distinctive sibling variables establish it, while the released default `vector.db` and `auth.json` paths already remain unchanged. It does not claim to migrate every arbitrary lone `_DB` variable.

The owner was offered:

1. A one-time migration bridge based on the historical release. That separate bridge can recognize the historical settings explicitly and copy them into the current Vector names, preserving originals. Its distribution and exception to the new repository's naming rule must be approved before implementation or release.
2. A documented manual repair for this rare case: retain the existing database file and set `VECTOR_AGENT_DB` to that same path before starting the new version.

Do not silently point an affected user at an empty database. Do not scan credential stores, infer ownership from a generic suffix, or restore a borrowed service endpoint. No bridge has been built or published while this decision is pending.
