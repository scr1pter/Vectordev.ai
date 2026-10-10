# Published site isolation

Published sites currently share a host under `/s/<deployment>/` and `/p/<project>/`.
Every served document has a CSP sandbox with an opaque origin. Scripts, forms,
downloads, and sandboxed popups are allowed, but cookies, local storage, service
workers, and top-level navigation are isolated or blocked. Public assets allow
noncredentialed CORS so JavaScript modules can load from those opaque origins.

Applications that require their own persistent browser storage, cookies, or
service workers need separate origins per site before those features can be
enabled. Do not add `allow-same-origin` to this shared-host sandbox.
Any service workers installed before this protection require browser site-data
cleanup or migration to a fresh hosting origin; response headers do not remove
existing service-worker registrations.

Publish and serve validation rejects private dotfiles, keys, source files, source
maps, and ambiguous encoded paths. Public `.well-known` files remain supported.
This is a filename guard, not a secret scanner: publish only the intended build
output and keep credentials out of browser assets. Previously uploaded sensitive
files must also be removed from the backing public Blob store; rejecting requests
through Vector does not revoke an existing direct Blob URL.

The local development server binds only to `127.0.0.1` and rejects nonloopback
Host headers to prevent DNS rebinding. Its default token is for
local development, and must never be used as a production publishing credential.
