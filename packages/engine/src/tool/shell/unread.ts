// The prefix of the permission pattern for a shell statement the scan cannot fully read: a command the grammar fails to
// parse, or a backtick or `$(` that bash or zsh runs but the grammar keeps as text. Bash reads a word that starts with
// `#` as a comment, so no statement the scan does read produces a pattern that starts this way, and no allow rule such
// as the read-only agents' `git log*` matches it. Rules match across newlines, so the statement's own text would not be
// enough: `git log -1` followed by a hidden substitution still starts with `git log`.
export const UNREAD = "#unread "
