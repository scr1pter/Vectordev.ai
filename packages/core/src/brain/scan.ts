export * as BrainScan from "./scan"

import { collectSecretValues, redactSecrets, REDACTED } from "../review/redact"

// Checks every memory write, and every line mirrored from a file, before it can reach a prompt. All of it is plain
// pattern matching: no model reads a memory to decide whether it is safe.

// Zero-width characters, bidirectional controls and Unicode tag characters. They render as nothing, so a rules file can
// carry text a person reviewing it never sees (the "rules file backdoor").
const HIDDEN = /[\u00AD\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF]|[\u{E0000}-\u{E007F}]/gu

export function hidden(text: string) {
  return text.search(HIDDEN) >= 0
}

export function stripHidden(text: string) {
  return text.replace(HIDDEN, "")
}

// `password = hunter2`, `API_KEY: abc…`: a value written next to a secret-sounding name.
const NAMED =
  /\b[\w.-]*(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key)\b["']?\s*[:=]\s*["']?(?=[^\s"',;]*[\d$#@!%^&*])[^\s"',;]{8,}/gi

// Shapes that are a credential wherever they appear, beyond the provider token shapes review redaction knows.
const SECRET_SHAPES = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:[^\s/@]+@[^\s]+/gi,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g,
  /\bnpm_[A-Za-z0-9]{36}\b/g,
  /\bglpat-[A-Za-z0-9_-]{20,}\b/g,
  /\bhf_[A-Za-z0-9]{30,}\b/g,
  /\bvct_[A-Za-z0-9._-]{16,}/g,
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/g,
  NAMED,
  // Incoming webhooks: the URL is the credential.
  /\bhttps?:\/\/hooks\.slack\.com\/(?:services|workflows|triggers)\/[A-Za-z0-9_/-]+/gi,
  /\bhttps?:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+/gi,
  /\bhttps?:\/\/[\w.-]+\.webhook\.office\.com\/[^\s"'<>]+/gi,
]

// A secret written in plain words: "the admin password is Tr0ub4dor&3x", "the wifi passphrase is correct horse battery
// staple". A phrase runs to the end of its clause; any other secret is the one word after "is".
const SPOKEN =
  /\b(password|passwd|passcode|passphrase|pin(?: code)?|secret|token|api key|access key|(?:unlock|recovery|seed|pass) (?:phrase|code|key|words))\s+(?:is|was|are|were)\s+["'“]?([^\s"'”,;]+(?:\s+[^\s"'”,;.]+)*)/gi

// Words after "the password is" that say something about it rather than give it: "is stored in 1Password", "is
// required", "is the same as staging".
const NOT_A_VALUE =
  /^(?:stored|kept|saved|managed|set|read|loaded|in|on|at|from|the|a|an|not|never|no|required|needed|optional|rotated|generated|available|provided|configured|defined|found|written|shared|sent|changed|hashed|encrypted|missing|empty|wrong|invalid|expired|only|always|usually|also|still|now|then|same|different|unknown|too|of|for|to|under|via|by|injected|passed|fetched|pulled|created|reset|entered|typed|asked|prompted|validated|checked|verified|used|mandatory|long|short|strong|weak|\[redacted\])$/i

// One word passes for a password when it is not plain prose: it has a digit, a symbol or a capital inside it. A phrase
// ("correct horse battery staple") is all words, so a passphrase or recovery phrase is taken whole.
const PASSWORD_LIKE = /\d|[!@#$%^&*_+=~?<>|\\]|[a-z][A-Z]/

// A username and password pair: "login: admin / hunter2hunter2", "credentials are deploy/s3cret!".
const LOGIN =
  /\b((?:login|logins|credentials?|creds)\s*(?::|=|\bis\b|\bare\b))\s*["']?[^\s"'/]+\s*\/\s*(?=[^\s"',;]*[\d!@#$%^&*_+=~?])[^\s"',;]+/gi

// An AWS secret access key is 40 characters that read like a path once split at "/", so beside an access key id any
// such run is the secret.
const AWS_ID = /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/
const AWS_SECRET = /(?<![A-Za-z0-9/+])[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+=])/g

function spoken(text: string) {
  return text.replace(SPOKEN, (match, name: string, value: string) => {
    const first = value.split(/\s+/)[0]!.replace(/[.!?]+$/, "")
    if (NOT_A_VALUE.test(first) || /^\$|^[A-Z][A-Z0-9]*_[A-Z0-9_]+$/.test(first)) return match
    const phrase = /phrase|words/i.test(name)
    // A PIN is digits; "the version pin is 5.6.2" is not one.
    if (/^pin/i.test(name) ? !/^\d{4,8}$/.test(first) : !phrase && (first.length < 6 || !PASSWORD_LIKE.test(first)))
      return match
    const secret = phrase ? value.replace(/[.!?]+$/, "") : first
    const at = match.length - value.length
    return `${match.slice(0, at)}${REDACTED}${match.slice(at + secret.length)}`
  })
}

/**
 * Whether the text gives a password, passphrase, PIN or login together with its value. The agent never saves such a
 * line, even redacted: a secret is not something to remember, and where it lives is what a memory should say.
 */
export function credential(text: string) {
  const clean = stripHidden(text)
  return spoken(clean) !== clean || clean.search(LOGIN) >= 0 || clean.search(NAMED) >= 0
}

// A long run of mixed letters and digits with no word in it is a key far more often than it is prose or a path. A path
// or identifier ("migration/20261015_add_review_helpers") is made of words, so two word segments rule a match out.
const OPAQUE = /\b(?=[A-Za-z0-9_\-+/]*\d)(?=[A-Za-z0-9_\-+/]*[A-Za-z])[A-Za-z0-9_\-+/]{32,}={0,2}/g

function opaque(match: string) {
  if (/^[0-9a-f]{40}$/i.test(match)) return false
  if (match.split(/[/_\-.+]+/).filter((segment) => /^[a-z]{4,}$/i.test(segment)).length >= 2) return false
  return entropy(match) >= 3.5
}

/** The text with every credential replaced by [redacted], and whether anything was. */
export function redact(text: string, env: Record<string, string | undefined> = process.env) {
  const shaped = spoken(SECRET_SHAPES.reduce((out, shape) => out.replace(shape, REDACTED), text)).replace(
    LOGIN,
    `$1 ${REDACTED}`,
  )
  const aws = AWS_ID.test(shaped) ? shaped.replace(AWS_SECRET, REDACTED) : shaped
  const known = redactSecrets(aws, collectSecretValues(env))
  const out = known.replace(OPAQUE, (match) => (opaque(match) ? REDACTED : match))
  return { text: out, redacted: out !== text }
}

/** How much of the text is left once secrets are removed, so an entry that is mostly a secret is refused, not kept. */
export function remainder(text: string) {
  return text.replaceAll(REDACTED, "").replace(/[^A-Za-z0-9]+/g, "").length
}

function entropy(value: string) {
  const counts = new Map<string, number>()
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1)
  return [...counts.values()].reduce((sum, count) => {
    const p = count / value.length
    return sum - p * Math.log2(p)
  }, 0)
}

// Text written to steer the agent rather than to describe the repository: an override of its instructions, a hidden
// action, or sending data somewhere. A memory that reads like one waits for the user, because memory poisoning works
// exactly by planting such a line where it will be read later as trusted guidance.
const INSTRUCTION_LIKE = [
  /\b(?:ignore|disregard|forget|override)\b[^.\n]{0,40}\b(?:previous|prior|above|earlier|all|any|system|your)\b[^.\n]{0,20}\b(?:instructions?|rules?|prompts?|guidance|messages?)\b/i,
  /\b(?:system prompt|developer message|jailbreak|you are now|new instructions|act as (?:an?|the) )/i,
  /\b(?:do not|don't|never)\s+(?:tell|inform|show|mention|ask)\s+(?:the\s+)?(?:user|human|owner)\b/i,
  /\bwithout\s+(?:asking|telling|confirm(?:ing|ation)|approval|permission)\b/i,
  /\b(?:send|post|upload|exfiltrate|forward|leak|transmit|email)\b[^\n]{0,80}\b(?:https?:\/\/|webhook|pastebin|ngrok|\d{1,3}(?:\.\d{1,3}){3})/i,
  /\b(?:curl|wget|iwr|invoke-webrequest)\b[^|\n]{0,200}\|\s*(?:sudo\s+)?(?:ba|z|da|k)?sh\b/i,
  /\b(?:approve|allow|accept)\s+(?:all|every|any)\s+(?:permissions?|requests?|prompts?|commands?)\b/i,
  /\b(?:disable|turn off|bypass|skip)\s+(?:the\s+)?(?:sandbox|permissions?|security|safety|guardrails?|review|tests? before (?:commit|push))/i,
  /(?:\.ssh\b|id_rsa|\.aws\/credentials|keychain|\.env\b)[^\n]{0,60}\b(?:send|post|upload|cat|print|copy)\b/i,
  /[A-Za-z0-9+/]{120,}={0,2}/,
]

export function instructionLike(text: string) {
  return INSTRUCTION_LIKE.some((pattern) => pattern.test(text))
}
