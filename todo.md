# P1.5 — Read API (SWR-pollable)

## Design decisions
- Reuse existing per-table repo layer; add only missing reads. Pure DTO + query-validation layer in `lib/api/`. Thin route handlers.
- Keyset (cursor) pagination for feeds: order `created_at DESC, id DESC`; opaque base64url cursor `{t,id}`.
- numeric stays string (precision); `created_at` Date → ISO string. No leaks: intents DTO drops signature/raw_json/nonce.
- Errors: ApiError(status,code,message). 400 bad query/cursor/id. 404 missing agent (valid uuid). 503 DB unavailable. 500 generic (no leak).
- All routes: `dynamic=force-dynamic`, `runtime=nodejs`, `Cache-Control: no-store`.

## Repo additions
- [x] rounds: getLatestRound
- [x] leaderboard.ts: listLeaderboard (agents LEFT JOIN current-round allocation)
- [x] policy-events: listPolicyEventsPage (keyset), listRecentPolicyEventsByAgent
- [x] attestations: listAttestationsPage (keyset + optional chain_state)
- [x] outcomes: listRecentOutcomesByAgent
- [x] scores: listScoreHistoryByAgent (round index order)

## lib/api
- [x] errors.ts
- [x] cursor.ts
- [x] query.ts
- [x] dto.ts
- [x] respond.ts (route wrapper + ok/error + page envelope)

## Routes
- [x] app/api/leaderboard/route.ts
- [x] app/api/agents/[id]/route.ts
- [x] app/api/policy-events/route.ts
- [x] app/api/attestations/route.ts

## Artifacts
- [x] scripts/api/openapi.ts -> docs/openapi.json
- [x] docs/read-api.md

## Tests
- [x] unit: dto, query, cursor, errors, routes, repos.read
- [x] fuzz: api.query.fuzz
- [x] integration: read-api.integration (isolated schema)
- [x] e2e: read-api.e2e (in-process, FakeDb)

## Verify
- [ ] typecheck, lint, format:check, unit+fuzz+e2e green
- [ ] PR
