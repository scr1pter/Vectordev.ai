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

// `password = hunter2`, `DATABASE_PASSWORD='correct horse battery staple'`, `"token": "…"`: a value given to a
// secret-sounding name. Group 1 is a quote around the name, 2 the name, 3 `:` or `=`, 4 the value. The name's prefix is
// bounded, so a long run of name characters costs a fixed amount at each place a match is tried, not the rest of it.
const ASSIGNED =
  /(["']?)\b([\w.-]{0,128}?(?:password|passwd|passphrase|passcode|pass|pwd|secret|secret[_-]?key|token|api[_-]?key|access[_-]?key|private[_-]?key))\1\s*([:=])\s*("[^"\n]*"|'[^'\n]*'|[^\s"',;]+)/gi

// What stands where a secret would in code and configuration: an environment variable, a template slot, a type, a
// mask. None of them is the secret.
const PLACEHOLDER =
  /^(?:\$.*|<[^>]*>|\{\{.*|process\.env\b.*|env\.\w+|os\.(?:environ|getenv)\b.*|\*+|x{3,}|\.{3,}|string|number|boolean|bool|str|int|any|unknown|null|undefined|none|nil|true|false|optional|required|\[redacted\]|redacted)$/i

// A value given to a secret-sounding name is the secret, whatever it looks like, when it is code or configuration
// (`=`, a quoted or identifier-like name, a quoted value) or when the name is a password. In prose ("the token:
// validate it before use") only a value that looks like a key is.
function assigned(text: string) {
  return text.replace(ASSIGNED, (match, quote: string, name: string, separator: string, value: string) => {
    // "bypass" and "compass" end in "pass" without naming one.
    if (/(?:pass|pwd)$/i.test(name) && !/(?:^|[_.-])(?:pass|pwd)$/i.test(name) && !/pass(?:word|wd|phrase|code)$/i.test(name))
      return match
    const bare = value.replace(/^["']|["']$/g, "").trim()
    // A type in a signature or schema ("token: String!)", "password: string;") names no value.
    if (!bare || PLACEHOLDER.test(bare) || PLACEHOLDER.test(bare.replace(/^\[+|[!?)\]}:,.]+$/g, ""))) return match
    const code = separator === "=" || quote !== "" || value !== bare || /[_.-]|[A-Z]/.test(name)
    const password = /(?:pass(?:word|wd|phrase|code)?|pwd)$/i.test(name)
    if (!code && !password && !(bare.length >= 8 && /[\d$#@!%^&*]/.test(bare))) return match
    if (!code && password && NOT_A_VALUE.test(bare.replace(/[.!?]+$/, ""))) return match
    return `${match.slice(0, match.length - value.length)}${REDACTED}`
  })
}

// Shapes that are a credential wherever they appear, beyond the provider token shapes review redaction knows.
const SECRET_SHAPES = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /\b[a-z][a-z0-9+.-]{0,31}:\/\/[^\s:/@]+:[^\s/@]+@[^\s]+/gi,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g,
  /\bnpm_[A-Za-z0-9]{36}\b/g,
  /\bglpat-[A-Za-z0-9_-]{20,}\b/g,
  /\bhf_[A-Za-z0-9]{30,}\b/g,
  /\bvct_[A-Za-z0-9._-]{16,}/g,
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/g,
  // Incoming webhooks: the URL is the credential.
  /\bhttps?:\/\/hooks\.slack\.com\/(?:services|workflows|triggers)\/[A-Za-z0-9_/-]+/gi,
  /\bhttps?:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+/gi,
  /\bhttps?:\/\/[\w.-]+\.webhook\.office\.com\/[^\s"'<>]+/gi,
]

// A secret written in plain words: "the admin password is Tr0ub4dor&3x", "the wifi passphrase is correct horse battery
// staple", "the admin password for staging is Tr0ub4dor&3x", "the wifi code for the office is 8842-1937-2210". A few
// words of what it is for may sit between the name and "is". A phrase runs to the end of its clause; any other secret is
// the one word after "is".
const SPOKEN =
  /\b(password|passwd|passcode|passphrase|pin(?: code)?|secret|token|api key|access key|(?:unlock|recovery|seed|pass) (?:phrase|code|key|words)|(?:wi-?fi|door|alarm|gate|safe|entry|access) (?:code|password|key)|pass)(?:\s+(?:for|of|on|to|at)\s+(?:(?:the|a|an|our|my|your)\s+)?[\w'-]+(?:\s+[\w'-]+){0,2}?)?\s+(?:is|was|are|were)\s+["'“]?([^\s"'”,;]+(?:\s+[^\s"'”,;.]+)*)/gi

// Words after "the password is" that say something about it rather than give it: "is stored in 1Password", "is
// required", "is the same as staging".
const NOT_A_VALUE =
  /^(?:stored|kept|saved|managed|set|read|loaded|in|on|at|from|the|a|an|not|never|no|required|needed|optional|rotated|generated|available|provided|configured|defined|found|written|shared|sent|changed|hashed|encrypted|missing|empty|wrong|valid|invalid|incorrect|accepted|rejected|allowed|denied|enabled|disabled|active|inactive|expired|only|always|usually|also|still|now|then|same|different|unknown|too|of|for|to|under|via|by|injected|passed|fetched|pulled|created|reset|entered|typed|asked|prompted|validated|checked|verified|used|mandatory|long|short|strong|weak|secure|insecure|private|public|secret|random|unique|complex|simple|easy|hard|good|bad|fine|ok|okay|old|new|current|default|temporary|temp|personal|common|known|obvious|visible|hidden|plain|plaintext|cleartext|masked|blank|null|none|nothing|something|here|there|below|above|this|that|it|what|which|whatever|see|ask|check|case|its|their|your|my|our|his|her|\[redacted\])$/i

// Words that describe a password rather than give it: "is case-sensitive", "is rotating", "is configurable".
const DESCRIBES = /(?:ed|able|ible|ive|ly|ing|ful|less|ous)$/i

// One word passes for a password when it is not plain prose: it has a digit, a symbol or a capital inside it. A phrase
// ("correct horse battery staple") is all words, so a passphrase or recovery phrase is taken whole.
const PASSWORD_LIKE = /\d|[!@#$%^&*_+=~?<>|\\]|[a-z][A-Z]/

// A username and password pair: "login: admin / hunter2hunter2", "credentials are deploy/s3cret!", "basic auth is
// admin:Tr0ub4dor&3x". The password has a letter and a digit or symbol, so "localhost:3000" is not one. An endpoint is
// not a pair: an HTTP method is not a username, and after a spaced "/" a path ("Login: POST /v1/session") is not a
// password.
const LOGIN =
  /\b((?:login|logins|credentials?|creds|basic auth)\s*(?::|=|\bis\b|\bare\b))\s*["']?(?!(?:GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)\b)[^\s"'/:]+(?:\s*:\s*|\/|\s+\/\s*(?![^\s"',;]*\/)|\/\s+(?![^\s"',;]*\/))(?!\/)(?=[^\s"',;]*[A-Za-z])(?=[^\s"',;]*[\d!@#$%^&*_+=~?])[^\s"',;]+/gi

// Words that name a password, a login or a code. A password-like value in the same sentence is that secret, wherever it
// sits: "the staging admin's password, Tr0ub4dor&3x, is in the seed script", "log in to staging as admin with
// Tr0ub4dor&3x", "use hunter2hunter2 as the admin password". A PIN or a door code is digits.
const SECRET_NEAR =
  /\b(?:passwords?|passwd|pw|passphrases?|passcodes?|credentials?|creds|basic auth|log ?ins?|logon|sign ?ins?|(?:wi-?fi|door|alarm|gate|safe|entry|access) (?:codes?|passwords?|keys?)|pins?(?: codes?)?)\b/gi

// A sentence: up to a full stop, question mark, exclamation mark or semicolon that ends it, or a line break. A dot inside
// a word ("utils.ts") does not end one.
const SENTENCE = /(?:[^\n.!?;]|[.!?;](?![\s]|$))+/g

// Punctuation and markup around a word that is not part of it: "**Login**:", "(Tr0ub4dor&3x),".
const EDGE = /^[*_`"'“”‘’([{<,.;:!?]+|[*_`"'“”‘’)\]}>,.;:!?]+$/g

// Quoted words given as a password: "use 'blue velvet sky' as the wifi password". Quoted text that names a password
// itself ("Show 'Forgot your password?' as the link") is the interface's copy, not a secret.
const AS_PASSWORD =
  /(["'“‘])((?:(?!password|passphrase|log ?in|sign ?in)[^"'”’\n]){4,80})["'”’](?=\s+(?:as|for)\s+(?:(?:the|our|my|your|a)\s+)?(?:[\w'-]+\s+){0,3}(?:password|passphrase|passcode|pin|pw)\b)/gi

// An AWS secret access key is 40 characters that read like a path once split at "/", so beside an access key id any
// such run is the secret.
const AWS_ID = /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/
const AWS_SECRET = /(?<![A-Za-z0-9/+])[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+=])/g

function spoken(text: string) {
  return text.replace(SPOKEN, (match, name: string, value: string) => {
    const first = value.split(/\s+/)[0]!.replace(/[.!?]+$/, "")
    if (NOT_A_VALUE.test(first) || /^\$|^[A-Z][A-Z0-9]*_[A-Z0-9_]+$/.test(first)) return match
    const phrase = /phrase|words/i.test(name)
    const password = /pass(?:word|wd|code)?$/i.test(name)
    // A password is a password in any word ("the staging password is swordfish"). A PIN or a door code is digits ("the
    // version pin is 5.6.2" is not one); another secret is one when it looks like a key.
    const code = /^pin|code$/i.test(name)
    const secret =
      phrase ||
      (password && first.length >= 4 && !DESCRIBES.test(first)) ||
      (!password && code && /^(?:\d{4,8}|\d{2,5}(?:-\d{2,5})+)$/.test(first)) ||
      (!password && !code && first.length >= 6 && PASSWORD_LIKE.test(first))
    if (!secret) return match
    const hidden = phrase ? value.replace(/[.!?]+$/, "") : first
    const at = match.length - value.length
    return `${match.slice(0, at)}${REDACTED}${match.slice(at + hidden.length)}`
  })
}

// A PIN or a code beside its name: four to six digits, or groups of digits ("8842-1937-2210").
const DIGITS = /^(?:\d{4,6}|\d{2,5}(?:-\d{2,5})+)$/

function near(text: string) {
  return text.replace(SENTENCE, (sentence) => {
    const named = sentence.match(SECRET_NEAR) ?? []
    if (named.length === 0) return sentence
    const coded = named.some((word) => /pin|code/i.test(word))
    const worded = named.some((word) => !/^pins?(?: codes?)?$/i.test(word))
    return sentence.replace(/\S+/g, (word) => {
      const token = word.replace(EDGE, "")
      return (worded && passwordLike(token)) || (coded && DIGITS.test(token)) ? word.replace(token, REDACTED) : word
    })
  })
}

// A word that reads like a password rather than a name, a path or a number: a symbol among letters or digits
// ("Tr0ub4dor&3x", "P@ssw0rd"), or letters broken up by digits more than once ("hunter2hunter2", "s3cr3tpass"). A hashing
// scheme ("argon2id", "sha256"), a path, a version, a flag, a package scope, an environment variable, a commit and an
// assignment are not.
function passwordLike(token: string) {
  if (token.length < 6 || /^[@#$-]|[/.=()[\]{}<>`]/.test(token) || /^[A-Z][A-Z0-9_]*$/.test(token)) return false
  if (/^[0-9a-f]{7,64}$/i.test(token)) return false
  if (/[!@#$%^&*+~?|\\]/.test(token) && /[A-Za-z0-9]/.test(token)) return true
  return token.length >= 8 && /[A-Za-z]/.test(token) && (token.match(/\d+/g)?.length ?? 0) >= 2
}

/**
 * Whether the text gives a password, passphrase, PIN or login together with its value. The agent never saves such a
 * line, even redacted: a secret is not something to remember, and where it lives is what a memory should say.
 */
export function credential(text: string) {
  const clean = stripHidden(text)
  return (
    spoken(clean) !== clean ||
    clean.search(LOGIN) >= 0 ||
    assigned(clean) !== clean ||
    near(clean) !== clean ||
    clean.search(AS_PASSWORD) >= 0
  )
}

// A long run of mixed letters and digits with no word in it is a key far more often than it is prose or a path. A path
// or identifier ("migration/20261015_add_review_helpers") is made of words, so two word segments rule a match out.
// Whether a run has a digit and a letter is checked once it is matched, so each run is read once.
const OPAQUE = /\b[A-Za-z0-9_\-+/]{32,}={0,2}/g

// A run of hex is a commit or a checksum more often than a key, unless a secret-sounding word is right beside it.
const HEX = /\b[0-9a-f]{32,}\b/gi
const SECRET_WORD = /(?:^|[^a-z])(?:keys?|secrets?|tokens?|passw\w*|credentials?)(?:[^a-z]|$)/i

function keyed(text: string) {
  return text.replace(HEX, (match: string, offset: number) =>
    SECRET_WORD.test(text.slice(Math.max(0, offset - 40), offset)) ||
    SECRET_WORD.test(text.slice(offset + match.length, offset + match.length + 25))
      ? REDACTED
      : match,
  )
}

function opaque(match: string) {
  if (!/\d/.test(match) || !/[A-Za-z]/.test(match) || /^[0-9a-f]{40}$/i.test(match)) return false
  if (match.split(/[/_\-.+]+/).filter((segment) => /^[a-z]{4,}$/i.test(segment)).length >= 2) return false
  return entropy(match) >= 3.5
}

/** The text with every credential replaced by [redacted], and whether anything was. */
export function redact(text: string, env: Record<string, string | undefined> = process.env) {
  const shaped = near(
    spoken(assigned(SECRET_SHAPES.reduce((out, shape) => out.replace(shape, REDACTED), text))).replace(
      LOGIN,
      `$1 ${REDACTED}`,
    ),
  ).replace(AS_PASSWORD, `$1${REDACTED}$1`)
  const aws = AWS_ID.test(shaped) ? shaped.replace(AWS_SECRET, REDACTED) : shaped
  const known = keyed(redactSecrets(aws, collectSecretValues(env)))
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

// Text in a document that speaks to an AI reading it rather than to the document's readers: a planted turn of a
// conversation, a role tag, a new task. Documents are checked with these as well, memory writes with the list above.
const ADDRESSED = [
  /\bif you are an? (?:ai|assistant|language model|llm|large language model|chatbot|agent)\b/i,
  /\b(?:ai|llm) (?:agents?|assistants?|models?) (?:reading|processing|summari[sz]ing) this\b/i,
  /\bto (?:the|any) (?:ai|llm|assistant|language model) (?:reading|processing) this\b/i,
  /<\/?system>/i,
  /^\s*assistant\s*:/im,
  /\byou must now\b/i,
  /\bnew task\s*:/i,
]

/** Whether text reads as instructions to the agent. A document's text is also checked for text addressed to an AI. */
export function instructionLike(text: string, document = false) {
  return (
    INSTRUCTION_LIKE.some((pattern) => pattern.test(text)) ||
    (document && ADDRESSED.some((pattern) => pattern.test(text)))
  )
}
