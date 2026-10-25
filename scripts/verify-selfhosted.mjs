import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { networkInterfaces, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const token = process.env.BROWSERLESS_TOKEN;
assert.ok(
  token,
  'Set BROWSERLESS_TOKEN for your self-hosted Browserless instance',
);
const output = process.env.BROWSERLESS_VERIFY_OUTPUT_DIR
  ? resolve(process.env.BROWSERLESS_VERIFY_OUTPUT_DIR)
  : await mkdtemp(join(tmpdir(), 'browserless-selfhosted-'));
await mkdir(output, { recursive: true });
const downloads = await mkdtemp(
  join(tmpdir(), 'browserless-verify-downloads-'),
);
const env = {
  ...process.env,
  ANALYTICS_ENABLED: 'false',
  AMPLITUDE_API_KEY: '',
  OAUTH_ENABLED: 'false',
  REDIS_URL: '',
  OTEL_ENABLED: 'false',
  OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: '',
  BROWSERLESS_MAX_RETRIES: '0',
  BROWSERLESS_DOWNLOAD_DIR: downloads,
};
const text = (result) =>
  result.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
const redact = (value) =>
  String(value)
    .replaceAll(token, '[REDACTED]')
    .replaceAll(encodeURIComponent(token), '[REDACTED]');
const expected = {
  browserless_function: ['code', 'context', 'timeout'],
  browserless_performance: [
    'budgets',
    'categories',
    'config',
    'device',
    'timeout',
    'url',
  ],
};
const clients = new Set();
let httpChild;
let httpExit;
let httpErrors = '';
const fixture = createServer((req, res) => {
  if (req.url === '/favicon.ico') return res.writeHead(204).end();
  if (req.url === '/robots.txt')
    return res.writeHead(200).end('User-agent: *\nAllow: /\n');
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    .end(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Self-hosted verification</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="description" content="Synthetic Browserless verification fixture"></head>
<body><main><h1>Self-hosted fixture</h1><label>Value <input id="value"></label>
<button onclick="document.querySelector('#marker').textContent='clicked'">Run</button>
<p id="marker">ready</p><a href="/next">Next</a></main></body></html>`);
});

function childEnv(compliance, transport) {
  const result = { ...env, TRANSPORT: transport };
  if (compliance === undefined) delete result.MCP_COMPLIANCE_MODE;
  else result.MCP_COMPLIANCE_MODE = compliance;
  return result;
}

async function inventory(client) {
  const { tools } = await client.listTools();
  assert.deepEqual(
    tools.map((tool) => tool.name).sort(),
    Object.keys(expected),
  );
  assert.equal(
    client.getInstructions(),
    undefined,
    'No cloud or agent instructions',
  );
  for (const tool of tools) {
    assert.deepEqual(
      Object.keys(tool.inputSchema.properties).sort(),
      expected[tool.name],
    );
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.doesNotMatch(
      tool.description,
      /Browserless cloud|saveProfile|uploadFile|browserless_agent/,
    );
    if (tool.name === 'browserless_performance') {
      assert.deepEqual(tool.inputSchema.properties.categories.items.enum, [
        'accessibility',
        'best-practices',
        'performance',
        'seo',
      ]);
    }
  }
  if (client.getServerCapabilities()?.prompts) {
    assert.deepEqual((await client.listPrompts()).prompts, []);
  } else {
    await assert.rejects(client.listPrompts(), { code: -32601 });
  }
  assert.deepEqual(
    (await client.listResources()).resources.map((resource) => resource.uri),
    ['browserless://status'],
  );
}

async function call(client, name, args) {
  return client.callTool({ name, arguments: args }, undefined, {
    timeout: 180_000,
  });
}

async function rejects(client, name, args, pattern) {
  let result;
  try {
    result = await call(client, name, args);
  } catch (error) {
    assert.match(error.message, pattern);
    return;
  }
  assert.equal(result.isError, true, 'Tool call must fail');
  assert.match(text(result), pattern);
}

async function performance(client, url, transport, base) {
  const result = await call(client, 'browserless_performance', {
    url,
    categories: ['seo'],
    device: 'desktop',
    budgets: [],
    timeout: 120_000,
  });
  assert.ok(!result.isError, 'Lighthouse call succeeds');
  assert.match(text(result), /Lighthouse Scores/);
  assert.doesNotMatch(text(result), /uploadFile|browserless_agent/);
  let report;
  if (transport === 'stdio') {
    const path = text(result).match(
      /Full Lighthouse report saved outside the conversation:\n([^\n]+) \(/,
    )?.[1];
    assert.ok(
      path?.startsWith(downloads + '/'),
      'Report path belongs to this run',
    );
    report = JSON.parse(await readFile(path, 'utf8'));
  } else {
    const link = text(result).match(/curl -fsS "([^"]+)"/)?.[1];
    assert.ok(link, 'HTTP report includes a download command');
    assert.equal(new URL(link).origin, base);
    const denied = new URL(link);
    denied.searchParams.set('token', 'not-the-owner');
    assert.equal((await fetch(denied)).status, 404);
    const response = await fetch(link);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /application\/json/);
    report = await response.json();
    assert.equal((await fetch(link)).status, 404, 'Download is single use');
  }
  assert.ok(report.lighthouseVersion, 'Real Lighthouse version');
  assert.ok(Object.keys(report.audits).length > 0, 'Nonempty audit report');
  assert.equal(typeof report.categories.seo.score, 'number');
  assert.equal(report.runtimeError, undefined);
  const path = join(output, `lighthouse-${transport}.json`);
  await writeFile(path, JSON.stringify(report, null, 2), { mode: 0o600 });
  assert.equal(
    JSON.parse(await readFile(path, 'utf8')).lighthouseVersion,
    report.lighthouseVersion,
  );
  console.log(
    `PASS ${transport} Lighthouse ${report.lighthouseVersion}, saved readable JSON`,
  );
}

async function stdio(compliance) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(root, 'build/src/index.js')],
    cwd: root,
    env: childEnv(compliance, 'stdio'),
    stderr: 'pipe',
  });
  transport.stderr?.on('data', () => {});
  const client = new Client({ name: 'verify-selfhosted', version: '1.0.0' });
  clients.add(client);
  await client.connect(transport);
  await inventory(client);
  return client;
}

async function stopHttp() {
  if (!httpChild) return;
  httpChild.kill('SIGTERM');
  const killTimer = setTimeout(() => httpChild?.kill('SIGKILL'), 3000);
  try {
    await httpExit;
  } finally {
    clearTimeout(killTimer);
    httpChild = undefined;
  }
}

try {
  await new Promise((done) => fixture.listen(0, '0.0.0.0', done));
  const host =
    process.env.BROWSERLESS_VERIFY_FIXTURE_HOST ??
    Object.values(networkInterfaces())
      .flat()
      .find((entry) => entry?.family === 'IPv4' && !entry.internal)?.address ??
    '127.0.0.1';
  const url = `http://${host.includes(':') ? `[${host}]` : host}:${fixture.address().port}/verify`;
  const client = await stdio(undefined);
  const status = await client.readResource({ uri: 'browserless://status' });
  assert.equal(
    JSON.parse(status.contents[0].text).ok,
    true,
    '/active status succeeds',
  );
  const dom = await call(client, 'browserless_function', {
    code: `export default async ({ page, context }) => {
      await page.goto(context.url);
      await page.type('#value', context.value);
      await page.click('button');
      return { heading: await page.$eval('h1', el => el.textContent),
        value: await page.$eval('#value', el => el.value),
        marker: await page.$eval('#marker', el => el.textContent),
        node: typeof process, buffer: typeof Buffer };
    }`,
    context: { url, value: 'context works' },
  });
  assert.ok(
    !dom.isError,
    'Fixture must be reachable from Browserless. Set BROWSERLESS_VERIFY_FIXTURE_HOST if needed',
  );
  assert.deepEqual(JSON.parse(dom.content[0].text), {
    heading: 'Self-hosted fixture',
    value: 'context works',
    marker: 'clicked',
    node: 'undefined',
    buffer: 'undefined',
  });
  const raw = await call(client, 'browserless_function', {
    code: 'export default async () => "raw-text-ok"',
  });
  assert.match(raw.content[0].text, /^raw-text-ok\n?$/);
  assert.match(text(raw), /Content-Type: text\/plain/);
  const literal = await call(client, 'browserless_function', {
    code: 'export default async () => ({ data: "literal", type: "image/png" })',
  });
  assert.deepEqual(JSON.parse(literal.content[0].text), {
    data: 'literal',
    type: 'image/png',
  });
  const png = await call(client, 'browserless_function', {
    code: 'export default async ({ page }) => { await page.setContent("<h1>PNG</h1>"); return await page.screenshot({ type: "png" }); }',
  });
  const image = png.content.find((block) => block.type === 'image');
  assert.equal(image?.mimeType, 'image/png');
  assert.equal(
    Buffer.from(image.data, 'base64').subarray(0, 8).toString('hex'),
    '89504e470d0a1a0a',
  );
  const pdf = await call(client, 'browserless_function', {
    code: 'export default async ({ page }) => { await page.setContent("<h1>PDF</h1>"); return await page.pdf(); }',
  });
  const resource = pdf.content.find(
    (block) => block.type === 'resource',
  )?.resource;
  assert.equal(resource?.mimeType, 'application/pdf');
  assert.equal(
    Buffer.from(resource.blob, 'base64').subarray(0, 5).toString(),
    '%PDF-',
  );
  await rejects(
    client,
    'browserless_function',
    {
      code: 'export default async () => { throw new Error("verification-script-error"); }',
    },
    /verification-script-error/,
  );
  await rejects(
    client,
    'browserless_function',
    { code: 'export default async () => new Promise(() => {})', timeout: 1000 },
    /timeout|timed out|408/i,
  );
  await rejects(
    client,
    'browserless_function',
    { code: 'export default async () => "ok"', profile: 'unsupported' },
    /profile|unrecognized/i,
  );
  await rejects(
    client,
    'browserless_performance',
    { url, profile: 'unsupported' },
    /profile|unrecognized/i,
  );
  await rejects(
    client,
    'browserless_performance',
    { url, categories: ['pwa'] },
    /invalid|pwa|category|option/i,
  );
  await performance(client, url, 'stdio');
  await client.close();
  clients.delete(client);
  console.log(
    'PASS stdio context, DOM, raw returns, PNG, PDF, errors, timeout, rejected inputs, status',
  );
  for (const compliance of ['true', 'false', '', 'unexpected']) {
    const other = await stdio(compliance);
    await other.close();
    clients.delete(other);
  }
  console.log(
    'PASS stdio inventory with unset, true, false, empty, and unrecognized compliance values',
  );

  for (const compliance of [undefined, 'true', 'false', '', 'unexpected']) {
    const reservation = createServer();
    await new Promise((done) => reservation.listen(0, '127.0.0.1', done));
    const port = reservation.address().port;
    await new Promise((done) => reservation.close(done));
    const base = `http://localhost:${port}`;
    const httpEnv = {
      ...childEnv(compliance, 'httpStream'),
      PORT: String(port),
    };
    delete httpEnv.MCP_BASE_URL;
    httpErrors = '';
    httpChild = spawn(process.execPath, [join(root, 'build/src/index.js')], {
      cwd: root,
      env: httpEnv,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    httpExit = once(httpChild, 'exit');
    httpChild.stderr.on('data', (chunk) => {
      httpErrors = (httpErrors + chunk).slice(-4000);
    });
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (httpChild.exitCode !== null)
        throw new Error(`HTTP server exited: ${redact(httpErrors)}`);
      try {
        ready = (
          await fetch(`${base}/health`, { signal: AbortSignal.timeout(1000) })
        ).ok;
      } catch {
        ready = false;
      }
      if (ready) break;
      await new Promise((done) => setTimeout(done, 100));
    }
    assert.ok(ready, 'HTTP server starts');
    const httpClient = new Client({
      name: 'verify-selfhosted-http',
      version: '1.0.0',
    });
    clients.add(httpClient);
    await httpClient.connect(
      new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      }),
    );
    await inventory(httpClient);
    if (compliance === undefined) {
      const result = await call(httpClient, 'browserless_function', {
        code: 'export default async () => "http-ok"',
      });
      assert.match(result.content[0].text, /^http-ok\n?$/);
      await performance(httpClient, url, 'httpStream', base);
      assert.equal(
        (await fetch(`${base}/upload`, { method: 'POST' })).status,
        404,
      );
      assert.equal(
        (await fetch(`${base}/agent/session/unused`, { method: 'DELETE' }))
          .status,
        404,
      );
    }
    await httpClient.close();
    clients.delete(httpClient);
    await stopHttp();
  }
  console.log(
    'PASS HTTP inventory for all compliance values, function, authenticated downloads, removed routes',
  );
  console.log(`Reports saved in ${output}`);
} catch (error) {
  console.error(redact(error.stack ?? error.message));
  process.exitCode = 1;
} finally {
  await Promise.allSettled([...clients].map((client) => client.close()));
  await stopHttp();
  fixture.closeAllConnections();
  await new Promise((done) => fixture.close(done));
  await rm(downloads, { recursive: true, force: true });
}
