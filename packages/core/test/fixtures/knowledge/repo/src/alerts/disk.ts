import * as mail from "../notify/email"

export async function diskFull(owner: string) {
  return mail.sendEmail(owner, "disk full")
}
