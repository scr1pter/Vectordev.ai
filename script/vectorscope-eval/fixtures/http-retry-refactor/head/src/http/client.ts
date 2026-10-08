import { sleep } from "../util/sleep"

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = "HttpError"
  }
}

const MAX_ATTEMPTS = 3
const BASE_DELAY_MS = 200

export async function getJson<T>(url: string, headers: Record<string, string> = {}): Promise<T> {
  const response = await send(url, { headers: { accept: "application/json", ...headers } })
  return (await response.json()) as T
}

export async function putJson<T>(url: string, body: unknown, headers: Record<string, string> = {}): Promise<T> {
  const response = await send(url, {
    method: "PUT",
    headers: { accept: "application/json", "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  })
  return (await response.json()) as T
}

// A resource that is already gone counts as deleted.
export async function deleteResource(url: string, headers: Record<string, string> = {}): Promise<void> {
  await send(url, { method: "DELETE", headers }, (status) => status === 404)
}

// Sends one request, retrying 429 and 5xx responses after 200 ms and then 400 ms. Returns the first response that is
// ok or accepted; any other response is an HttpError once it is not retryable or the attempts are used up.
async function send(
  url: string,
  init: RequestInit,
  accept: (status: number) => boolean = () => false,
): Promise<Response> {
  const method = init.method ?? "GET"
  for (let attempt = 1; ; attempt++) {
    const response = await fetch(url, init)
    if (response.ok || accept(response.status)) return response
    if (!retryable(response.status) || attempt >= MAX_ATTEMPTS)
      throw new HttpError(response.status, `${method} ${url} failed with ${response.status}`)
    await sleep(BASE_DELAY_MS * 2 ** (attempt - 1))
  }
}

function retryable(status: number) {
  return status === 429 || status >= 500
}
