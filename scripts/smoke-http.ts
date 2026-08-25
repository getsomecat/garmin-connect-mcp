import { randomBytes } from 'node:crypto'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { loadConfig } from '../src/config.js'
import { startHttpServer } from '../src/http.js'

const token = randomBytes(32).toString('hex')
const config = {
  ...loadConfig({
    GARMIN_USERNAME: 'smoke-test',
    GARMIN_PASSWORD: 'smoke-test',
    MCP_TRANSPORT: 'http',
    MCP_BEARER_TOKEN: token,
  }),
  httpPort: 0,
}

const runtime = await startHttpServer(config)
const endpoint = new URL(`http://${runtime.host}:${runtime.port}${runtime.path}`)

try {
  const unauthorized = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 1 }),
  })
  if (unauthorized.status !== 401) {
    throw new Error(`Expected an unauthenticated request to return 401, received ${unauthorized.status}.`)
  }

  const client = new Client({ name: 'garmin-connect-mcp-smoke', version: '1.0.0' })
  const transport = new StreamableHTTPClientTransport(endpoint, {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  })
  // SDK 1.x transport declarations are not exactOptionalPropertyTypes-compatible.
  await client.connect(transport as unknown as Parameters<typeof client.connect>[0])
  const listed = await client.listTools()
  const expected = [
    'garmin_activities',
    'garmin_sleep',
    'garmin_steps',
    'garmin_heart_rate',
    'garmin_weight',
    'garmin_workouts',
    'garmin_profile',
    'garmin_hrv',
    'garmin_body_battery',
    'garmin_training_readiness',
    'garmin_training_status',
    'garmin_vo2max',
  ]
  const actual = listed.tools.map((tool) => tool.name)
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Unexpected tools: ${actual.join(', ')}`)
  }
  await client.close()
  console.log(`HTTP smoke test passed with ${actual.length} tools.`)
} finally {
  await runtime.close()
}
