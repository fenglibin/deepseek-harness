/**
 * OAuth grant storage for one MCP server. A grant is the token set an
 * authorization-code exchange returned, plus the bookkeeping needed to decide
 * whether it can still be used and how it may be renewed.
 *
 * Grants live in the credentials seam as a `GrantRecord`, never in the settings
 * document. Two properties of that seam decide this placement: `modifyRecord`
 * serializes read-modify-write across processes, so two Hosts rotating one
 * refresh token cannot lose a write; and `resolve` is specified per operation,
 * so a refreshed token reaches the next connection without a restart. Keeping
 * the grant out of settings also keeps it out of `mcp.json`, which is a
 * cross-vendor document no other platform should find a token in.
 * @module @deepseek-ai/dsh-mcp-manager/oauth-grant
 */

import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { CredentialKey, GrantRecord } from '@deepseek-ai/dsh-credentials'
import { credentialKey, isCredentialKeySegment } from '@deepseek-ai/dsh-credentials'

/** Scope segment identifying every MCP OAuth grant. */
const GRANT_SCOPE = 'mcp-oauth'

/** A token set as stored. `expiresAt` is an epoch-ms instant, absent when the server sent no expiry. */
export interface McpOAuthGrant {
  /** Bearer token presented to the MCP server. */
  readonly accessToken: string
  /** Token used to obtain a replacement access token; absent when the server issued none. */
  readonly refreshToken?: string
  /** Epoch milliseconds when accessToken stops being accepted; absent when unknown. */
  readonly expiresAt?: number
  /** Scopes the server actually granted, when it reported them. */
  readonly scopes?: readonly string[]
}

/**
 * The shape the digest branch produces. A literal server name that already
 * matches it is digested too, so the two branches below write into disjoint
 * output spaces and the mapping cannot fold two names together.
 */
const DIGEST_SLUG_PATTERN = /^mcp-[0-9a-f]{16}$/

/**
 * Map one server name onto a credentials-segment-safe id.
 *
 * `serverName` admits uppercase letters and underscores
 * (`[A-Za-z0-9_-]{1,32}`) while a credential key segment admits only
 * `[a-z][a-z0-9-]*`, so a name like `My_Server` needs translation.
 *
 * The mapping is injective, and that property is what keeps two servers from
 * sharing one grant. A name already inside the grammar passes through
 * unchanged; everything else becomes a digest of the exact original name.
 * Case folding or underscore rewriting would break injectivity — `My_Server`
 * and `my-server` are two distinct servers that such a rewrite would collapse
 * onto one grant, letting each overwrite the other's token — so a name is
 * either used verbatim or digested, never normalized.
 * @param serverName - the manager-side server namespace.
 * @returns a segment {@link credentialKey} accepts.
 */
export function grantIdOf(serverName: string): string {
  if (isCredentialKeySegment(serverName) && !DIGEST_SLUG_PATTERN.test(serverName)) return serverName
  const digest = createHash('sha256').update(serverName).digest('hex').slice(0, 16)
  return `mcp-${digest}`
}

/**
 * Build the credential key one server's grant is stored under.
 * @param serverName - the manager-side server namespace.
 * @returns the key {@link readGrant} and {@link writeGrant} address.
 */
export function grantKeyOf(serverName: string): CredentialKey {
  return credentialKey(GRANT_SCOPE, grantIdOf(serverName))
}

/** Read the grant record shape back out of the seam's opaque payload. */
function toGrant(payload: unknown): McpOAuthGrant | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const record = payload as Record<string, unknown>
  if (typeof record.accessToken !== 'string' || record.accessToken.length === 0) return undefined
  const grant: {
    accessToken: string
    refreshToken?: string
    expiresAt?: number
    scopes?: readonly string[]
  } = { accessToken: record.accessToken }
  if (typeof record.refreshToken === 'string' && record.refreshToken.length > 0) {
    grant.refreshToken = record.refreshToken
  }
  if (typeof record.expiresAt === 'number' && Number.isFinite(record.expiresAt)) {
    grant.expiresAt = record.expiresAt
  }
  if (Array.isArray(record.scopes)) {
    grant.scopes = record.scopes.filter((scope): scope is string => typeof scope === 'string')
  }
  return grant
}

/**
 * Store one server's grant through the credentials seam.
 * @param ctx - context carrying the `credentials` service.
 * @param serverName - the server the grant belongs to.
 * @param grant - the token set to persist.
 * @returns settlement after the record is written.
 * @throws when the credentials service is absent or refuses the write.
 */
export async function writeGrant(ctx: Context, serverName: string, grant: McpOAuthGrant): Promise<void> {
  const credentials = ctx.get('credentials')
  if (credentials === undefined) {
    throw new Error(`mcp-manager: cannot store the OAuth grant for "${serverName}" — no credentials service is available`)
  }
  const record: GrantRecord = { kind: 'grant', payload: { ...grant } }
  await credentials.modifyRecord(grantKeyOf(serverName), () => Promise.resolve(record))
}

/**
 * Read one server's stored grant.
 * @param ctx - context optionally carrying the `credentials` service.
 * @param serverName - the server whose grant to read.
 * @returns the grant, or undefined when none is stored, the payload is
 *   malformed, or no credentials service exists.
 */
export async function readGrant(ctx: Context, serverName: string): Promise<McpOAuthGrant | undefined> {
  const credentials = ctx.get('credentials')
  if (credentials === undefined) return undefined
  const record = await credentials.readRecord(grantKeyOf(serverName))
  if (record === undefined || record.kind !== 'grant') return undefined
  return toGrant(record.payload)
}

/**
 * Remove one server's grant; removing an absent grant is a no-op.
 * @param ctx - context optionally carrying the `credentials` service.
 * @param serverName - the server whose grant to remove.
 * @returns settlement after the record is gone.
 */
export async function deleteGrant(ctx: Context, serverName: string): Promise<void> {
  const credentials = ctx.get('credentials')
  if (credentials === undefined) return
  await credentials.deleteRecord(grantKeyOf(serverName))
}
