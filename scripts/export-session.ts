#!/usr/bin/env node

import readline from 'node:readline'
import { loadConfig } from '../src/config.js'
import { loginForSession } from '../src/garmin/auth.js'
import { GarminClient } from '../src/garmin/client.js'

async function main(): Promise<void> {
  const config = loadConfig()
  let token: string

  if (!config.sessionToken && config.username && config.password) {
    const session = await loginForSession(config.username, config.password, config.region, promptMfa)
    token = JSON.stringify(session)
  } else {
    const client = new GarminClient(config)
    await client.connect()
    token = await client.exportSession()
  }

  process.stderr.write('Session token exported. Treat the stdout value as a password.\n')
  process.stdout.write(`${token}\n`)
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
