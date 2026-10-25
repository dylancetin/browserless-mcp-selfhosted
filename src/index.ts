import { readFileSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FastMCP, OAuthProvider } from 'fastmcp';
import type { OAuthProxy } from 'fastmcp/auth';
import { getConfig } from './config.js';
import type { BrowserlessSession } from './@types/types.js';
import { registerSurface } from './tools/register.js';
import { registerDownloadRoute } from './resources/download-route.js';
import { clearSession } from './lib/download-store.js';
import {
  touchSession,
  forgetSession,
  startSessionReaper,
} from './lib/session-reaper.js';
import { AnalyticsHelper } from './lib/analytics.js';
import { resolveBrowserlessRequestAuth } from './lib/http-auth.js';
import { BoundedEventStore } from './lib/bounded-event-store.js';
import { RedisTokenStorage } from './lib/redis-token-storage.js';
import { BrowserlessOAuthProxy } from './lib/oauth-redirect-uri.js';
import { createRegisterRateLimiter } from './lib/oauth-register-rate-limit.js';
import { Redis } from 'ioredis';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  instrumentFastMcpTools,
  initializeAmplitudeAnalytics,
  shutdownAmplitudeAnalytics,
} from './lib/amplitude-analytics.js';
import {
  recordRedisError,
  recordMcpRequest,
  mcpInFlightAdd,
} from './lib/metrics-recorders.js';

const pkg = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json'),
    'utf-8',
  ),
) as { version: `${number}.${number}.${number}` };

const config = getConfig();

const analytics = new AnalyticsHelper(
  config.analyticsEnabled,
  config.sqsQueueUrl,
  config.sqsRegion,
);
const amplitudeAnalytics = initializeAmplitudeAnalytics(
  config.amplitudeApiKey,
  pkg.version,
);

// Passthrough OAuth provider: disables FastMCP's token-swap mode so the MCP client
// receives the raw Supabase JWT directly.
const redisClient = config.redisUrl ? new Redis(config.redisUrl) : undefined;
if (redisClient) {
  redisClient.on('error', (err: Error) => {
    recordRedisError();
    console.error('[browserless-mcp] Redis error:', err);
  });
  // Redis is only configured for the hosted httpStream deployment (REDIS_URL is
  // not set in stdio mode), so writing the "connected" line to stdout doesn't
  // interfere with MCP-over-stdio protocol framing.
  redisClient.on('ready', () =>
    console.log('[browserless-mcp] Redis connected for OAuth state storage'),
  );
}

class PassthroughOAuthProvider extends OAuthProvider {
  protected createProxy(): OAuthProxy {
    const proxyConfig = {
      allowedRedirectUriPatterns: config.oauthAllowedRedirectUriPatterns,
      baseUrl: this.config.baseUrl,
      consentRequired: false,
      enableTokenSwap: false,
      scopes: this.config.scopes ?? [],
      upstreamAuthorizationEndpoint: this.genericConfig.authorizationEndpoint,
      upstreamClientId: this.config.clientId,
      upstreamClientSecret: this.config.clientSecret,
      upstreamTokenEndpoint: this.genericConfig.tokenEndpoint,
      upstreamTokenEndpointAuthMethod:
        this.genericConfig.tokenEndpointAuthMethod ?? 'client_secret_basic',
    };
    if (redisClient) {
      return new BrowserlessOAuthProxy({
        ...proxyConfig,
        encryptionKey: false,
        tokenStorage: new RedisTokenStorage(redisClient),
      });
    }
    return new BrowserlessOAuthProxy(proxyConfig);
  }
}

const oauthProvider =
  config.oauthEnabled && config.transport === 'httpStream'
    ? new PassthroughOAuthProvider({
        baseUrl: config.mcpBaseUrl,
        clientId: config.supabaseOAuthClientId,
        clientSecret: config.supabaseOAuthClientSecret,
        authorizationEndpoint: `${config.supabaseUrl}/auth/v1/oauth/authorize`,
        tokenEndpoint: `${config.supabaseUrl}/auth/v1/oauth/token`,
        scopes: ['email'],
        consentRequired: false,
      })
    : undefined;

// Hybrid authenticate, in order: (1) Authorization header with a plain API
// key or (2) ?token= query param → direct token session; (3) Authorization
// header with a Supabase JWT → resolve the Browserless API key via PostgREST.
const hybridAuthenticate =
  config.transport === 'httpStream'
    ? async (request: Parameters<typeof resolveBrowserlessRequestAuth>[0]) => {
        // Any authenticated inbound request proves the client is alive, so
        // refresh the idle clock here — not only on tool calls. This keeps the
        // reaper from closing a session that is merely between calls or only
        // listing tools. `initialize` carries no session id yet; the reaper's
        // first discovery stamps sessions that never send another request.
        const sid = request.headers?.['mcp-session-id'];
        touchSession(Array.isArray(sid) ? sid[0] : sid);

        // Per-request MCP metrics on authenticate() — the one hook that sees
        // /mcp (memoized once per POST). Spans auth only; record once it settles.
        mcpInFlightAdd(1);
        const authStartedAt = performance.now();
        try {
          const session = (await resolveBrowserlessRequestAuth(
            request,
            config,
          )) as BrowserlessSession;
          recordMcpRequest('authenticated', performance.now() - authStartedAt);
          return session;
        } catch (err) {
          recordMcpRequest('rejected', performance.now() - authStartedAt);
          throw err;
        } finally {
          mcpInFlightAdd(-1);
        }
      }
    : undefined;

const server = new FastMCP<BrowserlessSession>({
  name: 'browserless-mcp-selfhosted',
  version: pkg.version,
  ...(oauthProvider ? { auth: oauthProvider } : {}),
  authenticate: hybridAuthenticate,
});

instrumentFastMcpTools(server, amplitudeAnalytics);
registerSurface(server, config, analytics);

// Export metrics + logs to an OTLP collector. Gated like the rest of the fleet:
// the OTEL_ENABLED master toggle must be "true" (the flag enterprise/workers use)
// AND OTEL_EXPORTER_OTLP_ENDPOINT must point at a collector — and only on the
// httpStream transport, since stdio keeps stdout a clean JSON-RPC channel
// (nothing is started there). Best-effort: a telemetry failure must never block
// or crash the server.
let telemetryShutdown: (() => Promise<void>) | undefined;
const otelEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
if (
  config.transport === 'httpStream' &&
  process.env.OTEL_ENABLED === 'true' &&
  process.env.OTEL_SDK_DISABLED?.trim().toLowerCase() !== 'true' &&
  otelEndpoint
) {
  try {
    const { initTelemetry } = await import('./lib/metrics.js');
    telemetryShutdown = initTelemetry({
      endpoint: otelEndpoint,
      serviceName: process.env.OTEL_SERVICE_NAME ?? 'browserless-mcp',
      serviceVersion: pkg.version,
      getLiveSessionCount: () => server.sessions.length,
    });
  } catch (err) {
    console.error(
      '[browserless-mcp] telemetry init failed:',
      err instanceof Error ? (err.stack ?? err.message) : err,
    );
  }
}
console.error(
  '[browserless-mcp] Tools: browserless_function, browserless_performance',
);

let warnedAboutServerIdentity = false;
server.on('connect', (event) => {
  const id = event.session.sessionId ?? 'stdio';
  // Stamp activity so the idle reaper gives a fresh session a full TTL.
  touchSession(event.session.sessionId);
  console.error(`[browserless-mcp] Client connected: ${id}`);
  if (
    amplitudeAnalytics &&
    !warnedAboutServerIdentity &&
    !(event.session.server instanceof Server)
  ) {
    warnedAboutServerIdentity = true;
    console.warn(
      '[browserless-mcp] WARNING: FastMCP session server is not an MCP SDK Server; Amplitude instrumentation may be disabled.',
    );
  }
  // force the client to refresh its tool list on connect
  void event.session.triggerListChangedNotification(
    'notifications/tools/list_changed',
  );
});

if (amplitudeAnalytics || telemetryShutdown) {
  let shuttingDown = false;
  const shutdown = (exitCode: number): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    void (async () => {
      try {
        if (amplitudeAnalytics)
          await shutdownAmplitudeAnalytics(amplitudeAnalytics);
        // Flush the final metric + log batch before exit.
        if (telemetryShutdown) await telemetryShutdown();
      } finally {
        process.exit(exitCode);
      }
    })();
  };
  process.once('SIGTERM', () => shutdown(143));
  process.once('SIGINT', () => shutdown(130));
}

server.on('disconnect', (event) => {
  const id = event.session.sessionId ?? 'stdio';
  clearSession(event.session.sessionId);
  forgetSession(event.session.sessionId);
  // FastMCP removes disconnected sessions without clearing their keepalive timer.
  void Promise.resolve(event.session.close()).catch(() => {});
  console.error(`[browserless-mcp] Client disconnected: ${id}`);
});

// Backstop for abandoned httpStream transports that never fire `disconnect`:
// close MCP sessions idle past the TTL so their ping intervals cannot pile up.
startSessionReaper(() => server.sessions);

if (config.transport === 'httpStream') {
  server.start({
    transportType: 'httpStream',
    httpStream: {
      port: config.port,
      host: '0.0.0.0',
      eventStore: new BoundedEventStore(10_000),
      stateless: false,
    },
  });
  if (oauthProvider) {
    const limiter = createRegisterRateLimiter({
      redis: redisClient,
      limitPerHour: config.oauthRegisterRateLimitPerHour,
    });
    server.getApp().use('/oauth/register', async (c, next) => {
      if (c.req.method !== 'POST') return await next();
      // Deploy behind a trusted proxy that overwrites X-Real-IP.
      const incoming = (c.env as { incoming?: IncomingMessage } | undefined)
        ?.incoming;
      const ip =
        c.req.header('x-real-ip')?.trim() ||
        incoming?.socket?.remoteAddress ||
        'unknown';
      const { allowed, retryAfterSeconds } = await limiter.hit(ip);
      if (!allowed) {
        console.warn('[browserless-mcp] DCR rate limit hit', { ip });
        return c.json(
          {
            error: 'too_many_requests',
            error_description:
              'Too many client registrations from this address',
          },
          429,
          {
            'Retry-After': String(retryAfterSeconds),
            'Cache-Control': 'no-store',
          },
        );
      }
      // Leave the body unread for FastMCP's OAuth route.
      await next();
    });
  }
  // Single-use, out-of-band fetch for captured downloads (the LLM GETs the file
  // instead of pulling bytes through the conversation). httpStream only.
  registerDownloadRoute(server, config);

  console.error(
    `[browserless-mcp] HTTP Streamable server listening on port ${config.port}`,
  );
} else {
  server.start({
    transportType: 'stdio',
  });
}

export { server };
