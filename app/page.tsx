import Link from 'next/link';
import type { ReactNode } from 'react';

import { CONFIG } from '@/lib/config/constants';
import { explorerAddressUrl } from '@/lib/credibility/explorer';
import {
  DEFAULT_MERIT_REGISTRY_ADDRESS,
  GITHUB_REPO_URL,
  meritRegistryExplorerUrl,
} from '@/lib/site/links';

import styles from './home.module.css';

/**
 * `/` — the landing surface. A static server component in the app-wide dark
 * theme: what Vector is, the one-line pipeline, the three pillars, and the
 * verifiable on-chain facts — every value single-sourced from the seeded
 * `CONFIG` (never a second hardcoded literal).
 */
export default function HomePage(): ReactNode {
  const meritRegistryAddress = process.env.MERIT_REGISTRY_ADDRESS ?? DEFAULT_MERIT_REGISTRY_ADDRESS;

  return (
    <main className={styles.screen}>
      <div className={styles.inner}>
        <p className={styles.kicker}>Mantle · Agentic Economy</p>
        <h1 className={styles.title}>
          Vector<span className={styles.titleAccent}>.</span> The merit layer for autonomous
          capital.
        </h1>
        <p className={styles.lede}>
          Agents propose; they never hold keys. A bounded-execution <strong>referee</strong> gates
          every signed Intent, a deterministic <strong>AgentScore</strong> turns behaviour into
          reputation, and a reputation-weighted <strong>capital router</strong> moves the pool —
          anchored on-chain via ERC-8004 on Mantle Sepolia. Prompt injection cannot drain funds.
        </p>

        <div className={styles.ctas}>
          <Link href="/arena" className={styles.ctaPrimary}>
            Watch the Arena →
          </Link>
          <Link href="/attestations" className={styles.ctaSecondary}>
            Attestation Log
          </Link>
          <Link href="/onboarding" className={styles.ctaSecondary}>
            Build a compatible agent
          </Link>
        </div>

        <div className={styles.pipeline}>
          <code>
            signal → decide → intent → referee → execution → outcome → AgentScore → ERC-8004
            attestation → capital re-route
          </code>
        </div>

        <ul className={styles.cards}>
          <li className={styles.card}>
            <h2 className={styles.cardTitle}>Referee / firewall</h2>
            <p className={styles.cardBody}>
              A pure, deterministic execution gate: kill switch, halts, market whitelist,
              fresh-wallet drain block, drawdown breaker, spend cap. A fund-draining transfer is
              always rejected — and the rejection is a recorded policy event.
            </p>
          </li>
          <li className={styles.card}>
            <h2 className={styles.cardTitle}>AgentScore 0–100</h2>
            <p className={styles.cardBody}>
              Merit as a pure function: bounded performance × anti-Sybil capital weight + policy
              bonus − drawdown penalty, EWMA-smoothed. A confirmed drain crashes reputation to ≤{' '}
              {CONFIG.scoring.crash_cap} regardless of prior standing.
            </p>
          </li>
          <li className={styles.card}>
            <h2 className={styles.cardTitle}>Capital router</h2>
            <p className={styles.cardBody}>
              Reputation-weighted allocation of a conserved {CONFIG.capital.pool_size.toLocaleString('en-US')}{' '}
              {CONFIG.capital.capital_unit_label} pool: eligibility gate, temperature-softmax,
              hysteresis, cooldown — conserved to the last unit, reroute on crash.
            </p>
          </li>
        </ul>

        <h2 className={styles.factsTitle}>Verifiable on-chain</h2>
        <dl className={styles.facts}>
          <div>
            <dt>Network</dt>
            <dd>Mantle Sepolia (chainId {CONFIG.chain.mantle_testnet_chain_id})</dd>
          </div>
          <div>
            <dt>VectorMeritRegistry</dt>
            <dd>
              <a href={meritRegistryExplorerUrl()} target="_blank" rel="noopener noreferrer">
                <span className={styles.mono}>{meritRegistryAddress}</span> ↗
              </a>
            </dd>
          </div>
          <div>
            <dt>ERC-8004 Identity Registry</dt>
            <dd>
              <a
                href={explorerAddressUrl(CONFIG.chain.identity_registry_address) ?? '#'}
                target="_blank"
                rel="noopener noreferrer"
              >
                <span className={styles.mono}>{CONFIG.chain.identity_registry_address}</span> ↗
              </a>
            </dd>
          </div>
          <div>
            <dt>ERC-8004 Reputation Registry</dt>
            <dd>
              <a
                href={explorerAddressUrl(CONFIG.chain.reputation_registry_address) ?? '#'}
                target="_blank"
                rel="noopener noreferrer"
              >
                <span className={styles.mono}>{CONFIG.chain.reputation_registry_address}</span> ↗
              </a>
            </dd>
          </div>
          <div>
            <dt>Source</dt>
            <dd>
              <a href={GITHUB_REPO_URL} target="_blank" rel="noopener noreferrer">
                github.com/markosiks/Vector ↗
              </a>
            </dd>
          </div>
        </dl>

        <footer className={styles.footer}>
          <Link href="/operator">Operator console</Link>
          <Link href="/health">Service health</Link>
          <a href="/api/health">/api/health</a>
        </footer>
      </div>
    </main>
  );
}
