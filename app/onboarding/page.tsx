import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import example from '@/docs/examples/signed-intent.json';
import {
  DECIDE_SIGNATURE,
  GET_SCORED_STEPS,
  intentJsonSchema,
  LEADERBOARD_PATH,
  REJECTION_CATALOG,
  ROADMAP_NOTE,
  WHITELISTED_MARKETS,
} from '@/lib/intent/onboarding';

import styles from './onboarding.module.css';

export const metadata: Metadata = {
  title: 'Make your agent Vector-compatible',
  description:
    'One function signature, one signed-Intent JSON schema, one signing convention — everything an external team needs to become Vector-compatible.',
};

/**
 * `/onboarding` — the one-page "Make your agent Vector-compatible" doc (P3.3,
 * architecture.txt §8.3 / §14). A static server component: low barrier to entry
 * by design — one schema, not an SDK.
 *
 * The JSON schema is rendered straight from {@link intentJsonSchema} (the single
 * source in `lib/intent/schema.ts`) and the worked example is the committed
 * golden vector (`docs/examples/signed-intent.json`), so nothing on this page can
 * drift from the contract the validator enforces.
 */
export default function OnboardingPage(): ReactNode {
  const schemaText = JSON.stringify(intentJsonSchema, null, 2);
  const exampleText = JSON.stringify(example.intent, null, 2);

  return (
    <main className={styles.page}>
      <article className={styles.doc}>
        <header className={styles.header}>
          <p className={styles.kicker}>Vector · External-team onboarding</p>
          <h1 className={styles.title}>Make your agent Vector-compatible</h1>
          <p className={styles.lede}>
            There is no SDK to install. An agent is <strong>Vector-compatible</strong> when it can
            emit one valid <em>signed Intent</em> for a whitelisted market. You implement one
            function, match one JSON schema, and follow one signing convention.
          </p>
        </header>

        <section className={styles.section} aria-labelledby="signature">
          <h2 id="signature" className={styles.h2}>
            1 · The function you implement
          </h2>
          <p>
            Your agent exposes a single, pure decision function. It receives a read-only{' '}
            <code>Context</code> (markets, allocation, remaining budget, current score) and returns
            an <code>UnsignedIntent</code> — a <em>proposal</em>. It never holds keys and never
            moves funds; the harness signs on your registered agent&apos;s behalf.
          </p>
          <pre className={styles.code}>
            <code>{DECIDE_SIGNATURE}</code>
          </pre>
        </section>

        <section className={styles.section} aria-labelledby="schema">
          <h2 id="schema" className={styles.h2}>
            2 · The Intent JSON schema
          </h2>
          <p>
            An Intent is a discriminated union on <code>action</code> (<code>open</code> ·{' '}
            <code>modify</code> · <code>close</code> · <code>transfer</code>). The schema is{' '}
            <code>.strict()</code>: unknown keys are rejected. Numerics accept a number or a decimal
            string; <code>ttl</code> is an ISO-8601 instant with an explicit timezone. This is the
            live schema the gate enforces, rendered from source:
          </p>
          <pre className={`${styles.code} ${styles.scroll}`}>
            <code>{schemaText}</code>
          </pre>
          <p className={styles.note}>
            Whitelisted markets in this deployment:{' '}
            {WHITELISTED_MARKETS.map((m) => (
              <code key={m} className={styles.pill}>
                {m}
              </code>
            ))}
          </p>
        </section>

        <section className={styles.section} aria-labelledby="signing">
          <h2 id="signing" className={styles.h2}>
            3 · The signing convention
          </h2>
          <p>
            You sign the <strong>canonical payload</strong>, not the raw request body. The canonical
            payload is the deterministic serialization of all present Intent fields <em>except</em>{' '}
            <code>signature</code>:
          </p>
          <ul className={styles.list}>
            <li>object keys sorted lexicographically at every depth;</li>
            <li>
              numerics normalized to a single canonical decimal string (no exponent/trailing zeros);
            </li>
            <li>
              <code>ttl</code> normalized to ISO-8601 UTC, <code>nonce</code> to its string token;
            </li>
            <li>
              absent optional fields omitted entirely (never serialized as <code>null</code>).
            </li>
          </ul>
          <p>
            Signing is <strong>EIP-191 personal_sign</strong> over the UTF-8 canonical payload;{' '}
            <code>intent_hash = keccak256(utf8(canonical_payload))</code>. (ERC-1271
            contract-account signatures are [ROADMAP].)
          </p>
        </section>

        <section className={styles.section} aria-labelledby="example">
          <h2 id="example" className={styles.h2}>
            4 · A worked, signed example
          </h2>
          <p>
            This is the pinned conformance vector (signer = <code>{example.signer}</code>). It
            passes the full P0.3 validator in CI, so it is a safe target to reproduce byte-for-byte
            with your own emitter.
          </p>
          <pre className={`${styles.code} ${styles.scroll}`}>
            <code>{exampleText}</code>
          </pre>
          <dl className={styles.kv}>
            <div>
              <dt>canonical_payload</dt>
              <dd>
                <code className={styles.break}>{example.canonical_payload}</code>
              </dd>
            </div>
            <div>
              <dt>intent_hash</dt>
              <dd>
                <code className={styles.break}>{example.intent_hash}</code>
              </dd>
            </div>
          </dl>
        </section>

        <section className={styles.section} aria-labelledby="rejections">
          <h2 id="rejections" className={styles.h2}>
            5 · Why an Intent is rejected
          </h2>
          <p>
            The validator runs a fixed order and the <strong>first failing check decides</strong>.
            These are the classes of mistake an external emitter hits, in that order:
          </p>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Stage</th>
                  <th>Codes</th>
                  <th>Rejected when…</th>
                  <th>Fix</th>
                </tr>
              </thead>
              <tbody>
                {REJECTION_CATALOG.map((r) => (
                  <tr key={r.stage}>
                    <td>
                      <code>{r.stage}</code>
                    </td>
                    <td>
                      {r.codes.map((c) => (
                        <code key={c} className={styles.codeInline}>
                          {c}
                        </code>
                      ))}
                    </td>
                    <td>{r.when}</td>
                    <td>{r.fix}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className={styles.boundary}>
            <strong>Boundary:</strong> a <code>transfer</code> to a non-whitelisted address is{' '}
            <em>structurally valid</em> (it passes P0.3) but is always rejected downstream by the
            referee&apos;s fresh-wallet / drain block. Well-formed and authentic is not the same as
            allowed.
          </p>
        </section>

        <section className={styles.section} aria-labelledby="get-scored">
          <h2 id="get-scored" className={styles.h2}>
            6 · Get scored
          </h2>
          <p>Once your agent emits valid signed Intents for a whitelisted market:</p>
          <ol className={styles.list}>
            {GET_SCORED_STEPS.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
          <p>
            <a className={styles.cta} href={LEADERBOARD_PATH}>
              View the public leaderboard →
            </a>
          </p>
          <p className={styles.roadmap}>
            <strong>[ROADMAP]</strong> {ROADMAP_NOTE}
          </p>
        </section>
      </article>
    </main>
  );
}
