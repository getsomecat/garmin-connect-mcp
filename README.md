# Garmin Connect MCP Server

A read-only [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server for Garmin Connect. It exposes activities, daily health data, HRV, Body Battery, training readiness and recovery, training load and status, VO2 max, workouts, profile data, and guarded running-coaching guidance to Codex and other MCP clients. It supports local stdio and private Streamable HTTP deployments with static bearer, Auth0, or a built-in single-user OAuth 2.1 fallback.

It is written in TypeScript with the MCP SDK, `garmin-connect`, and `dotenv`. It has no DeepSeek Harness or Cordis dependency.

> `garmin-connect` uses Garmin's unofficial web APIs. Endpoints can change without notice, and Garmin may rate-limit automated access.

## Deployment tutorial

For a complete walkthrough starting with your own VPS and domain—including DNS/HTTPS, an optional existing Hexo/Nginx site, Garmin China or global regions, a bound private DI session, Auth0 OAuth, the distinct ChatGPT and Codex CIMD clients, thirteen-tool verification, Cloudflare notes, troubleshooting, and rollback—see the [Chinese deployment guide](docs/deployment-guide.zh-CN.md).

## Tools

| Tool | Purpose |
|---|---|
| `garmin_activities` | Recent activities with compact normalized metrics or full raw detail |
| `garmin_sleep` | Sleep score, duration, and stages for one date or a range |
| `garmin_steps` | Daily step totals for one date or a range |
| `garmin_heart_rate` | Resting, minimum, and maximum heart rate |
| `garmin_weight` | Weight and body-composition data |
| `garmin_workouts` | Planned workouts saved in Garmin Connect |
| `garmin_profile` | Compact user profile summary |
| `garmin_hrv` | Nightly HRV, seven-day average, personal baseline, and status |
| `garmin_body_battery` | Body Battery level, charge/drain, and optional intraday samples |
| `garmin_training_readiness` | Readiness score, recovery time, and contributing factors |
| `garmin_training_status` | Training status, acute/chronic load, ACWR, load balance, and VO2 max |
| `garmin_vo2max` | Running/cycling VO2 max history with a current-value fallback |
| `garmin_running_advice` | Explain eight workout types and Hansons, Daniels, Norwegian-threshold, and polarized training; personalized mode requires a complete intake and safety gate |

All tools are read-only. Date ranges are inclusive and limited to 31 days.

Training metrics require a compatible Garmin device and enough synced history. A valid request can therefore return `hasData: false` or null metric fields when Garmin Connect has not calculated that value. `garmin_body_battery` returns compact daily summaries by default; set `include_samples` to `true` for one date to include its intraday series.

Example requests:

- “Compare my HRV, Body Battery, and training readiness over the last seven days.”
- “Show my acute and chronic load, workload ratio, training status, and recovery time.”
- “Analyze my running VO2 max trend for the last 30 days.”
- “Explain how Daniels and polarized training differ; do not make me a plan yet.”
- “After completing the safety intake, suggest a conservative approach for my next race.”

`garmin_running_advice` has two modes. `explain` returns educational material without pretending it is a personal plan. `personalized` first requires the athlete's goal, current-performance basis, training history, availability, health/recovery constraints, warning-symptom answer, load preference, quality-session ceiling, and intensity-guidance preference. Missing or contradictory fields produce focused follow-up questions instead of guessed training. Reported chest discomfort, unusual breathlessness with mild activity, fainting/dizziness, or abnormal palpitations stop the coaching response before Garmin activities are read. The tool does not diagnose or replace medical care.

## Requirements

- Node.js 20 or newer
- A Garmin Connect account

## Install and build

```bash
git clone https://github.com/getsomecat/garmin-connect-mcp.git
cd garmin-connect-mcp
npm install
npm run build
```

Copy the environment template:

```bash
cp .env.example .env
```

Set `GARMIN_USERNAME` and `GARMIN_REGION`. Set `GARMIN_PASSWORD` only for the initial interactive session export, then remove it. The recommended runtime credential is the private session file created in the next section.

For Garmin China accounts, set `GARMIN_REGION=cn`. The default is `global`.

## Create the private Garmin session

Session export is intentionally a local script, not an MCP tool, so a model cannot request or reveal the credential.

1. Put `GARMIN_USERNAME`, `GARMIN_PASSWORD`, and the correct `GARMIN_REGION` in `.env`.
2. Run:

```bash
umask 077
npm run --silent export-session
```

If Garmin requires multi-factor authentication, the script prompts for the one-time code sent by email, SMS, or your authenticator app. The code is used only for that login.

3. The script writes `~/.config/garmin-connect-mcp/session.json` by default. Set the absolute `GARMIN_SESSION_TOKEN_FILE` path or pass `--output /absolute/path/session.json` when the service needs another location.
4. Remove `GARMIN_PASSWORD`. Keep `GARMIN_USERNAME` and `GARMIN_REGION`; their normalized identity is part of the file binding.

The file is mode `0600` inside a mode `0700` directory, is atomically replaced after refresh, and is bound to the normalized Garmin username, region, and authenticated Garmin profile ID. A process lock prevents two server processes from mutating the same single-user session concurrently. The server has no account selector or multi-user mode. The session remains equivalent to a password: do not commit it, paste it into a chat, or include it in logs. `--stdout` exists only as an explicit legacy migration escape hatch and exposes the credential.

To migrate an existing inline DI session without logging in again, temporarily configure all of `GARMIN_USERNAME`, `GARMIN_REGION`, `GARMIN_SESSION_TOKEN_FILE`, and the existing `GARMIN_SESSION_TOKEN`/`GARMIN_SESSION_TOKEN_B64`. After one successful Garmin tool call creates and validates the private file, remove the inline token and restart. Legacy OAuth1 sessions cannot be converted this way; create a new DI session with `--force-login`.

## Codex MCP configuration

Codex supports both local stdio servers and remote Streamable HTTP servers. The ChatGPT desktop app, Codex CLI, and IDE extension share the MCP configuration for the same Codex host.

### Local stdio

Put the server in `~/.codex/config.toml` or a trusted project's `.codex/config.toml`. Build the project first, then add an entry using absolute paths:

```toml
[mcp_servers.garmin_connect]
command = "node"
args = ["/absolute/path/to/garmin-connect-mcp/dist/src/index.js"]
cwd = "/absolute/path/to/garmin-connect-mcp"
startup_timeout_sec = 20
tool_timeout_sec = 120
```

The `cwd` lets `dotenv` load the repository's `.env`. Alternatively, keep credentials in the environment that launches Codex and explicitly forward them:

```toml
[mcp_servers.garmin_connect]
command = "node"
args = ["/absolute/path/to/garmin-connect-mcp/dist/src/index.js"]
env_vars = ["GARMIN_USERNAME", "GARMIN_SESSION_TOKEN_FILE", "GARMIN_REGION"]
```

Restart Codex after editing the configuration, then use `/mcp` or the MCP server settings to confirm the server is connected.

### Remote OAuth from a VPS

After deploying the HTTPS endpoint and Auth0 configuration below, add and authenticate it from a normal local terminal:

```bash
codex mcp add garmin_connect --url https://garmin.example.com/mcp
codex mcp login garmin_connect --oauth-client-registration cimd --scopes garmin:read
codex mcp list
```

The expected final status is `enabled` with `Auth` set to `OAuth`. You can instead use the desktop UI: add a **Streamable HTTP** MCP server with the same URL, save, restart, and select **Authenticate**.

Codex uses a server-specific CIMD client such as `https://chatgpt.com/oauth/codex/<callback_id>/client.json`. It is not the same client as a hosted ChatGPT plugin. If Auth0 reports `Unknown client`, copy the exact CIMD URL from the error or authorization request, import it in Auth0 with **Create Application → Import from URL**, grant that application user-delegated `garmin:read`, and run the login command again. The browser may close after the loopback callback; use the terminal success message and `codex mcp list` as the result.

See the [official Codex MCP documentation](https://developers.openai.com/codex/extend/mcp) for the current UI, CLI, OAuth, CIMD, and callback behavior.

## Other MCP clients

Use the same stdio command:

```json
{
  "mcpServers": {
    "garmin-connect": {
      "command": "node",
      "args": ["/absolute/path/to/garmin-connect-mcp/dist/src/index.js"],
      "cwd": "/absolute/path/to/garmin-connect-mcp"
    }
  }
}
```

## Private Streamable HTTP deployment

The HTTP transport is intended to run behind an HTTPS reverse proxy. It is stateless at the MCP layer and uses JSON responses. Configure a static bearer token, exactly one OAuth option, or a static token plus one OAuth option. Codex can use the same OAuth deployment as ChatGPT; the independent static token remains available as an optional fallback for clients that need it.

If you want the static-bearer fallback, generate an independent MCP bearer token (this is not the Garmin session token):

```bash
openssl rand -hex 32
```

Configure the server environment:

```dotenv
MCP_TRANSPORT=http
MCP_HTTP_HOST=127.0.0.1
MCP_HTTP_PORT=3100
MCP_HTTP_PATH=/mcp
MCP_BEARER_TOKEN=the-generated-bearer-token
```

Omit `MCP_BEARER_TOKEN` for an OAuth-only deployment.

Build and start it:

```bash
npm ci
npm run build
npm start
```

Keep the Node.js listener on loopback and expose only the HTTPS reverse proxy. Example systemd and Nginx snippets are provided in `deploy/systemd` and `deploy/nginx`.

On the Codex client, keep the bearer token in an environment variable and reference it from `~/.codex/config.toml`:

```toml
[mcp_servers.garmin_connect]
url = "https://garmin.example.com/mcp"
bearer_token_env_var = "GARMIN_MCP_BEARER_TOKEN"
startup_timeout_sec = 20
tool_timeout_sec = 120
```

The client environment variable must contain the same independent bearer token:

```bash
export GARMIN_MCP_BEARER_TOKEN='the-generated-bearer-token'
```

Do not use the Garmin session token as the HTTP bearer token. Do not expose the Node.js port publicly, put secrets in Nginx configuration, or deploy the HTTP transport without HTTPS.

## Private ChatGPT and Codex access with OAuth

Remote connections that access personal Garmin data should use OAuth. Auth0 is the recommended authorization server: it handles login, discovery, client metadata, PKCE, token issuance, signing-key rotation, and account security independently of the Garmin MCP process. The MCP server validates Auth0 access tokens locally against the tenant's RS256 JWKS, requires `garmin:read`, binds the token to the exact MCP resource, and can restrict access to specific Auth0 subject IDs.

### Recommended: Auth0

1. Create or select a private [Auth0 tenant](https://manage.auth0.com/). In the tenant settings, enable:

   - **Resource Parameter Compatibility Profile**
   - **Include Issuer in Authorization Responses**
   - **Client ID Metadata Document Registration**

2. In **Applications → APIs**, create an API with:

   - Identifier: the exact public MCP URL, for example `https://garmin.example.com/mcp`
   - Signing algorithm: `RS256`
   - Permission/scope: `garmin:read`

3. Limit who can authenticate. For a single-owner deployment, keep only the required Auth0 connection/user enabled and copy that user's **User ID** (the access-token `sub`, such as `auth0|...`) into `MCP_AUTH0_ALLOWED_SUBJECTS`. This matters because every accepted Auth0 identity would otherwise reach the same Garmin account.

4. Configure the VPS. The audience must exactly match the canonical MCP URL:

```dotenv
MCP_PUBLIC_URL=https://garmin.example.com/mcp
MCP_AUTH0_DOMAIN=your-tenant.us.auth0.com
MCP_AUTH0_AUDIENCE=https://garmin.example.com/mcp
MCP_AUTH0_ALLOWED_SUBJECTS=auth0|your-user-id
```

Keep `MCP_BEARER_TOKEN` if an existing Codex client uses it. Do not set any `MCP_OAUTH_*` variables in Auth0 mode. No Auth0 client secret is stored on the VPS.

5. Rebuild and restart the server, then check protected-resource discovery:

```bash
npm ci
npm run build
sudo systemctl restart garmin-connect-mcp
curl -fsS https://garmin.example.com/.well-known/oauth-protected-resource/mcp
```

The returned `authorization_servers` value must be the Auth0 tenant URL, and `resource` must exactly match `MCP_PUBLIC_URL`.

6. Register and authorize the client or clients you intend to use:

   - **Hosted ChatGPT plugin:** add `https://garmin.example.com/mcp` as a personal plugin. With issuer identification enabled, ChatGPT can use `https://chatgpt.com/oauth/client.json` and the stable callback `https://chatgpt.com/connector_platform_oauth_redirect`.
   - **Direct Codex MCP:** initiate `codex mcp login` once, then import the exact `https://chatgpt.com/oauth/codex/<callback_id>/client.json` shown in that authorization request. Grant this separate Auth0 application user-delegated `garmin:read`, then retry login.

   In either case, enable the intended Auth0 database/domain connection for the third-party CIMD application. If the endpoint was connected before authentication or tool metadata changed, create a fresh connection or restart the Codex host so discovery runs again.

7. Verify that the client discovers all thirteen tools and that a privacy-preserving `garmin_profile` call succeeds. Seeing only seven or twelve tools means the client is using an older metadata snapshot.

See the official [OpenAI OAuth requirements](https://developers.openai.com/plugins/build/auth), [Auth0 MCP authorization guide](https://auth0.com/ai/docs/mcp/get-started/authorization-for-your-mcp-server), and [Auth0 CIMD guide](https://auth0.com/docs/get-started/auth0-overview/create-applications/register-applications-with-cimd).

### Built-in single-user fallback

The repository retains a deliberately narrow built-in OAuth 2.1 provider for rollback or private testing. It uses PKCE (`S256`), dynamic registration restricted to an exact callback allowlist, short-lived access tokens, rotating refresh tokens, a hashed access password, rate-limited approval, and an atomic private state file. Do not enable it together with Auth0.

Create a separate access password. This is neither your Garmin password nor the static MCP bearer token:

```bash
npm run hash-oauth-password
```

The command hides the password while you type and prints only its scrypt hash. Put the hash and the public endpoint in the server environment:

```dotenv
MCP_PUBLIC_URL=https://garmin.example.com/mcp
MCP_OAUTH_PASSWORD_HASH=scrypt$...
MCP_OAUTH_STATE_FILE=/var/lib/garmin-connect-mcp/oauth-state.json
MCP_OAUTH_ALLOWED_REDIRECT_URIS=https://chatgpt.com/connector_platform_oauth_redirect
```

Use the supplied systemd unit so `/var/lib/garmin-connect-mcp` is created with mode `0700`, and use the supplied Nginx location so `/mcp`, OAuth discovery, registration, authorization, token, approval, and revocation routes all reach Node.js. Rebuild and restart the service, then verify:

```bash
curl -fsS https://garmin.example.com/.well-known/oauth-protected-resource/mcp
curl -fsS https://garmin.example.com/.well-known/oauth-authorization-server
```

To add the fallback provider to ChatGPT as a personal plugin:

1. In ChatGPT settings, open **Security and login** and enable **Developer mode**.
2. Open **Plugins**, select the add (`+`) action, and enter `https://garmin.example.com/mcp`.
3. Review the thirteen read-only tools and start the OAuth connection.
4. On the private authorization page hosted by your server, enter the separate access password and approve.
5. Test with a low-risk request such as “读取我的 Garmin 个人资料”。

See OpenAI's official [plugin quickstart](https://developers.openai.com/plugins/quickstart), [MCP connection guide](https://developers.openai.com/plugins/deploy/connect-chatgpt), and [authentication requirements](https://developers.openai.com/plugins/build/auth). The built-in provider is intended only for one owner's private deployment.

## Configuration

| Variable | Default | Description |
|---|---:|---|
| `GARMIN_USERNAME` | — | Garmin Connect email/username |
| `GARMIN_SESSION_TOKEN_FILE` | `~/.config/garmin-connect-mcp/session.json` | Absolute path override for the single private, bound DI session |
| `GARMIN_PASSWORD` | — | Garmin Connect password; use only for initial bootstrap or reauthentication, then remove |
| `GARMIN_SESSION_TOKEN` | — | Legacy inline JSON session accepted for migration |
| `GARMIN_SESSION_TOKEN_B64` | — | Legacy Base64 inline session accepted for migration/systemd compatibility |
| `GARMIN_REGION` | `global` | `global` (`garmin.com`) or `cn` (`garmin.cn`) |
| `GARMIN_CACHE_TTL` | `300` | In-memory cache lifetime in seconds; `0` disables caching |
| `GARMIN_CACHE_MAX_ENTRIES` | `100` | Maximum cached query count |
| `GARMIN_RETRY_ATTEMPTS` | `3` | Retry count for authentication expiry and rate limits |
| `GARMIN_RETRY_BASE_DELAY_MS` | `1000` | Initial exponential backoff delay |
| `GARMIN_RETRY_MAX_DELAY_MS` | `30000` | Maximum backoff delay |
| `GARMIN_ACTIVITY_DETAIL` | `compact` | Default activity output: `compact` or `full` |
| `GARMIN_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, or `error` |
| `MCP_TRANSPORT` | `stdio` | `stdio` for a local process or `http` for Streamable HTTP |
| `MCP_HTTP_HOST` | `127.0.0.1` | HTTP bind address; keep loopback when using a reverse proxy |
| `MCP_HTTP_PORT` | `3100` | Internal HTTP listen port |
| `MCP_HTTP_PATH` | `/mcp` | Streamable HTTP endpoint path |
| `MCP_BEARER_TOKEN` | — | Optional independent static-client secret (minimum 32 bytes) |
| `MCP_PUBLIC_URL` | — | Canonical public HTTPS MCP URL, including `/mcp`; required by either OAuth option |
| `MCP_AUTH0_DOMAIN` | — | Auth0 tenant or custom domain, without `https://` or a path |
| `MCP_AUTH0_AUDIENCE` | `MCP_PUBLIC_URL` | Auth0 API identifier; must exactly match `MCP_PUBLIC_URL` |
| `MCP_AUTH0_ALLOWED_SUBJECTS` | — | Recommended comma-separated allowlist of Auth0 access-token `sub` values |
| `MCP_OAUTH_ISSUER` | URL origin | Built-in fallback issuer on the same origin as `MCP_PUBLIC_URL` |
| `MCP_OAUTH_PASSWORD_HASH` | — | Built-in fallback scrypt hash produced by `npm run hash-oauth-password` |
| `MCP_OAUTH_STATE_FILE` | — | Built-in fallback private state file for registered clients and hashed tokens |
| `MCP_OAUTH_ALLOWED_REDIRECT_URIS` | ChatGPT callback | Built-in fallback exact OAuth redirect URI allowlist |
| `MCP_OAUTH_ACCESS_TOKEN_TTL` | `3600` | Built-in fallback access-token lifetime in seconds |
| `MCP_OAUTH_REFRESH_TOKEN_TTL` | `7776000` | Built-in fallback refresh-token lifetime in seconds (90 days) |

The client de-duplicates concurrent requests, caches successful responses, refreshes the private DI session and atomically persists rotated credentials before use, verifies username/region/profile binding, remains compatible with legacy OAuth1/OAuth2 sessions for migration, reconnects once after a `401` or `403`, and applies bounded exponential backoff after a `429`. If Garmin revokes the long-lived token, temporarily restore `GARMIN_PASSWORD` and run the export script again with `--force-login`.

## Development

```bash
npm run build
npm test
npm run smoke:metrics
npm run smoke:http
npm run smoke:auth0
npm run smoke:oauth
npm run dev
```

The server writes protocol messages only to stdout. Runtime diagnostics go to stderr so they do not corrupt the MCP stdio transport.

## Acknowledgements

The client/cache/formatting design, running-workout knowledge cards, four training-philosophy lenses, safety-gated intake, and private DI-session hardening were informed by [Likenttt/garmin-connect-plugin-for-dsh](https://github.com/Likenttt/garmin-connect-plugin-for-dsh), an MIT-licensed Garmin integration. This repository is a standalone single-user MCP implementation and does not retain its DeepSeek Harness, Cordis, or multi-user features.

The MFA-capable iOS SSO and DI OAuth flow follows protocol behavior documented by the MIT-licensed [python-garminconnect](https://github.com/cyberjunky/python-garminconnect), [garth](https://github.com/matin/garth), and [garmin-connect](https://github.com/Pythe1337N/garmin-connect) projects.

## License

[MIT](LICENSE)
