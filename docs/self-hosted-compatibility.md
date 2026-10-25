# Self-hosted compatibility

This fork registers exactly `browserless_function` and `browserless_performance` on stdio and Streamable HTTP. `MCP_COMPLIANCE_MODE` does not change the registry. `browserless://status` uses the verified `GET /active` endpoint. No prompts, API-docs resource, or cloud agent instructions are registered.

## Tested runtime

The local runtime audit on 2026-10-25 observed the following versions.

| Component   | Version       | Evidence                              |
| ----------- | ------------- | ------------------------------------- |
| Browserless | 2.48.2        | `/meta` and deployed OpenAPI document |
| Chromium    | 147.0.7727.15 | `/meta`, `/json/version`, and CDP     |
| Puppeteer   | 24.42.0       | `/meta`                               |
| Lighthouse  | 13.1.0        | Successful real audit reports         |

The exact container digest and Browserless source revision were not observable. These results do not establish compatibility with every Browserless edition or version.

## All upstream tool decisions

Live evidence means authenticated calls to the configured self-hosted runtime. Source evidence means the dependency follows from the upstream implementation. Cloud GraphQL, wallet mutations, purchases, and existing browser sessions were not operated on.

| Upstream tool               | Decision              | Evidence                                                                                                    |
| --------------------------- | --------------------- | ----------------------------------------------------------------------------------------------------------- |
| `browserless_function`      | Keep, narrow contract | Live `/function` executes context, DOM, text, raw PNG, and raw PDF. Objects remain literal JSON.            |
| `browserless_performance`   | Keep, narrow contract | Live `/performance` returns real nonempty Lighthouse reports. Remove `pwa` and `profile`.                   |
| `browserless_agent`         | Remove                | Live agent WebSocket and capabilities routes return 404. Working CDP is a different protocol.               |
| `browserless_skill`         | Remove                | Live remote `/skills` returns 404. Bundled text is readable but describes the unavailable agent.            |
| `browserless_smartscraper`  | Remove                | Live `POST /smart-scrape` returns 404. Native `/scrape` has a different contract.                           |
| `browserless_export`        | Remove                | Live `POST /export` returns 404.                                                                            |
| `browserless_map`           | Remove                | Live `POST /map` returns 404.                                                                               |
| `browserless_crawl`         | Remove                | Live start, status, and nonexistent-job cancel routes return 404. Result retrieval is unreachable.          |
| `browserless_search`        | Remove                | Live `POST /search` returns 404.                                                                            |
| `browserless_profiles`      | Remove                | Live `/profiles` and `/profile` return 404.                                                                 |
| `browserless_live_url`      | Remove                | Live lifecycle routes return 404 with fresh nonexistent IDs. No existing browser was modified.              |
| `browserless_account`       | Remove                | Source uses cloud account GraphQL. Local `/graphql` returns 404. No local token was sent to cloud.          |
| `browserless_usage`         | Remove                | Source uses the same cloud GraphQL dependency, not native runtime metrics.                                  |
| `browserless_sessions`      | Remove                | Source uses cloud GraphQL and signed replay URLs, not the working native `/sessions` route.                 |
| `browserless_logs`          | Remove                | Source uses the same cloud GraphQL dependency, not process logs.                                            |
| `browserless_link_connect`  | Remove                | Live wallet status route returns 404. Source restricts mutations to cloud account hosts and OAuth identity. |
| `browserless_link_checkout` | Remove                | Source requires the unavailable agent protocol and a connected wallet. No purchase was attempted.           |
| `browserless_stage_file`    | Remove                | Source rejects every native file host with the shipped empty allowlist. Its agent consumer is unavailable.  |

Unregistered upstream modules remain where deleting them would require unrelated library changes. They do not establish supported MCP capabilities. Upstream Grok and Hermes integrations are outside this fork's tested setup.

## Native contracts and limits

- Function parameters are `code`, optional `context`, and optional `timeout`. The async ESM default export receives `{page, context}` in a browser context, not Node.js. Synchronous exports fail on the tested runtime.
- Function return values determine the native HTTP MIME type. Raw screenshot bytes become an MCP image block. Raw PDF bytes become a resource block. Arbitrary `{data, type}` objects stay JSON.
- Both retained tools reject `profile`. The audited function endpoint silently ignored that query, and native profile routes were absent.
- Performance parameters are `url`, optional `categories`, `device`, `config`, `budgets`, and `timeout`. Categories are `accessibility`, `best-practices`, `performance`, and `seo`.
- PWA-only Lighthouse calls failed twice with HTTP 500 while SEO controls succeeded. The server's internal PWA exception remains unknown.
- Mobile and desktop performance presets, SEO-only audits, default categories, and empty budgets succeeded live. Arbitrary custom configurations and nonempty budget enforcement are not exhaustively verified.
- Saved reports are local to one MCP process. HTTP retrieval is authenticated and single-use. Reports expire after 15 minutes or when the session ends. For remote clients, `MCP_BASE_URL` must identify a reachable MCP server.
- Status uses the process-configured Browserless token and URL. It reports `/active` reachability, not billing or account health.
- Default setup requires no cloud service. Optional upstream telemetry and OAuth machinery remain inactive without their settings. Browser navigation and Lighthouse can still contact target websites.

## Reproducible checks

`npm run verify:selfhosted` launches the built entrypoint with the inherited Browserless environment. It checks the exact registry and schemas across both transports and compliance values. It verifies DOM interaction, context, literal JSON, raw text, PNG and PDF signatures, script errors, timeout behavior, status, and rejected inputs. It runs real Lighthouse audits, reads saved JSON, and fetches authenticated HTTP downloads once. Its fixture and child processes close after the run. `BROWSERLESS_VERIFY_FIXTURE_HOST` selects a host reachable by a remote Browserless instance. `BROWSERLESS_VERIFY_OUTPUT_DIR` selects the report directory.
