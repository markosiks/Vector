import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, test } from 'bun:test';

import type { ByrealCredentials } from '@/lib/rail/byreal/credentials';
import {
  buildChildEnv,
  resolveCliPath,
  runByrealCli,
  ByrealCliSpawnError,
  ByrealCliTimeout,
} from '@/lib/rail/byreal/cli';

/**
 * Unit: the safe subprocess boundary (P2.1). Real `spawn` against a tiny stub
 * script proves no-shell argv passing, the timeout kill, and the output cap; the
 * env builder proves credential isolation (the scoped key reaches the child and
 * nothing else does).
 */

const CREDS: ByrealCredentials = {
  agentKey: 'scoped-key-123',
  walletAddress: `0x${'a'.repeat(40)}`,
  network: 'testnet',
};

const dir = mkdtempSync(join(tmpdir(), 'byreal-cli-'));
afterAll(() => {
  // Best-effort; the OS tmp reaper handles the rest.
});

/** Write a stub "CLI" the test runtime can execute via `process.execPath`. */
function stub(name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, body);
  return path;
}

describe('buildChildEnv — credential isolation', () => {
  test('passes only PATH/HOME + the scoped key & wallet, not other parent secrets', () => {
    process.env.BYREAL_TEST_OTHER_SECRET = 'must-not-leak';
    try {
      const env = buildChildEnv(CREDS);
      expect(env.BYREAL_PERPS_AGENT_KEY).toBe('scoped-key-123');
      expect(env.BYREAL_PERPS_WALLET_ADDRESS).toBe(`0x${'a'.repeat(40)}`);
      expect(Object.keys(env).sort()).toEqual([
        'BYREAL_PERPS_AGENT_KEY',
        'BYREAL_PERPS_WALLET_ADDRESS',
        'HOME',
        'PATH',
      ]);
      expect(Object.values(env)).not.toContain('must-not-leak');
    } finally {
      delete process.env.BYREAL_TEST_OTHER_SECRET;
    }
  });
});

describe('resolveCliPath', () => {
  test('returns an explicit path verbatim', () => {
    expect(resolveCliPath('/opt/byreal/index.cjs')).toBe('/opt/byreal/index.cjs');
  });

  test('throws a clear error when the package is not installed', () => {
    // @byreal-io/byreal-perps-cli is not a dependency of this repo.
    expect(() => resolveCliPath()).toThrow(ByrealCliSpawnError);
  });
});

describe('runByrealCli — real subprocess', () => {
  test('captures stdout and exit code; passes argv without a shell', async () => {
    // Echoes its argv as JSON; a shell-metachar arg must arrive intact, inert.
    const cli = stub(
      'echo.cjs',
      'console.log(JSON.stringify({ success: true, data: { argv: process.argv.slice(2) } }));',
    );
    const res = await runByrealCli(['order', 'market', 'long', '0.01; rm -rf /', 'BTC'], {
      credentials: CREDS,
      timeoutMs: 5_000,
      cliPath: cli,
    });
    expect(res.code).toBe(0);
    const parsed = JSON.parse(res.stdout) as { data: { argv: string[] } };
    // Global flags are prepended; the dangerous arg is one inert argv element.
    expect(parsed.data.argv).toEqual([
      '-o',
      'json',
      '-y',
      'order',
      'market',
      'long',
      '0.01; rm -rf /',
      'BTC',
    ]);
  });

  test('injects the scoped key into the child env only', async () => {
    const cli = stub(
      'env.cjs',
      'console.log(JSON.stringify({ key: process.env.BYREAL_PERPS_AGENT_KEY, leak: process.env.BYREAL_TEST_LEAK ?? null }));',
    );
    process.env.BYREAL_TEST_LEAK = 'nope';
    try {
      const res = await runByrealCli(['account', 'info'], {
        credentials: CREDS,
        timeoutMs: 5_000,
        cliPath: cli,
      });
      const parsed = JSON.parse(res.stdout) as { key: string; leak: string | null };
      expect(parsed.key).toBe('scoped-key-123');
      expect(parsed.leak).toBeNull();
    } finally {
      delete process.env.BYREAL_TEST_LEAK;
    }
  });

  test('resolves (does not reject) on a non-zero exit — error envelopes still parse', async () => {
    const cli = stub(
      'fail.cjs',
      'console.log(JSON.stringify({ success: false, error: { code: "X", message: "boom" } })); process.exit(1);',
    );
    const res = await runByrealCli(['order', 'market', 'long', '1', 'BTC'], {
      credentials: CREDS,
      timeoutMs: 5_000,
      cliPath: cli,
    });
    expect(res.code).toBe(1);
    expect(res.stdout).toContain('"success":false');
  });

  test('kills and rejects a process that exceeds the timeout', async () => {
    const cli = stub('hang.cjs', 'setTimeout(() => {}, 60_000);');
    await expect(
      runByrealCli(['account', 'info'], { credentials: CREDS, timeoutMs: 200, cliPath: cli }),
    ).rejects.toBeInstanceOf(ByrealCliTimeout);
  });

  test('kills and rejects when stdout exceeds the output cap', async () => {
    const cli = stub(
      'flood.cjs',
      'const big = "x".repeat(100_000); for (let i = 0; i < 1000; i++) process.stdout.write(big);',
    );
    await expect(
      runByrealCli(['account', 'info'], {
        credentials: CREDS,
        timeoutMs: 5_000,
        cliPath: cli,
        maxOutputBytes: 50_000,
      }),
    ).rejects.toBeInstanceOf(ByrealCliSpawnError);
  });
});
