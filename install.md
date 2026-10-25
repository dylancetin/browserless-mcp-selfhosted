# Connect a self-hosted Browserless instance

## Build the fork

Use Node.js 24 or later and npm 11.10 or later.

```sh
git clone https://github.com/dylancetin/browserless-mcp-selfhosted.git
cd browserless-mcp-selfhosted
npm ci
npm run build
```

Start Browserless separately. Set `BROWSERLESS_TOKEN` to its token through your shell's secret mechanism or your MCP client's environment. Set `BROWSERLESS_API_URL` if Browserless is not at `http://localhost:3000`. Do not include the token in that URL.

## Use stdio

Point your MCP client at `node <checkout>/build/src/index.js`. Use an absolute checkout path in your client configuration. Pass `BROWSERLESS_TOKEN` and, if needed, `BROWSERLESS_API_URL` in the server environment. See the [client configuration example](README.md#build-and-connect).

Expect exactly `browserless_function` and `browserless_performance` in the client's tool list. Do not install `@browserless.io/mcp` to run this fork. There is no published npm package for this setup.

## Use Streamable HTTP

With the same Browserless environment, run the server in the foreground.

```sh
PORT=8080 npm run start:http
```

Connect the MCP client to `http://localhost:8080/mcp`. Supply `Authorization: Bearer <local-browserless-token>` with every request. The server listens on all network interfaces. Restrict access with your firewall. Use TLS through a trusted reverse proxy for access outside a trusted local network.

`MCP_BASE_URL` defaults to `http://localhost:<PORT>`. To retrieve Lighthouse downloads from another machine, set it to the MCP server's client-reachable HTTP or HTTPS base URL before starting. This URL identifies the MCP server, not Browserless. Download URLs contain a credential, so do not share them or save them in logs. Downloads work once and expire after 15 minutes or when the MCP session ends.

Both transports expose the same two tools for any `MCP_COMPLIANCE_MODE` value. Upload staging and agent session-close routes are not registered. The download route remains available for Lighthouse reports. The status resource uses the MCP process's `BROWSERLESS_TOKEN`, not an HTTP client's token.

## Check the connection

```sh
npm run build
npm run verify:selfhosted
```

If Browserless runs remotely or in a container, set `BROWSERLESS_VERIFY_FIXTURE_HOST` to this machine's reachable hostname or address. Ensure Browserless can reach the temporary fixture port. The script closes its fixture and child MCP processes on success or failure. It saves readable Lighthouse reports outside the checkout unless you set `BROWSERLESS_VERIFY_OUTPUT_DIR`.

Keep upstream OAuth, Redis, SQS, Amplitude, and OTLP settings unset for this local setup. Those opt-in modules remain in the source but are not required here. Do not copy hosted connector configuration from upstream integrations.
