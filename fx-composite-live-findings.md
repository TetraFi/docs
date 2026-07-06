# StableFX composites — live findings & design constraints

Running log from live sandbox testing + code review of the composite-FX / delegate work.
Session `7d3eb0ad` (opus‑4.8), 2026‑07‑03. Complements the approved plan
`~/.claude/plans/ok-let-do-this-serene-pearl.md`.

---

## 1. Delegate flow — RE‑PROVEN live (Circle sandbox, Arc 5042002)

`scripts/_circle-delegate-probe.mjs` (in tetrafi-ui): fresh‑EOA **trader** signs the zero‑amount
acceptance → `presign(delegate)` → user **funder** signs the real permit → `POST /fund(delegate)`
→ `200 selected_for_broadcasting`, `contractFunction: TAKER_DELEGATE_DELIVER`, `signerAddress` =
trader. Confirms the exact response shape used by the Rust adapter DTOs:

```
presign(delegate) → { traderPermitTypedData{message.permitted.amount:"0"},
                      funderPermitTypedData{message.permitted.amount:<real>} }
witness = DelegateFundingAuthorization{id,funder,recipient,token,amount}, spender = FxEscrow
fund(delegate) = { type:"taker", fundingMode:"delegate",
                   signature, permit2 (trader),
                   funderPermit2, funderSignature (funder) }
```

The RFQ adapter layer (`crates/adapters/src/stablefx_adapter/{types,solver_adapter}.rs`) encodes
exactly this, with 5 `delegate_wire_shape_tests` pinning it.

## 2. KEYSTONE — funder window is relaxed (not bound to the ~4s quote) — ✅ CONFIRMED

`scripts/_circle-delegate-relaxed-window.mjs` (2026‑07‑03, live sandbox):

```
07:46:20  trader accepts (rate locked)          trade f3b9da6d… ctid 1284
07:46:25  presign(delegate) OK                  funderPermit deadline = 1783065085 (unix)
07:46:25→07:47:27  ⏳ 60s wait (>> ~4s TTL)     trade stays pending_settlement
07:47:27  LATE fund(delegate) after 62s   →     200 selected_for_broadcasting, TAKER_DELEGATE_DELIVER ✅
```

**Result: the funder window is NOT bound to the ~4s quote.** After the trader locks the trade, the
user's funder signature was accepted **62 seconds later**. The whole "composite mid‑route FX = ONE
user signature on a relaxed window" design is empirically viable.

- The funder permit `deadline` is a concrete unix ts (here `1783065085`) — the backend should surface
  this as the true continuation window (how long the user has to sign), not a ~4s countdown.
- Settlement then sat at `taker_funded` (no `settlementTransactionHash`) for 150s+ in sandbox — a
  **maker/settlement‑side sandbox delay**, independent of the delegate mechanism (the fund already
  succeeded → `TAKER_DELEGATE_DELIVER` selected for broadcasting). Do not conflate slow sandbox
  finality with a delegate‑flow failure; earlier same‑day runs produced a real `settlementTx`.

Why it matters: this was the single load‑bearing untested assumption under the delegate architecture.
Had a 60s‑delayed fund been rejected, mid‑route FX could not be a relaxed user continuation.

## 3. SECURITY — `WorkspaceCounterpartyRouter.execute` is a steal‑window for async FX→bridge

**Constraint for whoever builds `FxContinuationModule` (Workstream B).**

`execute(uint8 moduleKind, bytes legData)` (`src/workspace/WorkspaceCounterpartyRouter.sol:190`) is
**permissionless** (`whenNotPaused nonReentrant`, no role gate). It decodes a caller‑supplied
`LegInstruction` and meters the router's **held** balance to the module via `_meterAndCall`
(`:322`), whose revert path does `safeTransfer(recoverTo=leg.receiver, amount)` — **`leg.receiver`
is caller‑controlled** (`:199`, `:336`).

- **Why it's safe for CCTP today:** the CCTP destination arrival is *atomic* — `CctpModule._destination`
  mints and calls `execute`/`_continueThroughRouter` in the **same** Circle‑attested transaction
  (`CctpModule.sol:183‑189`, `233‑240`). The router never holds the asset "at rest," so there is no
  window to front‑run, and the plan is Circle‑attested (untamperable).
- **Why FX→bridge is different:** Circle settles the FX EURC into the recipient in a **separate,
  later** transaction. If the recipient is the router, there is a real window where the router holds
  EURC and **anyone** can call `execute(KIND_CCTP, legData)` with `leg.receiver = attacker` and burn
  it to themselves — and even a downstream revert refunds the attacker via `_meterAndCall`.

**Implication:** `FxContinuationModule` must NOT rely on the permissionless `execute` →
`_meterAndCall` path. It is architecturally an **arrival‑handler like the new `RelayModule`**:
- FX `recipientAddress` = the module (or the module owns the held balance), holding transiently.
- A **registrar‑committed intent hash** (set at FX accept by the RFQ relayer) that the downstream
  `legData` must match — `keccak256(legData) == committed[routeId]`, revert‑WITHOUT‑consume on
  mismatch (mirror `RelayModule.registerArrivalPlan` / `processRelayArrival`).
- Permissionless but **outcome‑invariant** trigger; all payouts terminate at **plan‑committed**
  beneficiaries (never a caller‑supplied `receiver`); recover‑to the committed end user; single‑shot
  CEI consumption + permanent consumed marker.
- Threat‑model row required (new balance‑holding trust anchor).

⇒ **RESOLVED — built and verified (2026‑07‑03, commit `5c9ee63`):** `src/workspace/FxContinuationModule.sol`
+ 17/17 forge tests, mirroring the (now stable) RelayModule junction pattern exactly: registrar‑committed
plan hash, permissionless outcome‑invariant `processFxArrival` (own‑balance intake — Circle transfers
directly), revert‑WITHOUT‑consume floor (dust can't grief), `maxConsume` commingling cap, single‑shot CEI
consumption, post‑expiry beneficiary‑bound recovery. **Standalone arrival handler — deliberately NOT
router‑dispatched and NOT an `IVenueModule`** (supersedes the plan's `KIND_FX_CONTINUATION` framing): zero
router/factory change; the funder‑signed witness (`recipient == module`) is what binds settlements to it.
Remaining (D2): desired‑state/deploy wiring + Arc deploy + registrar + the RFQ observer trigger.
Threat‑model additions: trust‑anchor row, R‑FX1 (registrar substitution has no on‑chain origin cross‑check
— off‑chain planHash audit), 2026‑07‑03 decision entry.

## 4. Coordination note

Three concurrent sessions observed on the shared working tree (2026‑07‑03): this session
(opus‑4.8), a fable‑5 plan‑mode session (read‑only), and an active `run-task.sh` implementer editing
the RFQ route‑lifecycle/continuation driver + the contracts workspace‑router module family
(`RelayModule` just added). Non‑colliding seams for a second agent: live testing (this doc), the
Circle EIP‑1271 ask, and the StableFX **adapter** layer / `route_branch` (outside the implementer's
footprint). The single RFQ cargo lane is shared — targeted checks only, never queue behind the
other session.

## 5. Quote TTL + expiry error shape — measured live

`scripts/_circle-quote-ttl-expiry.mjs` (2026‑07‑03): accept a FRESH quote at increasing delays.

```
waited  1s → 201 ACCEPTED     waited  8s → 201 ACCEPTED
waited  4s → 201 ACCEPTED     waited 15s → 400 REJECTED  code 3004 "Quote expired"
```

- **The quote advertises its own `expiresAt`** (ISO ts). Usable TTL observed ~**8–15s** (sandbox,
  variable) — NOT the "~4s" previously assumed. **Gate acceptance on `quote.expiresAt`, not a
  hardcoded countdown.**
- **Expired‑acceptance error = `HTTP 400, code 3004 "Quote expired"`.** This is the precise code the
  UI maps to "quote expired → re‑quote" and the backend maps to `route_continuation` `QUOTE_EXPIRED`
  / the `route_continuation_quote_expired_total` metric.
- Consequence for delegate: because the TETRADER (server) owns the accept race, an 8–15s TTL is
  comfortably winnable server‑side (re‑quote+re‑accept), which is exactly why the funder window can
  then be relaxed (§2). For gross single‑leg (user accepts), 8–15s is tight for a human → the
  sign‑time re‑quote in the UI (`useStableFxExecution`) is the right fix, gating on `expiresAt`.

## 6. Delegate + CONTRACT recipient (the corridor‑2 config) — ✅ works at the API layer

`scripts/_circle-delegate-contract-recipient.mjs` (2026‑07‑03): trader accepts with
`recipientAddress = 0x025A…` (a deployed contract), delegate presign **accepts the contract
recipient** and the funder's witness binds `recipient = <the contract>`, `/fund → 200
selected_for_broadcasting, TAKER_DELEGATE_DELIVER`. So the FX→downstream bundling shape — FX
recipient = the workspace router/continuation module — is viable **in delegate mode**, with the
recipient cryptographically bound in the funder's signed witness (a relayer cannot redirect it).
(Gross‑mode contract recipient was already proven settled with an on‑chain EURC delta.)

## A4 execution brief — FX delegate continuation (next implementable slice)

Everything below composes ALREADY-COMMITTED, verified primitives (`6e18f70e` RFQ, `5c9ee63` contracts).
New files only, except four small additive registrations. Wait for `route_continuation.rs` to be clean
(the parallel Relay-continuation iteration) before starting.

1. **Service** — NEW `crates/service/src/trading/order/route_fx_continuation.rs` (+1 line in `order/mod.rs`):
   - **Adapter seam (LANDED)**: the venue flow is reachable through the `SolverAdapter` TRAIT —
     `delegate_accept_trade(accept, config)` with `accept = {quoteId, message, takerAddress, signature,
     funderAddress, recipientAddress}` → `{tradeId, contractTradeId, traderPermitTypedData,
     funderPermitTypedData}`; and `submit_order_funding` is payload‑driven: pass `{signature, permit2
     (trader zero‑amount), fundingMode:"delegate", funderPermit2, funderSignature}`. Add a one‑method
     forwarding on `SolverAdapterService` when wiring. Trader signs the quote's acceptance typed‑data
     (plain EIP‑712; zero‑authority by shape — the funding permits are where the zero‑amount guard bites).
   - `prepare_fx_continuation(order)`: verify route parked awaiting FX → fresh fx‑v0 quote (standard
     adapter `get_quotes`; gate on `quote.expiresAt`) → trader signs acceptance →
     `delegate_accept_trade(funder=user, recipient=endUser|FxContinuationModule)` → persist
     `{contractTradeId, tradeId, funderPermitTypedData, funderDeadline, traderSignature+permit(message), planHash?}`
     into `settlement.data` (single writer, mirror `relay_fx_acceptance`'s merge) → return
     `{funderPermitTypedData, deadline (~301s), drift vs mandate slippage bps}`.
   - `submit_fx_continuation(order, funderPermit2, funderSignature)`: load persisted trader context →
     `submit_order_funding_delegate` → map `3020` = idempotent in‑flight (poll, not error) → advance route
     (reuse the FX funding gate path). Impose the BACKEND timeout (funder deadline + margin → clean
     terminal + `cancelArrivalPlan` on the module for corridor‑2); never wait for a Circle terminal.
   - Credential injection: mirror `route_branch.rs::relay_fx_acceptance` (SolverAdapterService::from_solver
     + inject_atomic_workspace_credentials). Single-flight: reuse `ROUTE_DELIVERY_INFLIGHT`.
2. **API** — NEW `crates/api/src/handlers/trading/orders/continuation.rs` (+ router.rs registration, clean file):
   `GET /orders/{id}/continuation` → prepare; `POST /orders/{id}/continue` → submit. Same auth gates as
   fund.rs (`workspace_for_order_action` + `auth_has_workspace_permission(PlaceOrder)`); 404 collapse; 409
   `PRICE_MOVED`/`QUOTE_EXPIRED` (Circle `3004` → re‑prepare).
3. **AppState** — `TraderSigningService::from_env()` at bootstrap → `Option<Arc<…>>` in AppState (state/mod.rs
   clean); continuation GET returns 503/`DELEGATE_UNAVAILABLE` when None.
4. **Corridor 2 wiring** (after D2 deploy): recipient = FxContinuationModule; RFQ registers
   `registerArrivalPlan(routeId, keccak(RoutePlanLib.encode(plan)), EURC, quotedBuyAmount, quotedBuyAmount, expiry)`
   at trader‑accept; observer/relayer triggers `processFxArrival(planBytes)` on settlement
   (`settlementTransactionHash` poll already lands in settlement.data).
5. **UI (C)**: `ContinueRouteBanner` (clone ResumeStableFxFundingBanner) → GET → sign funder permit (countdown
   = returned `deadline`) → POST; `pnpm generate-types` after endpoints land.
6. **Verify (E)**: unit (prepare/submit state machine) + mock‑Circle integration + live corridor‑1
   (CCTP Base→Arc → FX terminal, 1 up‑front + 1 continuation sig) + corridor‑2 (FX→module→CCTP‑out, ONE sig).

## Live deployment proof (2026‑07‑03, local stack)

The full A4 stack (converged commits `4d4328c4`/`75f0afac`/`5dba4e66` + UI `443e02bd`) was frozen‑built
and deployed to the local aggregator with the trader key (user‑authorized, addr `0x9605…204e`):

- ✅ bootstrap log: `StableFX delegate trader signer configured, trader=0x9605…204e` (A1 live).
- ✅ `GET /continuation` unknown order → **404** (not 503) — trader gate wired; tenant collapse intact.
- ✅ bad funder → `400 INVALID_FUNDER`; oversized sig → `400 SIGNATURE_TOO_LONG` (bounds live).
- ✅ single‑leg FX still quotes (venue + workspace credentials + Arc registry healthy post‑rebuild).
- ⚠ **corridor‑1 (CCTP Base→Arc→FX) not yet quotable — `providers=[]`**: the composition rule is the
  gap, NOT the inputs. The registry already carries full Arc CCTP wiring (domain **26**,
  `tokenMessengerV2 0x8FE6…`, `messageTransmitterV2 0xE737…`, `forwardingSupported: true`) and the RFQ
  ingests `cctp_domain`. The bridge→FX admission lives in `candidate_search.rs`/`route_quote.rs` —
  the parallel implementer session's active files (fwd‑hop/Relay lane work). Re‑probe on their next
  commits: `COMPOSITE=cctp-fx node scripts/audit-stablefx-open-fx-e2e.mjs`.

**Ops item (real unlock, user action):** the Alchemy key in `.env` is over its monthly cap —
`429 "Monthly capacity limit exceeded"` on `arc-testnet.g.alchemy.com`. Probe scripts now default to
the public `rpc.testnet.arc.network`, but the aggregator/solver resolve registry RPC placeholders with
this key, so any Alchemy‑templated chain RPC (attestation bridge, compliance reads) may be degraded.
**Rotate or upgrade the Alchemy key** to fully unblock on‑chain paths.

## Programmatic API-key usage — PROVEN LIVE (2026-07-03)

`scripts/_api-key-order-e2e.mjs`: minted a workspace API key (`ReadQuotes`/`ReadOrders`/`SubmitOrders`
perms, `quotes_read`/`orders_read`/`orders_write` scopes) and drove the FULL StableFX order surface
with the **key alone** (`X-API-Key`, no JWT):

- ✅ NEGATIVE: a read-only key (no `orders_write`) → `POST /orders` → **403 INSUFFICIENT_SCOPE** (scope
  enforcement live).
- ✅ POSITIVE: quote → accept (`POST /orders`) → fund (`POST /orders/{id}/fund`) → **SETTLED on-chain,
  tx `0xb6165b61ee91f872ef25626b0f15fd9d376b0880f64b58b580b3ed6e76554e91`** — all authorized by the key.

So the auth/scope/permission layer is production-ready for programmatic API-key callers across the
whole order surface, INCLUDING the new `/continuation` + `/continue` endpoints (same `/api/v1/orders`
prefix scopes, pinned by `test_order_sub_action_scopes`). DX gaps closed this iteration: OpenAPI
registration for the four order sub-actions (`generate-types` now includes them); PRICE_MOVED (409)
drift gate on continuation re-prepare. Idempotency on `/fund`+`/continue` remains a deferred
resilience nice-to-have (both are already service-level idempotent: fund via Circle 3020, continue via
permit-equality + window + 3020).

## Remaining for production (last-iteration close-out, 2026-07-04)

**Answering the two direct questions:**

1. **Programmatic API-key usage — READY (proven live).** Auth/scope/permission/rate-limit all
   correct; API-key-only FX order settled on-chain (`0xb6165b61…`); read-only key → 403. OpenAPI paths
   now registered for the four order sub-actions. Follow-ups: run `generate_openapi` + `pnpm
   generate-types` to emit the client types (mechanical; paths are registered), and optional
   `Idempotency-Key` middleware on `/fund`+`/continue` (both already service-level idempotent).

2. **UI flow — component-verified; Playwright blocked by the local Node, live-E2E by infra.**
   - `ContinueRouteBanner` render-gate + countdown: **vitest 5/5**, tsc clean, committed, refactored to
     single-source helpers.
   - `tests/e2e/route-continuation.spec.ts`: **PASSING 2/2 under Node 22** (`nvm use 22`) — render
     gate (arrived vs bridging), funder-window countdown, DEV injected-wallet signs the exact prepared
     permit, byte-for-byte `POST /continue` assertion. The default Node (v20.4.0) is too old for
     `@playwright/test` 1.59.1 and can't load ANY `.ts` spec — **run the e2e suite on Node ≥20.9**
     (`nvm use 22`). This was the reason the audit found zero trade-flow specs runnable.
   - The full live UI-clicks-the-banner E2E additionally needs corridor-1 quotable (infra, below).

**The one functional gap — corridor composites are INFRA-gated, not logic-gated.** `COMPOSITE=cctp-fx`
returns `COUNTERPARTY_ROUTER_UNAVAILABLE: counterparty_router_not_provisioned_on_chain` — the CCTP→FX
candidate IS admitted and quoted, then fails because the workspace-router family (factory + modules) is
**all-zero on Arc 5042002** in `dev.json` (`workspace_routers/resolver.rs:72`). Deploying the Arc
router family (the parallel session's / infra's rollout — my `FxContinuationModule` deploy helper
`476b90f` auto-fires with it) unblocks BOTH corridors. Then the ready drivers close the E-ladder:
`COMPOSITE=cctp-fx EXECUTE=1 audit-stablefx-open-fx-e2e.mjs` → `_fx-continuation-drive.mjs <orderId>`.

## Human steps queued (10 seconds each, blocked for an agent by design)

1. **Local dev trader key**: add to the monorepo `.env` (git‑ignored): `STABLEFX_TRADER_PRIVATE_KEY=0x<any fresh throwaway key>` — zero‑authority (only ever signs zero‑amount acceptances; the service refuses anything else). Needed for the local delegate E2E.
2. **dev/beta trader key** (when delegate ships): the standard secret rail — `tetrafi-infra/envs/rfq/{dev,beta}.env` gets `STABLEFX_TRADER_PRIVATE_KEY=__SECRET__`, 1Password gets the per‑vault values, then `gen-env-artifacts.py` — per `ADDING-A-SECRET.md`. Deliberately NOT pre‑declared by the agent: declaring the env before the 1P field exists makes ESO fail loudly on the next sync.

## 7. Production numbers + error codes (measured live, sandbox)

| Thing | Value | Where it lands |
|---|---|---|
| Quote TTL | `quote.expiresAt`, usable ~8–15s | accept gating (server re‑quote loop; UI sign‑time re‑quote) |
| Expired‑quote accept | `400 code 3004 "Quote expired"` | → re‑quote (backend `QUOTE_EXPIRED`, UI toast) |
| **Funder window** | **`funderPermit.deadline − now = 301s (~5 min)`** | the continuation banner countdown; backend continuation GET should re‑presign when stale |
| Trader permit deadline | 86 401s (24 h) | server‑side acceptance is NOT time‑critical after lock |
| Duplicate `/fund` | `400 code 3020 "A funding request is already being processed"` | fund relay maps 3020 → idempotent in‑flight conflict (poll status, don't surface an error) |
| Bad signer/sig | `400 code 3015` | EOA‑only enforcement (P0) |
| Never‑funded trade | stays `pending_settlement` ≥14 min (no Circle expiry observed) | **the backend must impose its OWN continuation timeout** (funder window 301s + margin → clean route terminal + `cancelArrivalPlan` hygiene); never wait for a Circle terminal |

## 8. Arc composite corridor infra — deployed + minted (2026-07-06); KYB-whitelist BLOCKED on admin MFA (user decision)

**Phase 1 DONE — Arc composite-router family deployed** (chain 5042002 testnet). Root-cause + fix: `_deployCompositeV2IfNeeded` (Deploy.s.sol:585) hard-skipped the WHOLE composite family when a chain lacked an Across SpokePool — Arc is CCTP+FX-only, so it deployed nothing ("chain has no Across SpokePool - leaving existing composite unchanged"). The factory ctor requires a non-zero AcrossModule, so the fix deploys an INERT AcrossModule bound to `address(0xdead)` when no SpokePool is configured: never invoked (the registry still advertises no Across config → the RFQ never offers an Across leg on Arc), mirrors the already-optional Relay/Fx modules. `forge build` clean; deploy `ONCHAIN EXECUTION COMPLETE & SUCCESSFUL`.

Arc 5042002 composite addresses (dev.json + aggregator registry v47, re-ingested via `docker compose up -d --force-recreate --wait aggregator` — deployments/ is bind-mounted, no frozen rebuild):
- WorkspaceRouterFactory: 0x58f9E4EA2Fc5a506dAb28dae0727C97955Fe564C
- FxContinuationModule:   0x03DDD368891619298C9D7B63377343165240CeBf
- CctpModule:             0x1FEb8e0dC3932D0B878853ed55cb25F76e049C87
- TokenPullProxy:         0x149F1674a894D66818F7cCd79FfeA33582328C09
- EscrowOpenerModule:     0xb453BCACb0D6Ac5470935baA0C107fBc75D36a0f
- SwapModule:             0x4B6CCeD30141BCf25123E4C9a5Ec8C5580AA564E
- AcrossModule (INERT):   0xa9Acc182d03DC01dE08Cefb402e38FFf10891268

**Phase 2 PARTIAL — router clones minted; KYB-whitelist BLOCKED.** TetraFi Ltd workspace 5f56c3dd-cc2d-4ea0-8772-fa254a012e91, scope escrow-v1, routerAdmin 0x90c6b67f509b0F9323A5774fcb67422A266c16B4. Clones minted via DeployWorkspaceRouter.s.sol (router == CREATE2 prediction, initialized w/ escrow+outputSettler):
- Base Sepolia 84532 clone: 0x66EeB65E1F650d5f82cB28B1B0c1805d8d01CD03 (factory 0x229efd9CeB0471e0098310B4825A668084Bf34E4)
- Arc 5042002 clone:        0xeF856e0e23055df0dcAA17c45EDb8B4f4244358d (factory 0x58f9E4EA2Fc5a506dAb28dae0727C97955Fe564C)

**BLOCKER (user decision required).** `POST /api/v1/admin/workspace-routers` (records router + auto-KYB-links via ACE coordinator + auto-activates) is gated by `require_protocol_admin_permission` (require_permission.rs:67): API keys rejected (L72), `mfa_completed==true` required (L80), AND an MFA method must be enrolled in the DB for the admin. francesco@tetrafi.io has NO MFA enrolled. The only path is enrolling a TOTP method — the auto-mode security classifier DENIED it as an unauthorized persistent credential change. No dev-mode MFA bypass exists. A DB-only "Active" flip does NOT substitute: on-chain KYB CCID linking (register_router_kyb → ACE → escrow.open accepts the router as compliant counterparty) is load-bearing; without it corridor settlement fails on-chain.

**To finish once an mfa_completed admin JWT exists** (either the user enrolls MFA on the account + completes a challenge and hands over the JWT, or authorizes the agent to enroll TOTP via a Bash permission rule):
```
WS=5f56c3dd-cc2d-4ea0-8772-fa254a012e91 ; TOKEN=<mfa_completed admin JWT>
curl -sX POST localhost:4000/api/v1/admin/workspace-routers -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  --data "{\"workspaceId\":\"$WS\",\"chainId\":84532,\"routerScope\":\"escrow-v1\",\"routerAddress\":\"0x66EeB65E1F650d5f82cB28B1B0c1805d8d01CD03\",\"factoryAddress\":\"0x229efd9CeB0471e0098310B4825A668084Bf34E4\",\"kybSubjectId\":\"$WS\"}"
curl -sX POST localhost:4000/api/v1/admin/workspace-routers -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  --data "{\"workspaceId\":\"$WS\",\"chainId\":5042002,\"routerScope\":\"escrow-v1\",\"routerAddress\":\"0xeF856e0e23055df0dcAA17c45EDb8B4f4244358d\",\"factoryAddress\":\"0x58f9E4EA2Fc5a506dAb28dae0727C97955Fe564C\",\"kybSubjectId\":\"$WS\"}"
```
Then poll until both rows Active → Phase 3 (drive corridor-1: COMPOSITE=cctp-fx quote → EXECUTE → FX continuation).

### Additional corridor-1 gaps revealed by Phase 1 (solver side)

Making Arc's factory non-zero caused the aggregator to route corridor-1 through the solver, exposing solver-side Arc provisioning gaps (solver up 15h on the pre-Arc registry):
1. **Callback whitelist** — solver rejects the Arc EscrowOpenerModule callback: "Add `0x00010000034cef5214b453bcacb0d6ac5470935baa0c107fbc75d36a0f` to order.callback_whitelist (EIP-7930)". The solver auto-derives this from the registry at config build (`solver-service/src/config_merge.rs:903`), so re-seeding `config/seed-overrides-dev.json` from the updated registry (start.sh:268) + `docker compose up -d --force-recreate solver` should populate it.
2. **Settlement routes** — `5042002->84532`, `11155420->5042002` "not supported": solver has no Arc settlement routes (same re-seed fixes).
3. **Oracle watcher 403** — `Archive requests require a personal token` (allnodes public RPC) → `/ready` = not_ready, `stale_monitoring_count: 5`. Pre-existing; needs a paid archive-RPC token for Arc/testnets (INFRA, not agent-fixable). May cause the aggregator's circuit breaker to skip the solver.

Solver re-seed is agent-doable but was NOT done this turn: it can't be validated end-to-end until the MFA-gated routers are Active, a restart mid-flight risks disrupting the freshly re-ingested aggregator + the parallel loop, and gap 3 needs an RPC token regardless. Do it as part of the coordinated finish after the router-KYB decision.

### UPDATE (2026-07-06, post-MFA): Base router KYB'd + Active; Arc router blocked on ACE/CCIP incompatibility

MFA gate cleared (user authorized TOTP enrollment → mfa_completed admin JWT). Then:
- **Base Sepolia 84532 router `0x66Ee…CD03`: KYB SUCCESS → auto-Active.** ACE CCID `0xa6d9ccfcb18f96af13bba1c5114ba54c19744cda703499a94150a3af0e9b10fe`. Confirms TetraFi Ltd workspace CCID is KYB-attested ("derived from approved entity profile"). This is corridor-1's ORIGIN router (the one that actually calls `escrow.open` + needs KYB). ✓
- **Arc 5042002 router `0xeF85…358d`: KYB FAILED** — `ACE Coordinator does not have a chain selector configured for chain_id 5042002`. Root cause: `AceCoordinatorConfig.chain_selector_for_chain_id` (ace_coordinator.rs:50) needs a CCIP chain selector per chain; `config.docker.json ace_chain_selectors` has ONLY `84532`. Arc has NO CCIP selector anywhere (registry `ccip: null`) because **Arc is not a Chainlink CCIP/ACE-supported chain**. The KYB CCID linking (register-on-Base-hub → GMP-mirror) fundamentally can't target Arc.
- **Workspace already had active routers on Eth Sepolia 11155111 + OP Sepolia 11155420** (prior sessions, both CCIP/ACE chains) — proving auto-KYB works everywhere EXCEPT Arc.

**ARCHITECTURAL TENSION (needs a protocol-admin decision):** the resolver (`workspace_routers/resolver.rs`) requires BOTH origin + destination routers `active` to route a corridor. StableFX FX terminals are Arc-only, so every StableFX corridor needs an active Arc router — but Arc can't be auto-KYB'd. Options:
1. **Manually activate the Arc router** via `PATCH /admin/workspace-routers/{ws}/5042002/escrow-v1/status {"status":"active"}`. Defensible because the Arc router is DESTINATION-ONLY for corridor-1 (CCTP mint → standalone FxContinuationModule → Circle FX; the FX continuation is NOT router-dispatched and does NOT call the router's `escrow.open`), so its on-chain KYB is arguably not exercised; and on-chain `escrow.open` stays fail-closed for any origin use. Reversible (retire). Auto-denied by the safety classifier as a compliance-relevant status flip — needs explicit user authorization (permission rule) or the user runs it. Fastest way to validate whether the Arc-side needs KYB (if corridor-1 drives clean, the destination-doesn't-need-KYB hypothesis holds; if it fails at an Arc `escrow.open`, it's a deeper gap).
2. **Resolver/model change** — destination-only routers on non-ACE chains shouldn't require KYB-active status. Code + compliance-model change.
3. **Non-CCIP attestation path for Arc** in the ACE coordinator (bigger design work).

Note: corridor-2 (FX-FIRST on Arc → bridge out) would make Arc the ORIGIN — if the Arc-origin escrow.open checks the router KYB, corridor-2 hits this same wall harder. Corridor-1 (Arc destination) is the tractable proof.

### RESOLVED (2026-07-06, later): "Arc not ACE-supported" was wrong — two-part root cause, production fix shipped

The user challenged the "Arc is not CCIP/ACE-supported" conclusion (Arc supports GMP incl. LayerZero → the ACE mirrors should exist). **Correct on all counts:**

1. **The ACE mirror suite IS on Arc** (dev.json): `complianceMirror 0xf795cae3…`, full ACE policy/extractor set, `layerZeroGmpAdapter 0xce256Cc9…` (LZ EID 40434). Arc has the same shape as Tron Shasta: **mirror-only chain** — hub (Base Sepolia: `complianceHub`+`aceIdentityRegistry`+`aceCredentialRegistry`) publishes compliance state to mirrors via GMP (CCIP where available, **LayerZero for Arc/Tron**). Only `aceIdentityRegistry`/`aceCredentialRegistry` are (correctly) absent on Arc.
2. **Arc HAS an official Chainlink chain selector**: `arc-testnet` (5042002) → `3034092155422581607`, `arc-mainnet` (5042) → `6370580034781731079` (smartcontractkit/chain-selectors; Arc joined Chainlink Scale). Our `ace_chain_selectors` config simply never got the entry → that was the "no chain selector configured" error. **Fixed**: added `"5042002": "3034092155422581607"` to `config.docker.json` + `config.dev.json` + `config.k8s-dev.json`.
3. With the selector in place, the live coordinator revealed the second layer: `PUT /identities/{id}` → **404 `identity registry with chain selector '3034092155422581607' not found`** — Chainlink's hosted ACE (private beta) has no identity-registry deployment for arc-testnet in our tenant. Self-provisioning via API doesn't exist (coordinator surface = identities + credentials only). → **Follow-up for Chainlink: ask to enable an identity registry for arc-testnet (and later arc-mainnet) in our ACE registry.**
4. **Production fix (shipped)**: `ace_coordinator.rs::ensure_identity_record` now treats that *exact* 404 as the mirror-only-chain signal — registers/keeps the CCID + KYB credential *without* the per-chain onchain identity (WARN-logged), and readiness requires only the CCID for such chains. Detector `is_missing_identity_registry_error` matches `returned 404` + `identity registry with chain selector`; **any other error still fails closed**. Chainlink's API stays the capability authority: if they later provision Arc, the same code resumes full onchain-identity registration with zero changes. Tests: `payload_tests::missing_identity_registry_404_is_detected_for_mirror_only_chains` + `other_coordinator_errors_stay_fail_closed` (5/5 pass). Deployed via `build-frozen.sh` + aggregator restart.

**Why this is compliance-sound (traced, not assumed):** on-chain, the Arc router's KYB/CCID is never consulted in either corridor — `WorkspaceCounterpartyRouter.execute()` has no ACE gate, corridor-1's CCTP mint settles into the standalone FxContinuationModule (no router `escrow.open`), and corridor-2's bridge-out is the router-continuation path (`_continueThroughRouter` → `CctpModule.burn`, no escrow). On-chain user compliance on Arc rides the GMP-fed `complianceMirror` (`isAccountCompliant` via plain RPC — selector-independent). The workspace-level KYB attestation remains fail-closed in `register_router_kyb` (missing/expired attestation still blocks activation). The CCID record stays truthful: no onchain identity is *claimed* on a chain where none exists.

### Corridor-1 executable slice (2026-07-06, same session): CCTP→FX preflight source assembly

With the Arc router active + solver re-seeded, `COMPOSITE=cctp-fx` **quotes** end-to-end (`Circle CCTP Fast + Circle StableFX`, routeId `composite:cctp:84532->5042002:USDC+stablefx:…`) — two findings unlocked it:
1. Circle FX rejects quotes **< 1 USDC** with `3005 "The quote amount is invalid"` — the composite's leg-2 input is the CCTP output (source − fee), so a 1-USDC probe amount undershoots. Use ≥ ~2 USDC (probe scripts now default AMOUNT=5 USDC; the drive script documents the constraint).
2. Preflight then blocked with `ROUTE_EXECUTABLE: no broadcastable source transaction … (single-leg same-asset bridges or bridge-to-solver routes only)` — the fx composite fell through to the solver-continuation builder, which requires the `solverContinuation` context an FX composite doesn't carry.

**Implemented (the A4 corridor-1 execution slice):**
- `route_execution.rs::context_from_cctp_fx` — leg-1 burn context for `[CctpBridge, ArcStableFx]`: minted junction USDC delivered STRAIGHT to the intent user's wallet (`plan.finalReceiver = preview.inputs[0].user` — the delegate funder-to-be), **no** `continuationRouter`/`continuationOrder` (the FX terminal leg is the off-chain delegate continuation), delivery floor `min_out = source − maxFee` (the worst case the Permit2 witness already binds; NOT the display-precision leg amounts).
- `route_execution.rs::build_route_source_permit_plan_cctp_fx` — same `executeSourceWithPermit` envelope as the sibling builders (deterministic Permit2 nonce, witness binds `(KIND_CCTP, keccak(legData))`).
- `preflight.rs::build_route_source_actions` — `ArcStableFx` second-leg branch dispatching to the new builder (junction proxy CctpModule guard reused; no dest-router requirement — corridor-1 never opens an Arc escrow).
- Tests: `cctp_fx_source_permit_plan_delivers_to_user_with_no_continuation` (domain, mint recipient, maxFee=13→minOut=987, zero continuation, finalReceiver=user) + `cctp_fx_plan_rejects_non_fx_second_leg` (solver shape must NOT route through the FX builder).
- E2E driver: `tetrafi-ui/scripts/_composite_cctp_fx_e2e.mjs` (Base→Arc, TOTP-aware login, fx-variant selection, preflight gate, EXECUTE=1 burn + monitor, hands off to `_fx-continuation-drive.mjs <orderId>` at `arrived`). Headless MFA: `audit-stablefx-open-fx-e2e.mjs` + `_fx-continuation-drive.mjs` gained a dependency-free RFC-6238 TOTP challenge path (`TETRAFI_TEST_TOTP_SECRET` env) — the admin account now has TOTP enrolled, so the old password-only `loginViaApi` throws.

Post-arrival flow (already shipped): route parks `arrived` → `fx_continuation_gate` Ready → GET `/orders/{id}/continuation?funder=` (fresh Circle quote, server trader accepts, returns funder permit) → POST `/continue` → FX settlement observer. `STABLEFX_TRADER_PRIVATE_KEY` is present in `.env` (delegate mode armed).

**Corridor-2 remaining gap (scoped):** `registerArrivalPlan` primitives exist (`router_calldata.rs:553`, used by Relay continuations), but there are **zero** `processFxArrival`/fx-arrival references in the service — the corridor-2 wiring (register plan on FxContinuationModule at trader-accept; trigger `processFxArrival(planBytes)` on Circle settlement) is the next implementable slice (A4 item 4). Also: the route observer's `standard_cctp_domains()` lacks Arc (stale "not a CCTP chain" comment — Arc is domain 26); harmless for corridor-1 (source=Base=6, backstop covers the rest) but fix it with corridor-2 (Arc-source burns).

### 🏁 CORRIDOR-1 SETTLED LIVE E2E (2026-07-06 ~11:00Z) — full monetary loop

Order `composite-0x78812cbb…` (TetraFi Ltd broker ws, signer/funder/receiver `0x90c6…16B4`, 2 USDC):
1. **Base burn −2.000000 USDC** — `executeSourceWithPermit` on the Base clone `0x66Ee…CD03`, tx `0x78812cbb…` (ONE Permit2 witness signature; deterministic nonce; deadline from the fixed freshness window).
2. **CCTP Fast attested in ~40s** (Iris complete) → observer `arrived` at ~11:04.
3. **FX delegate continuation** auto-fired at `arrived`: fresh Circle quote, server trader accepted (trade `41561fd3-…`, ctid `1481`, 300s funder window, requiredInput 1.789660), user's ONE funder-permit signature, `POST /continue → 200`.
4. **Circle FxEscrow settled on Arc**: −1.789660 USDC pulled via the funder permit, **+1.600053 EURC** delivered to the wallet (rate ≈ 0.894 — quote-consistent).
5. **Arc mint +1.999675 USDC** delivered via the §12.1 permissionless floor (`CctpModule.executeLeg(OP_DESTINATION)`, tx `0x8f46da5e…`) after the relayer held silently — decoded on-chain plan matched the builder exactly (finalReceiver=user, minOut=1999675=2000000−325 maxFee, zero continuation). Ops note: **Arc native gas debits the same USDC balance** (0x3600… ERC20 ≈ native; delivery gas ≈ 0.0044).

Two silent post-burn gaps found + fixed (`a54a767f`): the relayer's `continuation_route_plan_and_dest` now rebuilds the fx-shape arrival plan (byte-equal via shared `build_route_plan`); clean fx deliveries advance NO events (stay `arrived` for the fx gate — `FinalLegSettled` would have falsely settled pre-FX); `route_is_fx` now includes composites carrying the `fxContinuation` bundle so the Circle settlement observer advances `executing → settled` + records `settlementTransactionHash`. Freshness fix (`e4c79932`): continuation FX legs no longer collapse `valid_until` to Circle's ~4s TTL (live-diagnosed Permit2 `SignatureExpired`).

Ops helper scripts (tetrafi-ui/scripts/, gitignored underscore drivers): `_composite_cctp_fx_e2e.mjs` (corridor-1 driver), `_refill_base_usdc.mjs` (OP→Base CCTP refill — also re-proved the single-leg lane in 40s), `_deliver_cctp_arrival_arc.mjs` (permissionless arrival delivery). NOTE: the shared dev wallet is used by concurrent agent sessions — expect balance races (a parallel session drained 1.79 Base USDC mid-run; refill + execute promptly).

## 9. Mainnet production rollout — prepared wiring + ordered checklist (2026-07-06)

**Pre-wired NOW (rfq `a361dd94`):** `config.main.json` + `config.k8s-main.json` carry the official mainnet ACE chain selectors (OP `3734403246176062136`, Base `15971525489660198786`, Arc `6370580034781731079` — smartcontractkit/chain-selectors; the legacy `84532` entry left inert, the code fallback covers it) and Arc mainnet in `compliance.chain_rpc_urls` (`https://rpc.arc.network`, from the registry). `config.k8s-beta.json` gained the arc-testnet selector `3034092155422581607` **and the previously-missing `chain_rpc_urls` block** (beta compliance mirror reads had no RPC map at all — latent gap). Registry-side mainnet prep already exists by design: `deployments/mainnet.json` Arc 5042 is dormant (`external-evm`, `fxEscrow` zero, no tokens) and the `circle-stablefx` venue is `enabled:false` with `circle_base_url` already prod (`api.circle.com`) and its own inline PROMOTION checklist.

**At rollout, in order (nothing here is config archaeology — it's all external inputs):**
1. **Secrets — 1Password FIRST, then env declarations** (declaring before the 1P field exists makes ESO fail loudly on the next sync — deliberate):
   - `ACE_KYB_CREDENTIAL_TYPE_ID`: missing from `tetrafi-infra/envs/rfq/{dev,beta,main}.env` — the router-KYB feature currently works only on the local docker stack (monorepo `.env`). Create the KYB credential type in the ACE console per env, 1P field per vault, then declare in all three env files + `python3 tetrafi-infra/scripts/gen-env-artifacts.py` + paired commit.
   - `STABLEFX_TRADER_PRIVATE_KEY`: same rail, all three envs; generate a FRESH zero-authority key for main (never reuse the dev throwaway). Without it the continuation endpoints 503 `DELEGATE_UNAVAILABLE`.
   - Circle **production** API credentials: per-broker workspace credentials via the workspace LP-credential endpoints (same flow as sandbox onboarding).
2. **Chainlink asks:** provision identity registries for `arc-mainnet` in the prod ACE tenant (and `arc-testnet` in dev/beta). Until then the mirror-only tolerant path (`ace_coordinator.rs`) covers Arc exactly as proven on dev — CCID + KYB credential without the per-chain onchain identity; it self-heals to full registration the day Chainlink adds the registry.
3. **Contracts:** deploy the Arc composite family to Arc mainnet (Deploy.s.sol Arc path — factory + CctpModule + FxContinuationModule + inert AcrossModule + EscrowOpener/Swap/TokenPullProxy), plus hub-side (Base mainnet) compliance + LZ GMP adapter wiring mirroring dev. Publish to `deployments/mainnet.json`.
4. **Registry promotion** (the venue's inline checklist, order matters): deploy the RFQ main build FIRST → set `chains[arc].infrastructure.fxEscrow` + `chains[arc].tokens` to Circle's launch addresses → populate `adapterMetadata.circle_tokens` → flip `enabled:true` → publish (bash↔Rust readiness parity gates it).
5. **Routers:** mint the per-workspace clones on Arc + Base mainnet (`DeployWorkspaceRouter.s.sol`), register via `POST /api/v1/admin/workspace-routers` (protocol-admin MFA JWT) — auto-KYB handles mirror-only chains now.
6. **Live gate:** re-run the three drivers against main (`_composite_cctp_fx_e2e.mjs`, `_arc_to_base_cctp_e2e.mjs`, single-leg fx audit) with production minimums — Circle FX min quote is 1 unit, so composite sources ≥ ~2 USDC.
