export async function requestWithURL(request: Request, url: URL) {
  if (url.href === request.url) return request
  // Passing a Request as RequestInit turns its body into a streaming upload in
  // browsers. Local HTTP/1 servers cannot accept that upload, so keep a byte body.
  return new Request(url, {
    method: request.method,
    headers: request.headers,
    body: request.body === null ? undefined : await request.arrayBuffer(),
    cache: request.cache,
    credentials: request.credentials,
    integrity: request.integrity,
    keepalive: request.keepalive,
    mode: request.mode,
    redirect: request.redirect,
    referrer: request.referrer,
    referrerPolicy: request.referrerPolicy,
    signal: request.signal,
  })
}
