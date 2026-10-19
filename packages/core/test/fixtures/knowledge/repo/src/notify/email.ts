const host = process.env.SMTP_HOST ?? "localhost"

export async function sendEmail(to: string, body: string) {
  for (const attempt of [1, 2, 3]) {
    if (await deliver(host, to, body)) return attempt
  }
  return 0
}

async function deliver(server: string, to: string, body: string) {
  return server.length > 0 && to.length > 0 && body.length > 0
}
