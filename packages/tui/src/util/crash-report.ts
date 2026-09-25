export const supportReportUrl = "https://vectordev.ai/support/report"

export function crashReport(input: { message: string; stack: string; version: string; os: string; terminal: string }) {
  const text = [
    "Vector terminal crash",
    `Version: ${input.version}`,
    `OS: ${input.os}`,
    `Terminal: ${input.terminal}`,
    "",
    input.message,
    "",
    input.stack,
  ].join("\n")
  return text.length > 8_000 ? `${text.slice(0, 7_980)}\n… (truncated)` : text
}

/** A short-lived local page transfers an editable draft without putting crash details in URLs. */
export function openCrashReportDraft(message: string) {
  const nonce = crypto.randomUUID()
  const pathname = `/report/${crypto.randomUUID()}`
  const page = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Review crash report · Vector</title><style nonce="${nonce}">
body{font:16px system-ui;background:#100d18;color:#f2eff7;max-width:680px;margin:60px auto;padding:24px;line-height:1.5}
textarea{box-sizing:border-box;width:100%;min-height:360px;padding:14px;background:#181221;color:inherit;border:1px solid #76638b;border-radius:8px;font:14px monospace}
button{padding:12px 18px;background:#9567e0;color:white;border:0;border-radius:8px;font:inherit;cursor:pointer}p{color:#c4bacf}
</style><h1>Review crash report</h1><p>This draft is still on your computer. Remove private details, then continue to Vector support to review and send it.</p>
<label for="report">Crash details</label><textarea id="report" maxlength="8000">${Bun.escapeHTML(message.slice(0, 8_000))}</textarea>
<p><button id="continue" type="button">Continue to Vector support</button></p><p id="status" role="status"></p>
<script nonce="${nonce}">
const button = document.querySelector('#continue');
const status = document.querySelector('#status');
button.addEventListener('click', () => {
  const popup = window.open('${supportReportUrl}', '_blank');
  if (!popup) { status.textContent = 'Allow the support window to open, then try again.'; return; }
  button.disabled = true;
  const ready = event => {
    if (event.source !== popup || event.origin !== 'https://vectordev.ai' || event.data?.type !== 'vector:support-ready') return;
    popup.postMessage({type:'vector:support-draft',message:document.querySelector('#report').value.slice(0,8000)}, 'https://vectordev.ai');
    window.removeEventListener('message', ready);
    clearTimeout(timeout);
    status.textContent = 'Your draft is open in Vector support. Review it there and choose Send report.';
    button.disabled = false;
  };
  window.addEventListener('message', ready);
  const timeout = setTimeout(() => { window.removeEventListener('message', ready); button.disabled = false; status.textContent = 'The support page did not respond. Try again, or copy the draft to the support form.'; }, 30000);
});
</script></html>`
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      const url = new URL(request.url)
      if (
        request.method !== "GET" ||
        url.host !== `127.0.0.1:${server.port}` ||
        request.headers.get("host") !== url.host ||
        url.pathname !== pathname ||
        url.search ||
        (request.headers.has("origin") && request.headers.get("origin") !== url.origin)
      )
        return new Response(null, { status: 404, headers: { "cache-control": "no-store" } })
      return new Response(page, {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "referrer-policy": "no-referrer",
          "x-content-type-options": "nosniff",
          "cross-origin-resource-policy": "same-origin",
          "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
        },
      })
    },
  })
  const timer = setTimeout(() => server.stop(true), 10 * 60_000)
  timer.unref()
  server.unref()
  return {
    url: `http://127.0.0.1:${server.port}${pathname}`,
    stop() {
      clearTimeout(timer)
      server.stop(true)
    },
  }
}
