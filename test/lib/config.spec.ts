import { expect } from 'chai';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import {
  getConfig,
  classifyComplianceInput,
  DEFAULT_API_SERVER_URL,
} from '../../src/config.js';

const ENV_KEY = 'OAUTH_ADDITIONAL_REDIRECT_URI_PATTERNS';
const BASELINE_PATTERNS = [
  'http://localhost:*',
  'http://127.0.0.1:*',
  'http://127.0.0.1/',
  'https://vscode.dev/redirect',
  'https://insiders.vscode.dev/redirect',
  'https://claude.ai/api/mcp/auth_callback',
  'https://chatgpt.com/connector/oauth/*',
  'https://chatgpt.com/connector_platform_oauth_redirect',
  'https://grok.com/connectors/oauth/callback',
  'https://grok.com/connectors/oauth/callback/',
  'cursor://anysphere.cursor-mcp/oauth/callback',
  'https://www.cursor.com/agents/mcp/oauth/callback',
  'https://api.devin.ai/mcp/oauth/callback',
  'https://api.beta.devin.ai/mcp/oauth/callback',
  'https://api.itsdev.in/mcp/oauth/callback',
  'https://www.make.com/oauth/cb/mcp',
  'https://us1.make.celonis.com/oauth/cb/mcp',
  'https://eu1.make.celonis.com/oauth/cb/mcp',
];

describe('self-hosted configuration', () => {
  const keys = ['BROWSERLESS_API_URL', 'MCP_BASE_URL', 'PORT'];
  let original: Record<string, string | undefined>;

  beforeEach(() => {
    original = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    for (const key of keys) delete process.env[key];
  });
  afterEach(() => {
    for (const key of keys) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
  });

  it('defaults to local Browserless and MCP URLs', () => {
    expect(getConfig().browserlessApiUrl).to.equal('http://localhost:3000');
    expect(getConfig().mcpBaseUrl).to.equal('http://localhost:8080');
  });

  it('uses the configured HTTP port unless MCP_BASE_URL is explicit', () => {
    process.env.PORT = '9080';
    expect(getConfig().mcpBaseUrl).to.equal('http://localhost:9080');
    process.env.MCP_BASE_URL = 'https://mcp.example.test';
    expect(getConfig().mcpBaseUrl).to.equal('https://mcp.example.test');
  });

  it('normalizes the configured runtime base', () => {
    process.env.BROWSERLESS_API_URL = 'http://browserless:3000/runtime///';
    expect(getConfig().browserlessApiUrl).to.equal(
      'http://browserless:3000/runtime',
    );
  });

  it('rejects empty, malformed, non-HTTP, and credential-bearing runtime URLs', () => {
    for (const value of [
      '',
      'not a URL',
      'file:///runtime',
      'http://user:secret@browserless',
      'http://browserless?token=secret',
      'http://browserless#',
      'http://browserless?',
    ]) {
      process.env.BROWSERLESS_API_URL = value;
      expect(() => getConfig()).to.throw();
    }
  });
});

describe('config.uploadDirs', () => {
  let originalDownload: string | undefined;
  let originalUpload: string | undefined;

  beforeEach(() => {
    originalDownload = process.env.BROWSERLESS_DOWNLOAD_DIR;
    originalUpload = process.env.BROWSERLESS_UPLOAD_DIRS;
    delete process.env.BROWSERLESS_DOWNLOAD_DIR;
    delete process.env.BROWSERLESS_UPLOAD_DIRS;
  });

  afterEach(() => {
    if (originalDownload === undefined)
      delete process.env.BROWSERLESS_DOWNLOAD_DIR;
    else process.env.BROWSERLESS_DOWNLOAD_DIR = originalDownload;
    if (originalUpload === undefined)
      delete process.env.BROWSERLESS_UPLOAD_DIRS;
    else process.env.BROWSERLESS_UPLOAD_DIRS = originalUpload;
  });

  it('defaults to only the download directory for unset or empty input', () => {
    expect(getConfig().uploadDirs).to.deep.equal([
      join(tmpdir(), 'browserless-mcp-downloads'),
    ]);
    for (const value of ['', delimiter + delimiter]) {
      process.env.BROWSERLESS_UPLOAD_DIRS = value;
      expect(getConfig().uploadDirs).to.deep.equal([
        join(tmpdir(), 'browserless-mcp-downloads'),
      ]);
    }
  });

  it('keeps the configured download directory and resolves explicit extra roots', () => {
    process.env.BROWSERLESS_DOWNLOAD_DIR = 'downloads';
    process.env.BROWSERLESS_UPLOAD_DIRS = ['uploads', '', 'other'].join(
      delimiter,
    );
    expect(getConfig().uploadDirs).to.deep.equal([
      resolve('downloads'),
      resolve('uploads'),
      resolve('other'),
    ]);
  });
});

describe('config.oauthAllowedRedirectUriPatterns', () => {
  let original: string | undefined;

  beforeEach(() => {
    original = process.env[ENV_KEY];
    delete process.env[ENV_KEY];
  });

  afterEach(() => {
    if (original === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = original;
  });

  it('returns exactly the baseline defaults when the env var is unset', () => {
    const patterns = getConfig().oauthAllowedRedirectUriPatterns;
    expect(patterns).to.have.members(BASELINE_PATTERNS);
    expect(patterns).to.have.lengthOf(BASELINE_PATTERNS.length);
  });

  it('appends additional patterns to the baseline (does not replace)', () => {
    process.env[ENV_KEY] = 'https://new-host.example.com/*';
    const patterns = getConfig().oauthAllowedRedirectUriPatterns;
    expect(patterns).to.include.members(BASELINE_PATTERNS);
    expect(patterns).to.include('https://new-host.example.com/*');
    expect(patterns).to.have.lengthOf(BASELINE_PATTERNS.length + 1);
  });

  it('splits comma-separated values and trims whitespace', () => {
    process.env[ENV_KEY] = ' https://a.example/*, https://b.example/* ';
    const patterns = getConfig().oauthAllowedRedirectUriPatterns;
    expect(patterns).to.include.members(BASELINE_PATTERNS);
    expect(patterns).to.include('https://a.example/*');
    expect(patterns).to.include('https://b.example/*');
  });

  it('drops empty segments from whitespace/comma-only input and preserves baseline', () => {
    process.env[ENV_KEY] = '  ,  ,   ';
    const patterns = getConfig().oauthAllowedRedirectUriPatterns;
    expect(patterns).to.have.members(BASELINE_PATTERNS);
    expect(patterns).to.have.lengthOf(BASELINE_PATTERNS.length);
  });

  it('treats an empty env var the same as unset', () => {
    process.env[ENV_KEY] = '';
    const patterns = getConfig().oauthAllowedRedirectUriPatterns;
    expect(patterns).to.have.members(BASELINE_PATTERNS);
    expect(patterns).to.have.lengthOf(BASELINE_PATTERNS.length);
  });
});

describe('config.allowedApiUrlHosts', () => {
  const key = 'MCP_ALLOWED_API_URL_HOSTS';
  const original = process.env[key];

  afterEach(() => {
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  });

  it('parses comma-separated hosts and defaults to none', () => {
    delete process.env[key];
    expect(getConfig().allowedApiUrlHosts).to.deep.equal([]);
    process.env[key] = ' extra.example.com, other.example.net ';
    expect(getConfig().allowedApiUrlHosts).to.deep.equal([
      'extra.example.com',
      'other.example.net',
    ]);
  });
});

describe('config.complianceMode for upstream helpers', () => {
  const COMPLIANCE_KEY = 'MCP_COMPLIANCE_MODE';
  let original: string | undefined;

  beforeEach(() => {
    original = process.env[COMPLIANCE_KEY];
    delete process.env[COMPLIANCE_KEY];
  });

  afterEach(() => {
    if (original === undefined) delete process.env[COMPLIANCE_KEY];
    else process.env[COMPLIANCE_KEY] = original;
  });

  it('defaults the compatibility field to false when unset', () => {
    expect(getConfig().complianceMode).to.equal(false);
  });

  it('is true for "true"', () => {
    process.env[COMPLIANCE_KEY] = 'true';
    expect(getConfig().complianceMode).to.equal(true);
  });

  it('fails closed: any set value that is not an explicit opt-out enables compliant mode', () => {
    // '' (set-but-empty) is included: a set var, even empty, must not fall
    // through to the full surface.
    for (const v of ['1', 'yes', 'TRUE', 'on', ' true ', 'garbage', '']) {
      process.env[COMPLIANCE_KEY] = v;
      expect(getConfig().complianceMode, `value ${JSON.stringify(v)}`).to.equal(
        true,
      );
    }
  });

  it('sets the compatibility field to false for explicit opt-out values', () => {
    for (const v of ['false', '0', 'no', 'off', 'FALSE', ' off ']) {
      process.env[COMPLIANCE_KEY] = v;
      expect(getConfig().complianceMode, `value ${JSON.stringify(v)}`).to.equal(
        false,
      );
    }
  });

  it('classifyComplianceInput distinguishes unset / opt-out / opt-in / unrecognized', () => {
    expect(classifyComplianceInput(undefined)).to.equal('unset');
    for (const v of ['false', '0', 'no', 'off', 'FALSE', ' off '])
      expect(classifyComplianceInput(v), v).to.equal('opt-out');
    for (const v of ['true', '1', 'yes', 'on', 'TRUE', ' true '])
      expect(classifyComplianceInput(v), v).to.equal('opt-in');
    // Fumbled values still parse to compliant (fail-closed) but classify as
    // unrecognized so the boot log warns instead of reading them as opt-in.
    for (const v of ['ture', 'compliant', 'garbage', ''])
      expect(classifyComplianceInput(v), v).to.equal('unrecognized');
  });
});

describe('config.apiServerUrl', () => {
  const original = process.env.BROWSERLESS_API_SERVER;

  afterEach(() => {
    if (original === undefined) delete process.env.BROWSERLESS_API_SERVER;
    else process.env.BROWSERLESS_API_SERVER = original;
  });

  it('defaults to the account API host', () => {
    delete process.env.BROWSERLESS_API_SERVER;
    expect(getConfig().apiServerUrl).to.equal(DEFAULT_API_SERVER_URL);
  });

  it('is overridable for self-hosted deployments', () => {
    process.env.BROWSERLESS_API_SERVER = 'https://api.internal.example.com';
    expect(getConfig().apiServerUrl).to.equal(
      'https://api.internal.example.com',
    );
  });

  // The account API and the browser runtime are different hosts; deriving one
  // from the other would send account queries to a browser worker.
  it('is independent of BROWSERLESS_API_URL', () => {
    delete process.env.BROWSERLESS_API_SERVER;
    const previous = process.env.BROWSERLESS_API_URL;
    process.env.BROWSERLESS_API_URL = 'https://runtime.example.com';
    try {
      const config = getConfig();
      expect(config.browserlessApiUrl).to.equal('https://runtime.example.com');
      expect(config.apiServerUrl).to.equal(DEFAULT_API_SERVER_URL);
    } finally {
      if (previous === undefined) delete process.env.BROWSERLESS_API_URL;
      else process.env.BROWSERLESS_API_URL = previous;
    }
  });
});
