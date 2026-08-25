import { ApiClient, type VerifiedAccessTokenClaims } from '@auth0/auth0-api-js'
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js'
import type { Auth0Config } from '../config.js'

export class Auth0AccessTokenVerifier {
  private readonly client: ApiClient

  constructor(private readonly config: Auth0Config, customFetch?: typeof fetch) {
    this.client = new ApiClient({
      domain: config.domain,
      audience: config.audience,
      algorithms: ['RS256'],
      dpop: { mode: 'disabled' },
      ...(customFetch ? { customFetch } : {}),
    })
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const claims = await this.client.verifyAccessToken({
      accessToken: token,
      requiredClaims: ['sub'],
      algorithms: ['RS256'],
      scheme: 'bearer',
    })
    return authInfoFromClaims(token, claims, this.config)
  }
}

function authInfoFromClaims(
  token: string,
  claims: VerifiedAccessTokenClaims,
  config: Auth0Config,
): AuthInfo {
  const subject = stringClaim(claims.sub)
  if (!subject) throw new Error('The Auth0 access token has no subject.')
  if (config.allowedSubjects.length > 0 && !config.allowedSubjects.includes(subject)) {
    throw new Error('The Auth0 subject is not allowed to access this private MCP server.')
  }

  const scopes = new Set<string>()
  addSpaceSeparatedClaim(scopes, claims.scope)
  addStringArrayClaim(scopes, claims.permissions)

  const clientId = stringClaim(claims.client_id)
    ?? stringClaim(claims.azp)
    ?? subject
  const expiresAt = finiteNumber(claims.exp)

  return {
    token,
    clientId,
    scopes: [...scopes],
    resource: new URL(config.publicUrl.href),
    ...(expiresAt === undefined ? {} : { expiresAt }),
  }
}

function addSpaceSeparatedClaim(target: Set<string>, value: unknown): void {
  if (typeof value !== 'string') return
  for (const item of value.split(/\s+/).filter(Boolean)) target.add(item)
}

function addStringArrayClaim(target: Set<string>, value: unknown): void {
  if (!Array.isArray(value)) return
  for (const item of value) {
    if (typeof item === 'string' && item) target.add(item)
  }
}

function stringClaim(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}
