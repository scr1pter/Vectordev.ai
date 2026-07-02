const stage = process.env.SST_STAGE || "dev"

export default {
  url: stage === "production" ? "https://vectordev.ai" : `https://${stage}.vectordev.ai`,
  console: stage === "production" ? "https://vectordev.ai/auth" : `https://${stage}.vectordev.ai/auth`,
  email: "contact.astr0gpt@gmail.com",
  socialCard: "https://social-cards.sst.dev",
  github: "https://github.com/scr1pter/Vectordev.ai",
  discord: "https://vectordev.ai/community",
  headerLinks: [
    { name: "app.header.home", url: "/" },
  ],
}
