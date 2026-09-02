import { createHash, randomUUID } from 'node:crypto'
import { constants, unlinkSync } from 'node:fs'
import {
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  unlink,
} from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import type { GarminRegion } from '../config.js'
import {
  parseSessionToken,
  type GarminDiSessionToken,
  type GarminSessionToken,
} from './auth.js'

const MAX_SESSION_FILE_BYTES = 1024 * 1024
const MAX_TOKEN_BYTES = 16 * 1024
export interface BoundDiSessionFile {
  kind: 'di-oauth'
  schemaVersion: 2
  clientId: string
  tokens: {
    accessToken: string
    refreshToken: string
    accessExpiresAtMs: number
    refreshExpiresAtMs: number | null
  }
  account: {
    region: GarminRegion
    usernameHash: string
    profileIdHash: string
  }
}

export interface LoadedSession {
  token: GarminSessionToken
  boundFile?: BoundDiSessionFile
}

export interface SessionLease {
  path: string
  release(): Promise<void>
}

interface LeaseEntry {
  binding: string
  lockPath: string
  refs: number
}

const leases = new Map<string, LeaseEntry>()
let exitCleanupInstalled = false

export class SessionFileMissingError extends Error {
  override name = 'SessionFileMissingError'
}

export function defaultSessionTokenFile(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const root = env.XDG_CONFIG_HOME?.trim()
    || env.LOCALAPPDATA?.trim()
    || env.APPDATA?.trim()
    || join(env.HOME?.trim() || homedir(), '.config')
  return resolve(root, 'garmin-connect-mcp', 'session.json')
}

export function explicitSessionTokenFile(value: string): string {
  if (!isAbsolute(value)) {
    throw new Error('GARMIN_SESSION_TOKEN_FILE must be an absolute path.')
  }
  return resolve(value)
}

export function createBoundDiSession(
  token: GarminDiSessionToken,
  username: string,
  region: GarminRegion,
  profileId: number,
): BoundDiSessionFile {
  if (!validProfileId(profileId)) {
    throw new Error('Garmin profile identity is missing or invalid; the session was not saved.')
  }
  return {
    kind: 'di-oauth',
    schemaVersion: 2,
    clientId: token.client_id,
    tokens: {
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      accessExpiresAtMs: secondsToMilliseconds(token.expires_at),
      refreshExpiresAtMs: token.refresh_token_expires_at === undefined
        ? null
        : secondsToMilliseconds(token.refresh_token_expires_at),
    },
    account: {
      region,
      usernameHash: usernameHash(username),
      profileIdHash: profileIdHash(profileId),
    },
  }
}

export function updateBoundDiSession(
  current: BoundDiSessionFile,
  token: GarminDiSessionToken,
): BoundDiSessionFile {
  const candidate: BoundDiSessionFile = {
    kind: 'di-oauth',
    schemaVersion: 2,
    clientId: token.client_id,
    tokens: {
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      accessExpiresAtMs: secondsToMilliseconds(token.expires_at),
      refreshExpiresAtMs: token.refresh_token_expires_at === undefined
        ? current.tokens.refreshExpiresAtMs
        : secondsToMilliseconds(token.refresh_token_expires_at),
    },
    account: {
      region: current.account.region,
      usernameHash: current.account.usernameHash,
      profileIdHash: current.account.profileIdHash,
    },
  }
  if (!isBoundDiSessionFile(candidate)) {
    throw new Error('Refreshed Garmin DI session is invalid and was not persisted.')
  }
  return candidate
}

export function tokenFromBoundDiSession(file: BoundDiSessionFile): GarminDiSessionToken {
  return {
    auth_type: 'di',
    version: 2,
    access_token: file.tokens.accessToken,
    refresh_token: file.tokens.refreshToken,
    client_id: file.clientId,
    expires_at: millisecondsToSeconds(file.tokens.accessExpiresAtMs),
    ...(file.tokens.refreshExpiresAtMs === null
      ? {}
      : { refresh_token_expires_at: millisecondsToSeconds(file.tokens.refreshExpiresAtMs) }),
    token_type: 'Bearer',
  }
}

export function assertBoundSessionAccount(
  file: BoundDiSessionFile,
  username: string,
  region: GarminRegion,
): void {
  if (
    file.account.region !== region
    || file.account.usernameHash !== usernameHash(username)
  ) {
    throw new Error('Garmin DI session file does not match GARMIN_USERNAME or GARMIN_REGION.')
  }
}

export function assertBoundSessionProfile(file: BoundDiSessionFile, profileId: number): void {
  if (!validProfileId(profileId) || file.account.profileIdHash !== profileIdHash(profileId)) {
    throw new Error('Garmin DI session does not match the authenticated Garmin profile.')
  }
}

export async function readPrivateSessionFile(path: string): Promise<LoadedSession> {
  const destination = resolve(path)
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    await assertPrivateParent(dirname(destination))
    await assertPrivateFile(destination)
    const flags = process.platform === 'win32'
      ? constants.O_RDONLY
      : constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    handle = await open(destination, flags)
    const info = await handle.stat()
    if (!info.isFile() || info.size > MAX_SESSION_FILE_BYTES) {
      throw new Error('Garmin session file is not a bounded regular file.')
    }
    const source = await handle.readFile('utf8')
    const parsed = JSON.parse(source) as unknown
    if (isBoundDiSessionFile(parsed)) {
      return { token: tokenFromBoundDiSession(parsed), boundFile: parsed }
    }
    return { token: parseSessionToken(JSON.stringify(parsed)) }
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) throw new SessionFileMissingError()
    if (error instanceof SessionFileMissingError) throw error
    throw new Error(`Garmin session file could not be read safely: ${safeErrorMessage(error)}`)
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

export async function writePrivateSessionFile(
  path: string,
  session: BoundDiSessionFile,
): Promise<void> {
  if (!isBoundDiSessionFile(session)) throw new Error('Garmin DI session file is invalid.')
  const serialized = JSON.stringify(session)
  if (Buffer.byteLength(serialized, 'utf8') > MAX_SESSION_FILE_BYTES) {
    throw new Error('Garmin DI session file is too large.')
  }

  const destination = resolve(path)
  const parent = dirname(destination)
  await ensurePrivateParent(parent)
  await assertSafeExistingDestination(destination)
  const temporaryPath = join(parent, `.${basename(destination)}.${process.pid}.${randomUUID()}.tmp`)
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    const flags = process.platform === 'win32'
      ? 'wx'
      : constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW
    handle = await open(temporaryPath, flags, 0o600)
    await handle.writeFile(serialized, 'utf8')
    await handle.sync()
    await handle.close()
    handle = undefined
    await assertPrivateFile(temporaryPath)
    await assertPrivateParent(parent)
    await assertSafeExistingDestination(destination)
    await rename(temporaryPath, destination)
  } catch (error) {
    await handle?.close().catch(() => undefined)
    await unlink(temporaryPath).catch(() => undefined)
    throw new Error(`Garmin DI session file could not be written safely: ${safeErrorMessage(error)}`)
  }
}

export async function acquireSessionLease(
  path: string,
  username: string,
  region: GarminRegion,
): Promise<SessionLease> {
  const destination = resolve(path)
  const binding = [region, usernameHash(username)].join(':')
  const existing = leases.get(destination)
  if (existing) {
    if (existing.binding !== binding) {
      throw new Error('One process cannot reuse the Garmin session path with another username or region.')
    }
    existing.refs += 1
    return leaseHandle(destination, existing)
  }

  await ensurePrivateParent(dirname(destination))
  const lockPath = `${destination}.lock`
  const lock = { pid: process.pid, binding, createdAt: new Date().toISOString() }
  await createOrRecoverLock(lockPath, lock)
  const entry: LeaseEntry = { binding, lockPath, refs: 1 }
  leases.set(destination, entry)
  installExitCleanup()
  return leaseHandle(destination, entry)
}

function leaseHandle(destination: string, entry: LeaseEntry): SessionLease {
  let released = false
  return {
    path: destination,
    async release() {
      if (released) return
      released = true
      entry.refs -= 1
      if (entry.refs > 0 || leases.get(destination) !== entry) return
      leases.delete(destination)
      await unlink(entry.lockPath).catch(() => undefined)
    },
  }
}

async function createOrRecoverLock(
  lockPath: string,
  lock: { pid: number; binding: string; createdAt: string },
): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let handle: Awaited<ReturnType<typeof open>> | undefined
    try {
      handle = await open(lockPath, 'wx', 0o600)
      await handle.writeFile(JSON.stringify(lock), 'utf8')
      await handle.sync()
      return
    } catch (error) {
      if (!isNodeError(error, 'EEXIST')) throw error
      const existing = await readExistingLock(lockPath)
      if (existing.pid === process.pid && existing.binding === lock.binding) return
      if (processIsAlive(existing.pid)) {
        throw new Error(
          'Garmin session file is already in use by another running process. Stop that process before starting this one.',
        )
      }
      await assertPrivateFile(lockPath)
      await unlink(lockPath)
    } finally {
      await handle?.close().catch(() => undefined)
    }
  }
  throw new Error('Garmin session process lock could not be acquired.')
}

async function readExistingLock(lockPath: string): Promise<{ pid: number; binding: string }> {
  await assertPrivateFile(lockPath)
  const source = await readFile(lockPath, 'utf8')
  const value = JSON.parse(source) as Record<string, unknown>
  if (!Number.isSafeInteger(value.pid) || Number(value.pid) <= 0 || typeof value.binding !== 'string') {
    throw new Error('Garmin session process lock is invalid; inspect it manually before retrying.')
  }
  return { pid: Number(value.pid), binding: value.binding }
}

function processIsAlive(pid: number): boolean {
  if (pid === process.pid) return true
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return !isNodeError(error, 'ESRCH')
  }
}

function installExitCleanup(): void {
  if (exitCleanupInstalled) return
  exitCleanupInstalled = true
  process.once('exit', () => {
    for (const entry of leases.values()) {
      try {
        unlinkSync(entry.lockPath)
      } catch {
        // Best-effort cleanup; stale owner-only locks are recovered on next start.
      }
    }
  })
}

async function ensurePrivateParent(parent: string): Promise<void> {
  await mkdir(parent, { recursive: true, mode: 0o700 })
  await assertPrivateParent(parent)
}

async function assertPrivateParent(parent: string): Promise<void> {
  const info = await lstat(parent)
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error('Session parent must be a real directory.')
  }
  if (process.platform !== 'win32') {
    const uid = typeof process.geteuid === 'function' ? process.geteuid() : undefined
    if ((uid !== undefined && info.uid !== uid) || (info.mode & 0o077) !== 0) {
      throw new Error('Session parent must be owned by the service user with mode 0700.')
    }
  }
}

async function assertPrivateFile(path: string): Promise<void> {
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
    throw new Error('Session path must be a non-linked regular file.')
  }
  if (process.platform !== 'win32') {
    const uid = typeof process.geteuid === 'function' ? process.geteuid() : undefined
    if ((uid !== undefined && info.uid !== uid) || (info.mode & 0o077) !== 0) {
      throw new Error('Session file must be owned by the service user with mode 0600.')
    }
  }
}

async function assertSafeExistingDestination(path: string): Promise<void> {
  try {
    await assertPrivateFile(path)
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return
    throw error
  }
}

function isBoundDiSessionFile(value: unknown): value is BoundDiSessionFile {
  if (!isRecord(value) || value.kind !== 'di-oauth' || value.schemaVersion !== 2) return false
  if (typeof value.clientId !== 'string' || !/^[A-Za-z0-9_-]{3,128}$/.test(value.clientId)) return false
  if (!isRecord(value.tokens) || !isRecord(value.account)) return false
  return boundedOpaqueToken(value.tokens.accessToken)
    && boundedOpaqueToken(value.tokens.refreshToken)
    && positiveTimestamp(value.tokens.accessExpiresAtMs)
    && (value.tokens.refreshExpiresAtMs === null || positiveTimestamp(value.tokens.refreshExpiresAtMs))
    && (value.account.region === 'global' || value.account.region === 'cn')
    && sha256Digest(value.account.usernameHash)
    && sha256Digest(value.account.profileIdHash)
}

function boundedOpaqueToken(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && Buffer.byteLength(value, 'utf8') <= MAX_TOKEN_BYTES
    && /^[\x21-\x7e]+$/.test(value)
}

function sha256Digest(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
}

function positiveTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function usernameHash(username: string): string {
  const normalized = username.trim().normalize('NFKC').toLowerCase()
  if (!normalized) throw new Error('GARMIN_USERNAME is required for a bound DI session.')
  return createHash('sha256').update(normalized).digest('hex')
}

function profileIdHash(profileId: number): string {
  return createHash('sha256').update(`garmin-profile-id:v1:${profileId}`).digest('hex')
}

function validProfileId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function secondsToMilliseconds(value: number): number {
  const result = value * 1_000
  if (!Number.isSafeInteger(result) || result <= 0) throw new Error('Garmin token expiry is invalid.')
  return result
}

function millisecondsToSeconds(value: number): number {
  return Math.floor(value / 1_000)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isNodeError(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error'
}
