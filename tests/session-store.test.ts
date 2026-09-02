import assert from 'node:assert/strict'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import test from 'node:test'
import type { GarminDiSessionToken } from '../src/garmin/auth.js'
import {
  assertBoundSessionAccount,
  assertBoundSessionProfile,
  createBoundDiSession,
  defaultSessionTokenFile,
  readPrivateSessionFile,
  updateBoundDiSession,
  writePrivateSessionFile,
} from '../src/garmin/session-store.js'

const username = 'Runner@example.com'
const profileId = 123456

test('default session path is single-user and has no account alias or region suffix', () => {
  const path = defaultSessionTokenFile({ XDG_CONFIG_HOME: join(tmpdir(), 'config-root') })
  assert.equal(basename(path), 'session.json')
  assert.equal(basename(dirname(path)), 'garmin-connect-mcp')
  assert.equal(path.includes(`${join('garmin-connect-mcp', 'accounts')}`), false)
})

test('bound DI session verifies username, region, and Garmin profile identity', () => {
  const session = createBoundDiSession(token('access-one', 'refresh-one'), username, 'cn', profileId)
  assert.doesNotThrow(() => assertBoundSessionAccount(session, 'runner@example.com', 'cn'))
  assert.doesNotThrow(() => assertBoundSessionProfile(session, profileId))
  assert.throws(() => assertBoundSessionAccount(session, 'other@example.com', 'cn'))
  assert.throws(() => assertBoundSessionAccount(session, username, 'global'))
  assert.throws(() => assertBoundSessionProfile(session, profileId + 1))
  assert.equal('alias' in session.account, false)
})

test('private session writes atomically with owner-only permissions and preserves binding on refresh', async () => {
  const root = await mkdtemp(join(tmpdir(), 'garmin-session-test-'))
  const path = join(root, 'private', 'session.json')
  try {
    const initial = createBoundDiSession(token('access-one', 'refresh-one'), username, 'global', profileId)
    await writePrivateSessionFile(path, initial)

    const info = await stat(path)
    if (process.platform !== 'win32') assert.equal(info.mode & 0o777, 0o600)
    const loaded = await readPrivateSessionFile(path)
    assert.ok(loaded.boundFile)
    assertBoundSessionAccount(loaded.boundFile, username, 'global')
    assertBoundSessionProfile(loaded.boundFile, profileId)

    const refreshed = updateBoundDiSession(
      loaded.boundFile,
      token('access-two', 'refresh-two'),
    )
    await writePrivateSessionFile(path, refreshed)
    const reloaded = await readPrivateSessionFile(path)
    assert.equal(reloaded.boundFile?.tokens.accessToken, 'access-two')
    assert.deepEqual(reloaded.boundFile?.account, initial.account)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

function token(accessToken: string, refreshToken: string): GarminDiSessionToken {
  const now = Math.floor(Date.now() / 1_000)
  return {
    auth_type: 'di',
    version: 2,
    access_token: accessToken,
    refresh_token: refreshToken,
    client_id: 'garmin-connect-mcp-test',
    expires_at: now + 3_600,
    refresh_token_expires_at: now + 86_400,
    token_type: 'Bearer',
  }
}
