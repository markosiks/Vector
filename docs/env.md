# Environment variables

Validated at startup by [`lib/config/env.ts`](../lib/config/env.ts) (server-only
entry) via the pure schema/parser in
[`env.schema.ts`](../lib/config/env.schema.ts). A missing or malformed
**required** variable crashes the process with a redacted message that lists
variable **names and reasons only** — never the offending value — so secrets
cannot leak into logs.

| Variable                       | Required | Format                                          | Secret | Stage |
| ------------------------------ | -------- | ----------------------------------------------- | ------ | ----- |
| `DATABASE_URL`                 | ✅ yes   | `postgres://` or `postgresql://` URL            | yes    | P0.1  |
| `MANTLE_TESTNET_RPC_URL`       | no       | `http(s)://` or `ws(s)://` URL                  | no\*   | on-chain |
| `MERIT_REGISTRY_ADDRESS`       | no       | `0x` + 40 hex (VectorMeritRegistry)             | no     | on-chain |
| `NANSEN_API_KEY`               | no       | non-empty string                                | yes    | P2.2  |
| `ELFA_API_KEY`                 | no       | non-empty string                                | yes    | P3.1  |
| `OPERATOR_PRIVATE_KEY`         | no       | EVM private key (`0x` + 64 hex)                 | yes    | attest |
| `ATTESTOR_PRIVATE_KEY`         | no       | EVM private key; ≠ `OPERATOR_PRIVATE_KEY` addr  | yes    | P1.8  |
| `OPERATOR_CONSOLE_TOKEN`       | no       | string, min 24 chars                            | yes    | P2.4  |
| `PUBLIC_BASE_URL`              | no       | `http(s)://` URL (public origin)                | no     | P1.8  |
| `GIT_COMMIT`                   | no       | string                                          | no     | any   |
| `BYREAL_PERPS_AGENT_KEY`       | no       | non-empty string                                | yes    | P2.1  |
| `BYREAL_PERPS_WALLET_ADDRESS`  | no       | `0x` + 40 hex                                   | no     | P2.1  |
| `BYREAL_PERPS_NETWORK`         | no       | `testnet` \| `mainnet` (default `testnet`)      | no     | P2.1  |
| `BYREAL_PERPS_CLI_PATH`        | no       | filesystem path                                 | no     | P2.1  |

\* The RPC URL is not itself a secret, but treat provider URLs with embedded API
keys as secret.

Optional variables are **validated when present**: e.g. a malformed
`MANTLE_TESTNET_RPC_URL` is rejected at startup rather than failing later.

Notes:

- `OPERATOR_CONSOLE_TOKEN` unset ⇒ `/operator` renders a disabled notice and
  every mutating `/api/operator/*` route returns 401 (fails closed).
- `MERIT_REGISTRY_ADDRESS` is consumed by the chain scripts
  (`scripts/chain/mirror-merit.ts`) and the site chrome's explorer links; it is
  not part of the startup schema.

## Security invariants

- **Server-only:** `env.ts` imports `server-only`, so pulling it (and its
  secrets) into a client component is a build error.
- **No client inlining:** there are no `NEXT_PUBLIC_*` secrets; nothing here is
  embedded in the browser bundle. Runtime metadata like `GIT_COMMIT` is read
  from `process.env` inside server code.
- **Redaction:** validation errors reference names/reasons, never values.
- **Bounds:** every URL/secret has a length cap so pathological input is
  rejected deterministically.

See [`.env.example`](../.env.example) for the full list.
