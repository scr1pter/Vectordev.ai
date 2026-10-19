# Search spec

## 1 Indexing

`reindexAll` MUST run in the background.

## 2 Results

Results come in pages of at most 20 items, as `SEARCH_PAGE_SIZE` sets.

`hideArchived` MUST drop archived accounts from every result.
