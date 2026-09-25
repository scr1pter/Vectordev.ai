import { Marked, type MarkedToken, type Token } from "marked"
import { For, createMemo, type JSX } from "solid-js"

const markdown = new Marked({ gfm: true, breaks: false })

export function safeLink(href: string) {
  // Only absolute web links are active. Never fetch transcript images or files.
  if (!/^https?:\/\//i.test(href) || /[\u0000-\u0020\u007f]/.test(href)) return
  try {
    const url = new URL(href)
    if (url.username || url.password) return
    return url.href
  } catch {
    return
  }
}

export function ContentMarkdown(props: { text: string; expand?: boolean; highlight?: boolean }) {
  const tokens = createMemo(() => parseMarkdown(props.text))
  return (
    <div data-component="public-markdown">
      {tokens() ? <Tokens tokens={tokens()!} depth={0} /> : <pre>{props.text}</pre>}
    </div>
  )
}

function parseMarkdown(text: string) {
  if (text.length > 100_000) return
  try {
    return markdown.lexer(text)
  } catch {
    // Malformed or deeply nested content must remain readable as plain text.
    return
  }
}

function Tokens(props: { tokens: Token[]; depth: number }): JSX.Element {
  return <For each={props.tokens}>{(token) => <TokenView token={token} depth={props.depth} />}</For>
}

function TokenView(props: { token: Token; depth: number }): JSX.Element {
  // This private parser has no extensions producing Generic tokens.
  const token = props.token as MarkedToken
  if (props.depth > 16) return <span>{token.raw}</span>
  const nested = (tokens?: Token[]) => <Tokens tokens={tokens ?? []} depth={props.depth + 1} />
  switch (token.type) {
    case "space":
      return null
    case "paragraph":
      return <p>{nested(token.tokens)}</p>
    case "text":
      return token.tokens ? nested(token.tokens) : <span>{token.text}</span>
    case "heading":
      return <h3>{nested(token.tokens)}</h3>
    case "strong":
      return <strong>{nested(token.tokens)}</strong>
    case "em":
      return <em>{nested(token.tokens)}</em>
    case "del":
      return <del>{nested(token.tokens)}</del>
    case "codespan":
      return <code>{token.text}</code>
    case "code":
      return (
        <pre>
          <code>{token.text}</code>
        </pre>
      )
    case "blockquote":
      return <blockquote>{nested(token.tokens)}</blockquote>
    case "br":
      return <br />
    case "hr":
      return <hr />
    case "escape":
      return <span>{token.text}</span>
    case "link": {
      const href = safeLink(token.href)
      return href ? (
        <a
          href={href}
          title={token.title ?? undefined}
          target="_blank"
          rel="noopener noreferrer nofollow"
          referrerPolicy="no-referrer"
        >
          {nested(token.tokens)}
        </a>
      ) : (
        <span>{nested(token.tokens)}</span>
      )
    }
    case "image":
      return <span>[Image: {token.text || "attachment"}; not loaded]</span>
    case "list": {
      const items = () => (
        <For each={token.items}>
          {(item) => (
            <li>
              {item.task ? `[${item.checked ? "x" : " "}] ` : ""}
              {nested(item.tokens)}
            </li>
          )}
        </For>
      )
      return token.ordered ? (
        <ol start={typeof token.start === "number" ? token.start : undefined}>{items()}</ol>
      ) : (
        <ul>{items()}</ul>
      )
    }
    case "table":
      return (
        <div class="public-table">
          <table>
            <thead>
              <tr>
                <For each={token.header}>{(cell) => <th>{nested(cell.tokens)}</th>}</For>
              </tr>
            </thead>
            <tbody>
              <For each={token.rows}>
                {(row) => (
                  <tr>
                    <For each={row}>{(cell) => <td>{nested(cell.tokens)}</td>}</For>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </div>
      )
    // Raw HTML and future/unknown token kinds stay inert text. No HTML sink exists.
    default:
      return <span>{token.raw}</span>
  }
}
