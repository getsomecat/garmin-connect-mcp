#!/usr/bin/env node

import { loadConfig } from '../src/config.js'
import { GarminClient } from '../src/garmin/client.js'

async function main(): Promise<void> {
  const client = new GarminClient(loadConfig())
  await client.connect()
  const token = await client.exportSession()
  process.stderr.write('Session token exported. Treat the stdout value as a password.\n')
  process.stdout.write(`${token}\n`)
}

main().catch((error: unknown) => {
  console.error('Failed to export Garmin session:', error instanceof Error ? error.message : error)
  process.exit(1)
})
