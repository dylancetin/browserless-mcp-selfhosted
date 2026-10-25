import { FastMCP, UserError } from 'fastmcp';
import type { Content } from 'fastmcp';
import { z } from 'zod';
import { defineTool } from '../lib/define-tool.js';
import { AnalyticsHelper } from '../lib/analytics.js';
import type {
  FunctionParams,
  GenericApiResult,
  McpConfig,
} from '../@types/types.js';

export const FunctionParamsSchema = z.strictObject({
  code: z
    .string()
    .describe(
      'Browser-context ESM code. The async default export receives { page, context }. ' +
        'Return a raw value, string, or binary typed array, not a { data, type } envelope.',
    ),
  context: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      'Optional data available as context in the default export argument.',
    ),
  timeout: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Request timeout in milliseconds'),
});

/**
 * Hard cap for text responses. Larger payloads are rejected with a clear
 * remediation message instead of silently torching context. ~4 chars/token →
 * 200,000 chars ≈ 50,000 tokens.
 */
export const MAX_TEXT_RESPONSE_CHARS = 200_000;

const EXTENSION_BY_MIME: Record<string, string> = {
  'application/pdf': '.pdf',
  'application/zip': '.zip',
  'application/octet-stream': '.bin',
  'application/json': '.json',
};

const buildMetadata = (response: GenericApiResult): string =>
  [
    '---',
    `Content-Type: ${response.contentType}`,
    `Status: ${response.statusCode}`,
    `Size: ${response.size} bytes`,
    '---',
  ].join('\n');

/**
 * Convert a /function HTTP response into MCP content blocks: image/* and
 * audio/* become vision/audio input, other binary becomes a resource blob,
 * and text becomes TextContent (throws past MAX_TEXT_RESPONSE_CHARS).
 */
export const formatFunctionContent = (
  response: GenericApiResult,
): Content[] => {
  const baseMime = response.contentType.split(';')[0].trim().toLowerCase();
  const metadata = buildMetadata(response);

  if (response.isBinary) {
    if (baseMime.startsWith('image/')) {
      return [
        { type: 'text', text: metadata },
        { type: 'image', data: response.data, mimeType: baseMime },
      ];
    }
    if (baseMime.startsWith('audio/')) {
      return [
        { type: 'text', text: metadata },
        { type: 'audio', data: response.data, mimeType: baseMime },
      ];
    }
    const ext = EXTENSION_BY_MIME[baseMime] ?? '.bin';
    return [
      { type: 'text', text: metadata },
      {
        type: 'resource',
        resource: {
          uri: `browserless://function/result${ext}`,
          mimeType: baseMime,
          blob: response.data,
        },
      },
    ];
  }

  if (response.data.length > MAX_TEXT_RESPONSE_CHARS) {
    const approxTokens = Math.round(response.data.length / 4);
    const capTokens = Math.round(MAX_TEXT_RESPONSE_CHARS / 4);
    throw new UserError(
      `Function returned ${response.data.length} chars (~${approxTokens} tokens), ` +
        `exceeding the ${MAX_TEXT_RESPONSE_CHARS}-char (~${capTokens}-token) limit. ` +
        `Filter or summarize inside your function. For image/png or application/pdf output, ` +
        `return the raw bytes from page.screenshot() or page.pdf(), not a { data, type } envelope.`,
    );
  }

  return [
    { type: 'text', text: response.data },
    { type: 'text', text: metadata },
  ];
};

export function registerFunctionTool(
  server: FastMCP,
  config: McpConfig,
  analytics?: AnalyticsHelper,
): void {
  defineTool<FunctionParams, GenericApiResult>(server, config, analytics, {
    name: 'browserless_function',
    failureStatus: { origin: 'api', badRequest: 'SCRIPT_ERROR' },
    description:
      'Execute Puppeteer JavaScript on the configured self-hosted Browserless instance. ' +
      'Use an async ESM default export, for example export default async ({ page, context }) => { ' +
      'await page.goto(context.url); return await page.title(); }. ' +
      'Code runs in a browser context, not Node.js. process, Buffer, require, and module are unavailable. ' +
      'Return raw JSON values, text, HTML, or binary typed arrays. ' +
      'Return await page.screenshot({ type: "png" }) for an image block, ' +
      'or await page.pdf() for a PDF resource block. ' +
      'Browserless determines the response MIME type. Objects with data and type fields remain literal JSON. ' +
      'Text responses are capped at 200,000 characters. Filter larger results inside the function.',
    parameters: FunctionParamsSchema,
    annotations: {
      title: 'Browserless Function',
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: true,
    },
    run: async ({ client, params, log }) => {
      if ('profile' in params) {
        throw new UserError('Authentication profiles are not supported.');
      }
      const response = await client.runFunction({
        code: params.code,
        context: params.context,
        timeout: params.timeout,
      });
      log.debug(
        `Function response: ok=${response.ok}, status=${response.statusCode}, ` +
          `contentType=${response.contentType}, size=${response.size}`,
      );
      return response;
    },
    analyticsProps: (_params, result) => ({
      ok: result.ok,
      status_code: result.statusCode,
      content_type: result.contentType,
      size: result.size,
    }),
    format: (response) => {
      if (!response.ok) {
        throw new UserError(
          `Function execution failed (status ${response.statusCode}): ${response.data.slice(0, 500)}`,
        );
      }
      return formatFunctionContent(response);
    },
  });
}
