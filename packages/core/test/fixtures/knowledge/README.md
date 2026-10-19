# Knowledge eval fixtures

A small invented repository (`repo/`), five specs for it (`documents/`) and `queries.json`, for
`test/brain/knowledge-eval.test.ts`. Working-set cases are tasks phrased the way a request is, with the files the
request touches; most share no words with the requirement that governs those files, which is the point. Hop cases edit a
file that imports the governed one (each through a namespace import that names the governed function once, so no
document is linked to the edited file itself): only the code graph can reach those. Irrelevant cases touch a file no
document is linked to and ask about nothing the documents say.
