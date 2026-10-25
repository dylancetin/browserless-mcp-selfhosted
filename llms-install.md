# Install this self-hosted fork for an MCP client

1. Confirm Node.js is at least version 24 and npm is at least version 11.10.
2. Clone `https://github.com/dylancetin/browserless-mcp-selfhosted.git`.
3. Run `npm ci` and `npm run build` in the checkout.
4. Configure stdio with command `node` and the absolute path to `<checkout>/build/src/index.js` as its argument.
5. Supply `BROWSERLESS_TOKEN` through the client's private environment configuration. Never request or echo the token in conversation.
6. Set `BROWSERLESS_API_URL` to the user's Browserless base URL if it differs from `http://localhost:3000`. Keep credentials, queries, and fragments out of that URL.
7. Check that MCP lists exactly `browserless_function` and `browserless_performance`, no prompts, and only the `browserless://status` resource.

For HTTP, follow [installation](install.md#use-streamable-http). Use a plain Browserless token, not cloud OAuth. Set `MCP_BASE_URL` when clients cannot reach the default `http://localhost:<PORT>` download base.

Use `browserless_function` with `{code, context?, timeout?}`. Supply browser-context ESM, for example `export default async ({ page, context }) => { await page.goto(context.url); return await page.title(); }`. Return screenshot or PDF bytes directly. Do not wrap results in `{data, type}`. Node.js globals are unavailable.

Use `browserless_performance` with `{url, categories?, device?, config?, budgets?, timeout?}`. Accepted categories are `accessibility`, `best-practices`, `performance`, and `seo`. Both tools reject `profile`. No agent, cloud account, profile, search, crawl, or smart-scraper tool is available.

Do not substitute the upstream npm package or hosted MCP URL. This fork has no npm publication or official MCP registry entry. Keep optional upstream cloud service settings unset. Run `npm run verify:selfhosted` against the user's runtime to verify compatibility. See [compatibility](docs/self-hosted-compatibility.md) for limits and version evidence.
