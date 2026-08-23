# Garmin Connect MCP Server

A read-only [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server for Garmin Connect. It exposes recent activities, sleep, steps, heart rate, weight, workouts, and profile data to Codex and other MCP clients. It supports local stdio and private Streamable HTTP deployments with static bearer or single-user OAuth 2.1 authentication.

This first version is written in TypeScript with the MCP SDK, `garmin-connect`, and `dotenv`. It has no DeepSeek Harness or Cordis dependency.

> `garmin-connect` uses Garmin's unofficial web APIs. Endpoints can change without notice, and Garmin may rate-limit automated access.

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

All tools are read-only. Date ranges are inclusive and limited to 31 days.

## Requirements

- Node.js 18 or newer
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

Set either:

- `GARMIN_SESSION_TOKEN`, or
- both `GARMIN_USERNAME` and `GARMIN_PASSWORD`

For Garmin China accounts, set `GARMIN_REGION=cn`. The default is `global`.

## Export a session token

Session export is intentionally a local script, not an MCP tool, so a model cannot request or reveal the credential.

1. Put `GARMIN_USERNAME` and `GARMIN_PASSWORD` in `.env`.
2. Run:

```bash
umask 077
npm run --silent export-session > session-token.txt
```

If Garmin requires multi-factor authentication, the script prompts for the one-time code sent by email, SMS, or your authenticator app. The code is used only for that login.

3. Copy the JSON value from `session-token.txt` into `GARMIN_SESSION_TOKEN` in `.env`.
4. Remove `GARMIN_PASSWORD` if you want token-only authentication, then securely delete the temporary token file.

The token is sensitive. Do not commit it, paste it into a chat, or include it in logs.

## Codex MCP configuration

Codex supports local stdio MCP servers in `~/.codex/config.toml` or a trusted project's `.codex/config.toml`. Build the project first, then add an entry using absolute paths:

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
env_vars = ["GARMIN_SESSION_TOKEN", "GARMIN_USERNAME", "GARMIN_PASSWORD", "GARMIN_REGION"]
```

Restart Codex after editing the configuration, then use `/mcp` or the MCP server settings to confirm the server is connected. See the [official Codex MCP documentation](https://developers.openai.com/codex/mcp/) for all supported options.

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

The HTTP transport is intended to run behind an HTTPS reverse proxy. It is stateless at the MCP layer and uses JSON responses. Configure a static bearer token, the single-user OAuth block, or both. Keeping both lets an existing Codex client continue using its bearer token while ChatGPT uses OAuth.

Generate an independent MCP bearer token (this is not the Garmin session token):

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

## Private ChatGPT plugin with OAuth

ChatGPT connections that access personal Garmin data should use OAuth. This server implements a deliberately narrow single-user OAuth 2.1 authorization server with PKCE (`S256`), dynamic registration restricted to ChatGPT's official callback, short-lived access tokens, rotating refresh tokens, hashed credentials, rate-limited approval, and an atomic private state file.

First create a separate access password. This is neither your Garmin password nor the static MCP bearer token:

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

To add it to ChatGPT as a personal plugin:

1. In ChatGPT settings, open **Security and login** and enable **Developer mode**.
2. Open **Plugins**, select the add (`+`) action, and enter `https://garmin.example.com/mcp`.
3. Review the seven read-only tools and start the OAuth connection.
4. On the private authorization page hosted by your server, enter the separate access password and approve.
5. Test with a low-risk request such as “读取我的 Garmin 个人资料”。

See OpenAI's official [plugin quickstart](https://developers.openai.com/plugins/quickstart), [MCP connection guide](https://developers.openai.com/plugins/deploy/connect-chatgpt), and [authentication requirements](https://developers.openai.com/plugins/build/auth). This built-in provider is intended for one owner's private deployment. Replace it with an established identity provider before serving multiple users or publishing a plugin.

## Configuration

| Variable | Default | Description |
|---|---:|---|
| `GARMIN_SESSION_TOKEN` | — | JSON token created by `scripts/export-session.ts` |
| `GARMIN_SESSION_TOKEN_B64` | — | Base64-encoded session token; convenient for systemd environment files |
| `GARMIN_USERNAME` | — | Garmin Connect email/username |
| `GARMIN_PASSWORD` | — | Garmin Connect password |
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
| `MCP_PUBLIC_URL` | — | Canonical public HTTPS MCP URL, including `/mcp`; enables OAuth |
| `MCP_OAUTH_ISSUER` | URL origin | OAuth issuer on the same origin as `MCP_PUBLIC_URL` |
| `MCP_OAUTH_PASSWORD_HASH` | — | Scrypt hash produced by `npm run hash-oauth-password` |
| `MCP_OAUTH_STATE_FILE` | — | Private persistent file for registered clients and hashed tokens |
| `MCP_OAUTH_ALLOWED_REDIRECT_URIS` | ChatGPT callback | Comma-separated exact OAuth redirect URI allowlist |
| `MCP_OAUTH_ACCESS_TOKEN_TTL` | `3600` | OAuth access-token lifetime in seconds |
| `MCP_OAUTH_REFRESH_TOKEN_TTL` | `7776000` | OAuth refresh-token lifetime in seconds (90 days) |

The client de-duplicates concurrent requests, caches successful responses, refreshes current DI sessions with their refresh token, remains compatible with legacy OAuth1/OAuth2 sessions, reconnects after a `401` or `403`, and applies bounded exponential backoff after a `429`. If Garmin revokes the long-lived token, run the export script again.

## Development

```bash
npm run build
npm run smoke:http
npm run smoke:oauth
npm run dev
```

The server writes protocol messages only to stdout. Runtime diagnostics go to stderr so they do not corrupt the MCP stdio transport.

## Acknowledgements

The client/cache/formatting design was informed by [Likenttt/garmin-connect-plugin-for-dsh](https://github.com/Likenttt/garmin-connect-plugin-for-dsh), an MIT-licensed Garmin integration. This repository is a standalone MCP implementation and does not retain its DeepSeek Harness or Cordis dependencies.

The MFA-capable iOS SSO and DI OAuth flow follows protocol behavior documented by the MIT-licensed [python-garminconnect](https://github.com/cyberjunky/python-garminconnect), [garth](https://github.com/matin/garth), and [garmin-connect](https://github.com/Pythe1337N/garmin-connect) projects.

## License

[MIT](LICENSE)
