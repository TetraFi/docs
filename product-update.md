# Product update

- **Multi-VM Support:** Integrated Solana and expanded the product from EVM-only to generalized multi-VM support, including Cosmos-based execution.

- **Solana Settlement Stack:** Built the chain-native Solana settlement path, including input escrow, output settlement, workspace routing, compliance gates, deferred accounting, and cross-chain execution.

- **ZIGChain Draft Deployment:** Prepared draft Cosmos contracts that could be deployed on ZIGChain once we confirm their technical and deployment requirements.

- **Cosmos Execution Stack:** Built CosmWasm contracts for compliance, escrow opening, workspace routing, cross-chain messaging, deposits, and withdrawals.

- **Cross-VM Settlement:** Added shared cross-VM carriers and chain-aware routing so orders can move between EVM and non-EVM execution environments.

- **Single-Chain DEX Integration:** Building deeper DEX integrations by reproducing Uniswap and other venues' execution logic in Rust and simulating execution.

- **Verified DEX Execution:** Binding every accepted DEX quote to its exact plan, calldata, policy, transaction, receipt, and realized output before treating the trade as settled.

- **Routing and Pathfinding:** Improving routing across venues by combining live execution simulations and advanced pathfinding algorithms to find the best possible paths.

- **Real-Time Indexing:** Adding blockchain indexers to stream and aggregate accurate pricing from multiple venues in real time.

- **Programmable Liquidity:** Added a single-chain, solver-based execution-routing auction module.

- **Execution Policy Governance:** Added versioned execution policies with delayed activation, asset restrictions, adapter checks, target allowlists, and emergency controls.

- **Composite Route Engine:** Built multi-leg routes that can combine swaps, bridges, solvers, StableFX, and continuation legs within one coordinated execution plan.

- **Bridge Integrations:** Added native route support for CCTP, Across V4, and Relay V1, including quoting, execution, destination observation, and recovery.

- **StableFX Routing:** Added StableFX execution through Circle Arc, including FX-first and bridge-first corridors, sign-time re-quoting, and continuation handling.

- **Compliance Engine:** Continuing to improve the compliance engine while keeping the core backend as the current priority.

- **Compliance Control Center:** Built an operational compliance view covering gate health, failed checks, denial evidence, KYC posture, Travel Rule activity, and policy history.

- **Compliance Evidence:** Added structured per-check evidence, latency, policy provenance, transaction proofs, and CSV/JSON exports for auditability.

- **LP Directory:** Built a unified liquidity-provider directory with curated entity facts, provenance labels, venue capabilities, compliance posture, and honest performance metrics.

- **LP Jurisdiction Controls:** Added licence-backed serving scopes and jurisdiction eligibility checks so liquidity is only offered where the LP, broker, and company jurisdictions are compatible.

- **UI and Product Experience:** Improved the overall UI and UX across trading, compliance, LP management, analytics, navigation, mobile layouts, and transaction tracking.
