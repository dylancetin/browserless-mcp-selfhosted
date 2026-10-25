import { expect } from 'chai';
import sinon from 'sinon';
import { FastMCP } from 'fastmcp';
import { z } from 'zod';
import { getConfig } from '../../src/config.js';
import { registerSurface } from '../../src/tools/register.js';
import { LighthouseCategorySchema } from '../../src/tools/performance.js';

describe('self-hosted registry', () => {
  afterEach(() => sinon.restore());

  for (const transport of ['stdio', 'httpStream'] as const) {
    for (const complianceMode of [false, true]) {
      it(`exposes only supported tools on ${transport}, compliance=${complianceMode}`, async () => {
        const server = new FastMCP({ name: 'test', version: '0.1.0' });
        const tools = sinon.spy(server, 'addTool');
        const prompts = sinon.spy(server, 'addPrompt');
        const resources = sinon.spy(server, 'addResource');
        registerSurface(server, {
          ...getConfig(),
          transport,
          complianceMode,
          browserlessToken: undefined,
        });
        expect(
          tools
            .getCalls()
            .map(({ args }) => args[0].name)
            .sort(),
        ).to.deep.equal(['browserless_function', 'browserless_performance']);
        expect(prompts.called).to.be.false;
        expect(
          resources.getCalls().map(({ args }) => args[0].uri),
        ).to.deep.equal(['browserless://status']);
        for (const { args } of tools.getCalls()) {
          const tool = args[0];
          const schema = tool.parameters as z.ZodObject;
          const keys = Object.keys(schema.shape).sort();
          const input =
            tool.name === 'browserless_function'
              ? { code: 'export default () => "ok"' }
              : { url: 'http://example.test' };
          expect(keys).to.deep.equal(
            tool.name === 'browserless_function'
              ? ['code', 'context', 'timeout']
              : ['budgets', 'categories', 'config', 'device', 'timeout', 'url'],
          );
          expect(schema.safeParse(input).success).to.be.true;
          for (const extra of [
            { profile: 'ignored' },
            { profile: undefined },
            { _prompt: 'hidden input' },
          ]) {
            expect(schema.safeParse({ ...input, ...extra }).success).to.be
              .false;
          }
          expect(tool.description).to.not.match(
            /Browserless cloud|saveProfile|uploadFile|browserless_agent/,
          );
        }
        const status = await resources.firstCall.args[0].load({} as never);
        expect(JSON.parse((status as { text: string }).text)).to.include({
          surface: 'self-hosted',
          ok: false,
        });
        expect(JSON.stringify(status)).to.not.include('Authorization');
      });
    }
  }

  it('accepts only the four supported Lighthouse categories', () => {
    expect(LighthouseCategorySchema.options).to.deep.equal([
      'accessibility',
      'best-practices',
      'performance',
      'seo',
    ]);
    expect(LighthouseCategorySchema.safeParse('pwa').success).to.be.false;
  });
});
