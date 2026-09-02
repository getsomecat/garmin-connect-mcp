#!/usr/bin/env node

import readline from 'node:readline'
import { loadConfig } from '../src/config.js'
import {
  getSessionProfileIdentity,
  isDiSessionToken,
  loginForSession,
  parseSessionToken,
  type GarminSessionToken,
} from '../src/garmin/auth.js'
import { GarminClient } from '../src/garmin/client.js'
import {
  acquireSessionLease,
  createBoundDiSession,
  defaultSessionTokenFile,
  explicitSessionTokenFile,
  readPrivateSessionFile,
  SessionFileMissingError,
  writePrivateSessionFile,
} from '../src/garmin/session-store.js'

interface Options {
  forceLogin: boolean
  stdout: boolean
  output?: string
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2))
  const config = loadConfig()
  if (!config.username) {
    throw new Error('GARMIN_USERNAME is required to bind a private DI session.')
  }

  const destination = options.output
    ? explicitSessionTokenFile(options.output)
    : config.sessionTokenFile
      ?? defaultSessionTokenFile()
  const lease = await acquireSessionLease(
    destination,
    config.username,
    config.region,
  )
  let client: GarminClient | undefined

  try {
    const sessionFileExists = await privateSessionExists(destination)
    let token: GarminSessionToken
    if (options.forceLogin || (!config.sessionToken && !sessionFileExists)) {
      if (!config.password) {
        throw new Error(
          'A new DI session requires GARMIN_PASSWORD. Set it temporarily, run the export, then remove it.',
        )
      }
      token = await loginForSession(
        config.username,
        config.password,
        config.region,
        promptMfa,
      )
    } else {
      client = new GarminClient({ ...config, sessionTokenFile: destination })
      await client.connect()
      token = parseSessionToken(await client.exportSession())
    }

    if (!isDiSessionToken(token)) {
      throw new Error(
        'The configured credential is a legacy OAuth session. Run again with --force-login to create a bound DI v2 session.',
      )
    }
    const profile = await getSessionProfileIdentity(token, config.region)
    const bound = createBoundDiSession(
      token,
      config.username,
      config.region,
      profile.profileId,
    )
    await writePrivateSessionFile(destination, bound)

    process.stderr.write(
      `Private Garmin DI session saved for region=${config.region}: ${destination}\n`,
    )
    process.stderr.write(
      'The file is username/region/profile bound and must not be shared by concurrent MCP processes. Remove GARMIN_PASSWORD after verification.\n',
    )
    if (options.stdout) {
      process.stderr.write('Warning: --stdout exposes the session credential. Treat it exactly like a password.\n')
      process.stdout.write(`${JSON.stringify(bound)}\n`)
    }
  } finally {
    await client?.close()
    await lease.release()
  }
}

async function privateSessionExists(path: string): Promise<boolean> {
  try {
    await readPrivateSessionFile(path)
    return true
  } catch (error) {
    if (error instanceof SessionFileMissingError) return false
    throw error
  }
}

function parseOptions(argv: string[]): Options {
  const options: Options = { forceLogin: false, stdout: false }
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === '--force-login') options.forceLogin = true
    else if (value === '--stdout') options.stdout = true
    else if (value === '--output') {
      const output = argv[index + 1]
      if (!output) throw new Error('--output requires an absolute path.')
      options.output = output
      index += 1
    } else {
      throw new Error(`Unknown option: ${value ?? ''}`)
    }
  }
  return options
}

async function promptMfa(method: string): Promise<string> {
  if (!process.stdin.isTTY) {
    throw new Error('MFA is required, but stdin is not interactive. Run the export script in a terminal.')
  }

  process.stderr.write(`MFA code required (${method}). Check your email, SMS, or authenticator app.\n`)
  const input = readline.createInterface({ input: process.stdin, output: process.stderr })
  try {
    return await new Promise<string>((resolve) => {
      input.question('MFA code: ', (answer) => resolve(answer.trim()))
    })
  } finally {
    input.close()
  }
}

main().catch((error: unknown) => {
  console.error('Failed to export Garmin session:', error instanceof Error ? error.message : error)
  process.exit(1)
})
