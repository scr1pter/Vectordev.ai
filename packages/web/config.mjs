const stage = process.env.SST_STAGE || "dev"
const isProduction =
  stage === "production" || process.env.VERCEL_ENV === "production" || process.env.NODE_ENV === "production"

export default {
  url: isProduction ? "https://vectordev.ai" : `https://${stage}.vectordev.ai`,
  console: isProduction ? "https://vectordev.ai/auth" : `https://${stage}.vectordev.ai/auth`,
  email: "contact.astr0gpt@gmail.com",
  socialCard: "https://social-cards.sst.dev",
  github: "https://github.com/scr1pter/Vectordev.ai",
  discord: "https://github.com/scr1pter/Vectordev.ai",
  headerLinks: [
    { name: "app.header.home", url: "/" },
  ],
}
