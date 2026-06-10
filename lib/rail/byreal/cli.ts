import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

import type { ByrealCredentials } from './credentials';

/**
 * Safe Byreal CLI subprocess invocation (P2.1).
 *
 * Hardening:
 *  - **No shell.** The CLI is launched with `spawn(execPath, [cliPath, ...argv])`
 *    — an argv array handed straight to the OS, never a shell string — so shell
 *    metacharacters in any argument are inert (there is no shell to interpret
 *    them). The interpreter is the current JS runtime (`process.execPath`), not
 *    the CLI's `#!/usr/bin/env node` shebang, so it runs identically under Node
 *    and Bun.
 *  - **Credential isolation.** The child receives a *minimal, explicit* env
 *    (`PATH`/`HOME` for the CLI's own config dir, the scoped key + wallet, and
 *    the validated network). The parent's environment — every other secret — is
 *    **not** inherited, so a bug in the CLI cannot exfiltrate unrelated secrets,
 *    and the scoped key lives only in the child env, never in argv, logs, or
 *    this module's output.
 *  - **Bounded.** A hard timeout kills a hung process (SIGTERM then SIGKILL) and
 *    a stdout cap kills a runaway one; both surface as a deterministic error the
 *    caller degrades to the seed fallback.
 */

/** A hung CLI exceeded its timeout and was killed. */
export class ByrealCliTimeout extends Error {
  constructor(timeoutMs: number) {
    super(`byreal CLI timed out after ${timeoutMs}ms`);
    this.name = 'ByrealCliTimeout';
  }
}

/** The CLI process could not be spawned (binary missing, OS error). */
export class ByrealCliSpawnError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ByrealCliSpawnError';
  }
}

/** The raw result of a CLI run. A non-zero `code` is normal (error envelopes). */
export interface ByrealCliResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number | null;
}

/** Options for {@link runByrealCli}. */
export interface RunByrealCliOptions {
  readonly credentials: ByrealCredentials;
  /** Hard wall-clock timeout; the process is killed past it. */
  readonly timeoutMs: number;
  /** Explicit path to the CLI entry (`dist/index.cjs`); else package-resolved. */
  readonly cliPath?: string;
  /** Stdout byte cap; exceeding it kills the process. Default 2 MiB. */
  readonly maxOutputBytes?: number;
}

/**
 * B-05: align the process-kill threshold with envelope.ts's parse-rejection
 * threshold so no stdout range is rejected by the parser yet not killed by the
 * process cap. Both modules use 1 MiB.
 */
const DEFAULT_MAX_OUTPUT_BYTES = 1_024 * 1_024;

/** Resolve the CLI entry script from an explicit path or the installed package. */
export function resolveCliPath(explicit?: string): string {
  if (explicit !== undefined && explicit.length > 0) return explicit;
  try {
    const require = createRequire(import.meta.url);
    // Resolve the package's bin entry without executing it.
    return require.resolve('@byreal-io/byreal-perps-cli/dist/index.cjs');
  } catch {
    throw new ByrealCliSpawnError(
      'byreal CLI not found: install @byreal-io/byreal-perps-cli or set BYREAL_PERPS_CLI_PATH',
    );
  }
}

/**
 * Build the minimal, secret-scoped child environment.
 *
 * Exported for the credential-isolation regression test: the child must receive
 * *only* `PATH`/`HOME` (for the CLI's own config dir), the scoped key and wallet,
 * and the validated network — never the parent's other secrets.
 *
 * `BYREAL_PERPS_NETWORK` is forwarded as defense-in-depth so the subprocess is
 * pinned to the same network the adapter validated at construction. Note the CLI
 * ultimately resolves its network from its stored account config (keyed by
 * `HOME`), so this env var only hardens CLI versions that honour it; the
 * load-bearing guard against real-money orders remains the construction-time
 * refusal of `mainnet` credentials in {@link import('./adapter').createByrealRail}.
 */
export function buildChildEnv(credentials: ByrealCredentials): Record<string, string> {
  return {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    BYREAL_PERPS_AGENT_KEY: credentials.agentKey,
    BYREAL_PERPS_WALLET_ADDRESS: credentials.walletAddress,
    BYREAL_PERPS_NETWORK: credentials.network,
  };
}

/**
 * Run one Byreal CLI command. `subArgv` is the subcommand (e.g.
 * `['order','market','long','0.01','BTC']`); the global `-o json` (structured
 * output) and `-y` (skip confirmations) flags are prepended here so every call
 * is non-interactive and machine-parseable.
 *
 * Resolves with the captured stdout/stderr/exit code — including when the CLI
 * exits non-zero, because a failed command still prints a `{success:false}`
 * envelope the caller parses. Rejects only on a spawn failure, a timeout, or an
 * output-cap breach.
 */
export function runByrealCli(
  subArgv: readonly string[],
  options: RunByrealCliOptions,
): Promise<ByrealCliResult> {
  const cliPath = resolveCliPath(options.cliPath);
  const maxBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const argv = [cliPath, '-o', 'json', '-y', ...subArgv];

  return new Promise<ByrealCliResult>((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(process.execPath, argv, {
        // B-07: Record<string,string> is a subtype of NodeJS.ProcessEnv;
        // the cast is retained because exactOptionalPropertyTypes:true and the
        // bun-types ProcessEnv augmentation (Bun.Env) make structural assignment
        // require an explicit narrowing. The cast is safe: the child only ever
        // receives the five intentional keys built by buildChildEnv.
        env: buildChildEnv(options.credentials) as NodeJS.ProcessEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      reject(new ByrealCliSpawnError(err instanceof Error ? err.message : 'spawn failed'));
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      // The SIGKILL escalation timer is intentionally NOT cleared here: settling
      // the promise (e.g. rejecting on timeout) must not cancel the pending
      // SIGKILL, or a process that ignores SIGTERM would never be force-killed
      // and would leak as a zombie. It is cleared on `close`, once the process
      // has actually exited.
      fn();
    };

    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      // Escalate if the process ignores SIGTERM. `unref` so this lone timer
      // cannot, by itself, keep the event loop alive.
      killTimer = setTimeout(() => child.kill('SIGKILL'), 1_000);
      killTimer.unref?.();
      finish(() => reject(new ByrealCliTimeout(options.timeoutMs)));
    }, options.timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
      if (stdout.length > maxBytes) {
        child.kill('SIGKILL');
        finish(() => reject(new ByrealCliSpawnError('byreal CLI exceeded output cap')));
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      // B-08: slice before appending to avoid peak allocation reaching maxBytes
      // before the post-hoc trim (a single large chunk would otherwise spike
      // to chunk.length before being cut back to maxBytes).
      if (stderr.length < maxBytes) {
        stderr += chunk.toString('utf8').slice(0, maxBytes - stderr.length);
      }
    });

    child.on('error', (err) => {
      finish(() => reject(new ByrealCliSpawnError(err.message)));
    });
    child.on('close', (code) => {
      // The process has exited; cancel any pending SIGKILL escalation.
      if (killTimer !== undefined) clearTimeout(killTimer);
      finish(() => resolve({ stdout, stderr, code }));
    });
  });
}
