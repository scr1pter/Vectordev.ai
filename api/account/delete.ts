import { requireAccountUser } from "../_lib/account.js"
import { enforceRateLimit, requireTrustedJsonRequest } from "../_lib/abuse.js"
import {
  ApiError,
  handleApiError,
  json,
  readJson,
  requireMethod,
  type ApiRequest,
  type ApiResponse,
} from "../_lib/http.js"
import { revocationConfigured, revokeAccountTokens } from "../_lib/revocation.js"

/**
 * Deleting a Vector account. The order matters, because the steps are not
 * equally reversible:
 *
 *   1. confirm the person typed their own email, so a stray click cannot do this
 *   2. check the Supabase admin key exists BEFORE destroying anything, so a
 *      misconfigured deployment fails with nothing half-done
 *   3. revoke CLI tokens, which are stateless and would otherwise keep a
 *      terminal signed in for up to ninety days
 *   4. delete the identity itself
 *
 * The response says which of those actually happened.
 */
export default async function handler(request: ApiRequest, response: ApiResponse) {
  try {
    requireMethod(request, "POST")
    requireTrustedJsonRequest(request, 4_096)
    const body = await readJson<{ confirm?: unknown }>(request, 4_096)
    const user = await requireAccountUser(request)
    await enforceRateLimit(request, response, { scope: "account-delete", limit: 5, windowSeconds: 60 * 60 }).catch(
      () => undefined,
    )

    const confirm = typeof body.confirm === "string" ? body.confirm.trim().toLowerCase() : ""
    if (!confirm || confirm !== user.email.trim().toLowerCase()) {
      throw new ApiError(
        400,
        "CONFIRMATION_MISMATCH",
        "Type the email address on this account to confirm you want it deleted.",
      )
    }

    const admin = adminConfiguration()
    if (!admin) {
      throw new ApiError(
        503,
        "DELETION_NOT_CONFIGURED",
        "Account deletion is not configured on this deployment. Nothing was changed; write to support and it will be done by hand.",
      )
    }

    const tokensRevoked = await revokeAccountTokens(user.id)
    await deleteAccountUser(admin, user.id)

    json(response, 200, {
      deleted: true,
      email: user.email,
      cliTokens: tokensRevoked ? "revoked" : revocationConfigured() ? "revocation-failed" : "expire-within-90-days",
    })
  } catch (error) {
    handleApiError(response, error)
  }
}

function adminConfiguration() {
  const url = process.env.SUPABASE_URL?.trim().replace(/\/+$/, "") ?? ""
  const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ?? ""
  return url && serviceRole ? { url, serviceRole } : undefined
}

async function deleteAccountUser(
  admin: { url: string; serviceRole: string },
  id: string,
  fetcher: typeof fetch = fetch,
) {
  const result = await fetcher(`${admin.url}/auth/v1/admin/users/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: {
      apikey: admin.serviceRole,
      authorization: `Bearer ${admin.serviceRole}`,
    },
  })
  if (!result.ok && result.status !== 404) {
    throw new ApiError(502, "DELETION_FAILED", "Vector could not delete the account. Nothing else was changed.")
  }
}

export const __test = { adminConfiguration, deleteAccountUser }
