/** @jsxImportSource react */
import { LoaderCircle } from "lucide-react"
import { useEffect, useState } from "react"
import { safeReturnPath, vectorAccountClient } from "../../../lib/account-client"
import "./account.css"

export function AuthCallback() {
  const [error, setError] = useState("")

  useEffect(() => {
    const parameters = new URLSearchParams(location.search)
    const returnTo = safeReturnPath(parameters.get("returnTo"))
    const code = parameters.get("code")
    void vectorAccountClient()
      .then(async (client) => {
        if (code) {
          const exchange = await client.auth.exchangeCodeForSession(code)
          if (exchange.error) throw exchange.error
        }
        const session = await client.auth.getSession()
        if (session.error) throw session.error
        if (!session.data.session) throw new Error("Vector could not finish signing you in.")
        location.replace(returnTo)
      })
      .catch((cause) => setError(cause instanceof Error ? cause.message : "Vector could not finish signing you in."))
  }, [])

  return (
    <main className="callback-page">
      <section className="callback-card">
        {error ? (
          <>
            <h1>Sign-in needs another try.</h1>
            <p>{error}</p>
            <a href="/login">Return to sign in</a>
          </>
        ) : (
          <>
            <LoaderCircle className="callback-spinner" size={30} />
            <h1>Opening your Vector account…</h1>
            <p>Finishing the secure handoff.</p>
          </>
        )}
      </section>
    </main>
  )
}
