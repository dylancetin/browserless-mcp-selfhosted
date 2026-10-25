import { FastMCP } from 'fastmcp';
import type { McpConfig } from '../@types/types.js';
import { AnalyticsHelper } from '../lib/analytics.js';
import { registerFunctionTool } from './function.js';
import { registerPerformanceTool } from './performance.js';
import { registerStatusResource } from '../resources/status.js';

export function registerSurface(
  server: FastMCP,
  config: McpConfig,
  analytics?: AnalyticsHelper,
): void {
  registerFunctionTool(server, config, analytics);
  registerPerformanceTool(server, config, analytics);
  registerStatusResource(server, config);
}
