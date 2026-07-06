# Circle StableFX — request: accept EIP‑1271 signatures at `/trades` and `/fund`

**From:** TetraFi (StableFX integrator — aggregator/broker on Arc)
**Re:** Allowing a smart‑contract account to be the taker‑of‑record and/or delegate funder
**Status:** Not a blocker for our launch (we ship with EOA signers), but it is the single change that would unlock a fully‑trustless, contract‑enforced routing product on top of StableFX.

---

## TL;DR

Your **on‑chain** settlement (`FxEscrow.takerDeliver` / `TAKER_DELEGATE_DELIVER`) validates the taker/funder Permit2 authorization through canonical Permit2, which **already supports EIP‑1271** (contract signatures). But your **off‑chain** API (`POST /v1/exchange/stablefx/trades` and `POST /v1/exchange/stablefx/fund`) appears to verify the submitted signature with a plain `ecrecover(digest, sig) == expectedAddress` check, which **rejects any smart‑contract signer**. We are asking Circle to make the off‑chain check EIP‑1271‑aware (fall back to an on‑chain `isValidSignature` call when the signer is a contract), matching what the escrow already does on‑chain.

## What we observed (Arc testnet + sandbox API, reproducible)

We deployed a standards‑compliant EIP‑1271 wallet on Arc testnet whose `isValidSignature` returns the magic value `0x1626ba7e` for a digest signed by its owner key.

1. **Acceptance (`/trades`).** For a fresh StableFX quote's Permit2 acceptance digest:
   - On‑chain: `wallet.isValidSignature(digest, ownerSig) == 0x1626ba7e` (valid).
   - Off‑chain: `POST /v1/exchange/stablefx/trades` with that contract as `address` + the owner signature → **`400`, code `3015` "The provided signature could not be verified against the expected address."**
   - Control: a correct EOA taker + its own key → accepted (this is the flow we ship today); a wrong key for that EOA → same `3015`. So the API *is* verifying the signature itself, via `ecrecover`, not merely relaying to chain.

2. **Delegate funder (`/fund`, `fundingMode: delegate`).** With a contract as the `funderAddress` (holding the input currency, Permit2‑approved to `FxEscrow`):
   - On‑chain: `funderWallet.isValidSignature(funderDigest, ownerSig) == 0x1626ba7e` (valid).
   - Off‑chain: `POST /v1/exchange/stablefx/fund` with `funderSignature` = the owner signature → **`400`, code `3015`.**
   - Control: an **EOA** funder ≠ trader works end‑to‑end (`selected_for_broadcasting` → `TAKER_DELEGATE_DELIVER` → settled). So delegate decoupling itself works; only the *contract* funder is rejected, and it is rejected off‑chain.

Both rejections are your API's fail‑fast `ecrecover`, **not** a chain limitation — the escrow's `takerDeliver` / `TAKER_DELEGATE_DELIVER` paths validate via Permit2's `SignatureVerification`, which already branches to EIP‑1271 for contract signers.

## The specific ask

For the taker **acceptance** at `POST /v1/exchange/stablefx/trades` and the **funder** signature at `POST /v1/exchange/stablefx/fund`:

> When the `address` / `funderAddress` is a smart contract (has code), verify the submitted signature via an on‑chain **EIP‑1271** `isValidSignature(hash, signature)` call against that account, instead of (or as a fallback to) `ecrecover`. This mirrors the check your `FxEscrow` already performs on‑chain through Permit2.

This is the same pattern Permit2, Safe, and most modern signature‑verifying protocols use (`SignatureChecker.isValidSignatureNow`: try `ecrecover`, then fall back to `IERC1271.isValidSignature`).

## Why it matters (for Circle and for integrators)

- **Institutional/aggregator custody.** Integrators like us route on behalf of end users using a per‑workspace **smart‑contract** counterparty (immutable, non‑custodial, refund‑enforcing). Today that contract cannot be the StableFX taker, so we must route the FX leg through an EOA whose key is an irreducible custody point over in‑flight funds — the exact thing the contract exists to remove.
- **Trustless multi‑leg settlement.** With EIP‑1271 acceptance, the contract itself enforces the mandate (amount, recipient, slippage) via `isValidSignature`, so a compromised relayer can never move or redirect funds. This makes StableFX composable as a leg inside a contract‑enforced route (e.g. CCTP → StableFX → CCTP) with a single user authorization.
- **Non‑EVM takers.** It also opens a path for takers whose primary wallet is non‑EVM (via a contract account they authorize), broadening StableFX's addressable base.

## Scope / non‑asks

- We are **not** asking to change the on‑chain contracts — they already validate via Permit2/EIP‑1271.
- We are **not** asking to relax KYC/KYB or the individually‑owned‑wallet rule; the contract account would be a registered, KYB'd identity under our ACE entity.
- EOA signing continues to work unchanged; this is an **additive** fallback for contract signers.

## Reference

- API: `POST /v1/exchange/stablefx/trades`, `POST /v1/exchange/stablefx/fund`, `POST /v1/exchange/stablefx/signatures/funding/presign` (`fundingMode: delegate`).
- Error observed: HTTP `400`, code `3015` "The provided signature could not be verified against the expected address."
- On‑chain: `FxEscrow` (Arc testnet proxy `0x8676…a9f8`), `takerDeliver(uint256,tuple,bytes)` / `TAKER_DELEGATE_DELIVER`, validating via canonical Permit2 `0x000000000022D473030F116dDEE9F6B43aC78BA3` (`PermitWitnessTransferFrom`, witness `DelegateFundingAuthorization{id,funder,recipient,token,amount}`).
- Standard reference implementation: OpenZeppelin `SignatureChecker.isValidSignatureNow(signer, hash, signature)`.

_Reproduction scripts available on request (they exercise the sandbox API + a deployed EIP‑1271 wallet on Arc testnet and show the on‑chain‑valid / API‑rejected split for both the acceptance and the delegate funder)._
