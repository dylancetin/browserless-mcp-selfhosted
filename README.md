# Browserless MCP self-hosted

This fork exposes two MCP tools for a self-hosted Browserless instance. It does not require a Browserless cloud account.

- `browserless_function` runs browser-context ESM with Puppeteer and returns text, JSON, images, or binary attachments.
- `browserless_performance` runs Lighthouse and saves the full JSON report outside the conversation.

Both stdio and Streamable HTTP expose the same tools. `MCP_COMPLIANCE_MODE` does not change them. The only listed resource is `browserless://status`, backed by `GET /active`. There are no registered prompts or agent instructions.

## Build and connect

Use Node.js 24 or later and npm 11.10 or later. Start your self-hosted Browserless instance separately.

```sh
git clone https://github.com/dylancetin/browserless-mcp-selfhosted.git
cd browserless-mcp-selfhosted
npm ci
npm run build
```

Configure your MCP client with the built entrypoint. Replace the path and supply your local Browserless token through the client's secret or environment configuration.

```json
{
  "mcpServers": {
    "browserless-selfhosted": {
      "command": "node",
      "args": ["<checkout>/build/src/index.js"],
      "env": {
        "BROWSERLESS_API_URL": "http://localhost:3000",
        "BROWSERLESS_TOKEN": "<local-browserless-token>"
      }
    }
  }
}
```

`BROWSERLESS_API_URL` defaults to `http://localhost:3000`, never a cloud endpoint. It must not contain credentials, a query, or a fragment. This fork is private in npm metadata. Install it from the clone, not the upstream npm package.

See [installation](install.md) for optional HTTP setup and [compatibility](docs/self-hosted-compatibility.md) for the tested versions and removal decisions.

## Use native function returns

Pass `code`, optional `context`, and optional `timeout` in milliseconds. Use an async ESM default export. It receives one object containing `page` and `context`.

```js
export default async ({ page, context }) => {
  await page.goto(context.url);
  return { title: await page.title() };
};
```

Return binary bytes directly for MCP image or resource blocks.

```js
export default async ({ page }) => {
  await page.setContent('<h1>Self-hosted Browserless</h1>');
  return await page.screenshot({ type: 'png' });
};
```

For a PDF attachment, return `await page.pdf()` instead.

Strings return text or HTML. Objects remain literal JSON, including objects with `data` and `type` fields. Such fields do not select the response MIME type. Code runs in a browser context. Node.js globals such as `process`, `Buffer`, `require`, and `module` are unavailable. Use supported Puppeteer APIs, not the removed `page.waitForTimeout` method. Text results have a 200,000-character limit.

## Run Lighthouse

```json
{
  "url": "https://example.com",
  "categories": ["performance", "seo"],
  "device": "desktop",
  "timeout": 120000
}
```

Supported categories are `accessibility`, `best-practices`, `performance`, and `seo`. You can also pass a custom Lighthouse `config` and `budgets`. Both tools reject `profile`. Lighthouse returns scores inline and a saved report path for stdio or an authenticated single-use download link for HTTP. Copy reports before the MCP session ends or the 15-minute expiry.

## Verify your instance

After building, run `npm run verify:selfhosted` with your Browserless environment. The script checks the actual built MCP entrypoint, both transports, native binary signatures, errors, and real Lighthouse JSON. For a remote or containerized Browserless instance, set `BROWSERLESS_VERIFY_FIXTURE_HOST` to this machine's hostname or address reachable by the browser. The script starts and stops its own synthetic fixture and temporary MCP processes. `BROWSERLESS_VERIFY_OUTPUT_DIR` selects where it saves reports.

## Credits and license

Forked from [browserless/browserless-mcp](https://github.com/browserless/browserless-mcp). Original author credits and the [SSPL-1.0 license](LICENSE) remain unchanged. This is not the official Browserless cloud connector. Upstream integrations and unregistered modules remain in the tree but are outside this fork's supported setup.
