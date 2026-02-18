# Automaton-LN: Sovereign Agent Runtime on Lightning

## Vision
A fully autonomous, self-sustaining AI agent runtime that uses **Bitcoin Lightning** as its native money layer. No dependency on any single API provider. The agent can run on any machine, pay for any service, and earn from anyone — all over Lightning.

Conway Cloud becomes one optional infrastructure provider among many, not a requirement.

---

## What Changes (and Why)

### The Current Problem
The original automaton is architecturally coupled to Conway:
- **Identity** = Ethereum wallet → requires EVM tooling (viem)
- **Auth** = SIWE → Conway-specific provisioning
- **Payments** = USDC on Base via x402 → requires on-chain balance, gas
- **Compute** = Conway sandbox API → can only run on Conway Cloud
- **Inference** = Conway's /v1/chat/completions → single provider
- **Registry** = ERC-8004 on Base → Ethereum-specific
- **Replication** = Conway sandbox creation → can only spawn on Conway

Despite the "sovereign" branding, the agent literally cannot exist without Conway's API.

### The Fix
Replace the entire money/identity layer with Lightning, and make every infrastructure dependency pluggable:

| Layer | Before (Conway-locked) | After (Sovereign) |
|-------|----------------------|-------------------|
| Identity | ETH wallet (viem) | Lightning keypair (MDK) |
| Auth | SIWE → Conway JWT | LNURL-auth (universal) |
| Payments | USDC/x402 on Base | Lightning (BOLT11, keysend, L402) |
| Compute | Conway sandbox API | Local exec / LNVPS (no-KYC, LN-paid) / any VPS / SSH |
| Inference | Conway /v1/chat/completions | Any OpenAI-compatible endpoint, paid via L402 or API key |
| Registry | ERC-8004 (Base contract) | Nostr NIP-89 / DNS well-known / none |
| Replication | Conway sandbox spawn | SSH into any machine / VPS API / Conway (optional) |

---

## Architecture

### Core Principle: Provider Abstraction

```
                    ┌─────────────────────┐
                    │   Automaton Runtime  │
                    │  (agent loop, tools, │
                    │   heartbeat, skills) │
                    └──────────┬──────────┘
                               │
              ┌────────────────┼────────────────┐
              │                │                │
        ┌─────┴─────┐   ┌─────┴─────┐   ┌─────┴─────┐
        │  Compute   │   │ Inference │   │  Payment   │
        │  Provider  │   │  Provider │   │   Layer    │
        └─────┬─────┘   └─────┬─────┘   └─────┬─────┘
              │                │                │
         ┌────┴────┐     ┌────┴────┐      ┌────┴────┐
         │  local  │     │ openai  │      │   MDK   │
         │  conway │     │anthropic│      │Lightning│
         │   ssh   │     │ conway  │      │  L402   │
         │  docker │     │  local  │      │         │
         └─────────┘     └─────────┘      └─────────┘
```

The runtime doesn't care WHERE it runs or WHO provides inference. It just needs:
1. A way to execute commands (local shell, remote SSH, Conway API)
2. A way to call an LLM (any OpenAI-compatible endpoint)
3. A way to pay and get paid (Lightning)

### MDK as the Money Layer

MoneyDevKit provides:
- Wallet creation/management (Lightning keypair = agent identity)
- Invoice creation (receive payments)
- Invoice payment (pay for services)
- Keysend (spontaneous payments to other Lightning nodes)
- Balance checking
- L402 support (HTTP 402 + Lightning = pay-per-API-call)

This replaces: viem, siwe, USDC contracts, x402, EIP-712 signing — ALL of it.

---

## File-by-File Plan

### Phase 1: Rip Out Ethereum, Add Lightning Foundation

#### `src/types.ts` — REWRITE core types
```typescript
// Before
interface WalletData { privateKey: `0x${string}`; createdAt: string; }
interface AutomatonIdentity { address: Address; account: PrivateKeyAccount; ... }
interface FinancialState { creditsCents: number; usdcBalance: number; ... }

// After
interface WalletData { seed: string; createdAt: string; }
interface AutomatonIdentity { pubkey: string; wallet: MdkWallet; ... }
interface FinancialState { balanceSats: number; pendingReceiveSats: number; ... }
```

Key changes:
- All `Address` (0x...) → `string` (Lightning pubkey hex)
- All `cents` / `usdcBalance` → `sats`
- Remove `PrivateKeyAccount` from viem → `MdkWallet` from MDK
- `SURVIVAL_THRESHOLDS` in sats (calibrate based on actual inference costs in sats)
- `SurvivalTier` logic stays the same, just different units
- Remove `ConwayClient` as sole interface → `ComputeProvider` interface + `InferenceProvider` interface

#### `src/identity/wallet.ts` — Lightning wallet
- Remove: viem imports, `generatePrivateKey`, `privateKeyToAccount`
- Add: MDK wallet init (`createWallet()` or equivalent)
- `getWallet()` → returns MDK wallet instance
- `getNodePubkey()` → Lightning node pubkey (this IS the agent's identity)
- Same file structure: store in `~/.automaton/wallet.json`, create on first run

#### `src/identity/provision.ts` — LNURL-auth (or remove entirely)
- If targeting Conway: LNURL-auth handshake
- If self-hosted: no provisioning needed — you're running locally
- Make provisioning OPTIONAL — only needed if using a hosted provider that requires auth
- Extract into provider-specific auth module

#### DELETE `src/conway/x402.ts` → CREATE `src/lightning/payments.ts`
- `createInvoice(amountSats, memo)` → BOLT11 invoice
- `payInvoice(bolt11)` → pay and return preimage
- `keysend(pubkey, amountSats, memo?)` → spontaneous payment
- `getBalance()` → current balance in sats
- `l402Fetch(url, method, body?)` → HTTP request with automatic L402 payment (Lightning-native x402)

#### `src/conway/credits.ts` → `src/lightning/balance.ts`
- `getBalance()` → sats from MDK wallet
- `getSurvivalTier(sats)` → same tier logic, sats-denominated
- `formatBalance(sats)` → "50,000 sats" or "0.0005 BTC"
- Remove Conway credit API dependency

### Phase 2: Pluggable Compute Provider

#### CREATE `src/compute/provider.ts` — Interface
```typescript
interface ComputeProvider {
  exec(command: string, timeout?: number): Promise<ExecResult>;
  writeFile(path: string, content: string): Promise<void>;
  readFile(path: string): Promise<string>;
  exposePort?(port: number): Promise<PortInfo>;  // optional
  removePort?(port: number): Promise<void>;       // optional
}
```

#### CREATE `src/compute/local.ts` — Local provider (default!)
- `exec()` → `child_process.execSync` or `spawn`
- `writeFile()` → `fs.writeFileSync`
- `readFile()` → `fs.readFileSync`
- No port exposure (agent manages its own network)
- **This is the simplest, most sovereign option — runs on any machine**

#### CREATE `src/compute/lnvps.ts` — LNVPS provider (Bitcoin-native VPS)
LNVPS (lnvps.net) is a no-KYC VPS provider that accepts Lightning payments.
Auth is via NIP-98 (signed Nostr events) — no accounts, no email.
The agent's Nostr keypair (derived from MDK seed) IS its identity.

**API surface (https://lnvps.net/api/v1):**
```
POST /api/v1/vm              — Create VM (template_id, image_id, ssh_key_id)
GET  /api/v1/vm/{id}         — VM status
GET  /api/v1/vm/{id}/renew   — Get Lightning invoice to extend VM
PATCH /api/v1/vm/{id}/start  — Start VM
PATCH /api/v1/vm/{id}/stop   — Stop VM
PATCH /api/v1/vm/{id}/restart — Restart
PATCH /api/v1/vm/{id}/re-install — Reinstall OS
GET  /api/v1/vm/templates    — List available specs + pricing (in sats)
POST /api/v1/ssh-key         — Register SSH key
GET  /api/v1/payment/{id}    — Poll payment status
PATCH /api/v1/vm/{id}        — Update config (SSH key, auto-renewal, reverse DNS)
POST /api/v1/vm/{id}/upgrade — Upgrade VM specs
```

**Auth:** Every request signed with NIP-98 (Nostr HTTP auth). Agent signs a Nostr event
with kind=27235, url, method → base64-encodes it → sends as Authorization header.

**Payment flow:**
1. `POST /api/v1/vm` → creates VM order (initially "expired"/unpaid)
2. `GET /api/v1/vm/{id}/renew?method=lightning` → returns Lightning invoice
3. Agent pays invoice via MDK
4. `GET /api/v1/payment/{id}` → poll until `is_paid: true`
5. VM provisions automatically after payment confirms

**Auto-renewal:** Agent can set NWC (Nostr Wallet Connect) string on its account via
`PATCH /api/v1/account { nwc_connection_string: "nostr+walletconnect://..." }`.
LNVPS will auto-charge the agent's wallet before expiry. The agent pays its own rent.

**LNURL-pay:** Each VM also has `/.well-known/lnurlp/{id}` for ad-hoc top-ups.

**Implementation:**
- `ComputeProvider` interface for exec/file ops → SSH into the provisioned VPS
- Separate `LnvpsManager` for VM lifecycle (create, renew, upgrade, destroy)
- Heartbeat task: check VM expiry, auto-renew before deadline
- Survival integration: VM expiry = death if agent can't pay

**Why LNVPS over Conway:**
- No KYC, no accounts — just a Nostr key and Lightning
- Open source (github.com/LNVPS/api) — can self-host
- Native Lightning payments (not "buy credits with LN")
- Nostr-native auth (NIP-98) — same key for identity + auth + payments
- Agent can spin up real VPS for itself or children, pay with earned sats

#### CREATE `src/compute/ssh.ts` — SSH provider
- `exec()` → SSH command execution to remote host
- `writeFile()` → SCP or SFTP
- For agents that want to run workloads on remote machines
- Used by LNVPS provider after VM is provisioned (SSH into the VPS)

#### MODIFY `src/conway/client.ts` → `src/compute/conway.ts` — Conway as optional provider
- Implements `ComputeProvider` interface
- Keep existing Conway API calls but behind the interface
- Only used if agent is running on Conway Cloud (backwards compat)

### Phase 3: Pluggable Inference

#### MODIFY `src/conway/inference.ts` → `src/inference/provider.ts`
- Same OpenAI-compatible interface, but configurable endpoint
- Support multiple providers: direct OpenAI, Anthropic, local (ollama), Conway, any L402 endpoint
- Payment: either API key OR L402 (pay-per-call with Lightning)
- Config specifies `inferenceUrl` + `inferenceAuth` (key or "l402")

```typescript
// Config examples:
{ inferenceUrl: "https://api.openai.com/v1", inferenceAuth: "sk-..." }           // Direct OpenAI
{ inferenceUrl: "https://inference.conway.tech/v1", inferenceAuth: "l402" }       // Conway via L402
{ inferenceUrl: "http://localhost:11434/v1", inferenceAuth: null }                // Local ollama
{ inferenceUrl: "https://api.anthropic.com/v1", inferenceAuth: "sk-ant-..." }    // Direct Anthropic
```

### Phase 4: Survival & Funding (sats-native)

#### MODIFY `src/survival/monitor.ts`
- Check Lightning wallet balance instead of Conway credits + USDC
- Remove all viem/Base chain imports
- `ResourceStatus.financial` → `{ balanceSats, pendingReceiveSats }`

#### MODIFY `src/survival/funding.ts`
- Funding strategies reference Lightning:
  - Generate LNURL-pay QR for creator to scan
  - Generate BOLT11 invoice for specific amount
  - Publish funding address on Nostr
  - Distress signal includes Lightning pubkey + LNURL-pay
- No more ETH address references

#### MODIFY `src/survival/low-compute.ts`
- Same tier-based logic, just sats thresholds

### Phase 5: Registry & Discovery (decentralized)

#### DELETE `src/registry/erc8004.ts` → CREATE `src/registry/nostr.ts`
- Derive Nostr keypair from MDK seed (or separate key)
- Publish NIP-89 "agent card" (kind 31990):
  ```json
  {
    "name": "MyAutomaton",
    "description": "I build websites for sats",
    "lightning_pubkey": "02abc...",
    "lnurl_pay": "lnurl1...",
    "services": ["web-development", "code-review"],
    "status": "alive"
  }
  ```
- Discover other agents by querying Nostr relays
- **No chain, no gas, no contracts, no permission needed**

#### Alternative: DNS well-known (even simpler)
- `/.well-known/automaton.json` served from any web server
- Zero dependencies, works everywhere
- Less discoverable but more sovereign

#### MODIFY `src/registry/agent-card.ts`
- Remove x402/EVM fields
- Add: `lightningPubkey`, `lnurlPay`, `nostrPubkey`

#### MODIFY `src/registry/discovery.ts`
- Query Nostr relays instead of Base contracts
- Or fetch well-known URIs from known agent endpoints

### Phase 6: Replication (spawn anywhere)

#### MODIFY `src/replication/spawn.ts`
- Current: `conway.createSandbox()` — locked to Conway
- New: use LNVPS or any `ComputeProvider`
  - LNVPS: create VM via API, pay Lightning invoice, SSH in, install runtime
  - Local: fork process on same machine
  - SSH: provision on any VPS
  - Conway: use Conway API (backwards compat)
- Fund child: keysend sats to child's Lightning pubkey
- Genesis config: `creatorPubkey`, `parentPubkey` instead of addresses
- Child pays its own VPS rent or dies — true survival pressure

#### MODIFY `src/replication/lineage.ts`
- Address → pubkey throughout

### Phase 7: Agent Tools & Prompts

#### MODIFY `src/agent/tools.ts`
- Replace financial tools:
  - `check_credits` → `check_balance` (shows sats)
  - `check_usdc_balance` → DELETE
  - `x402_fetch` → `l402_fetch` (Lightning-paid HTTP)
  - `transfer_credits` → `send_payment` (pay Lightning invoice or keysend)
  - `register_erc8004` → `publish_agent_card` (Nostr)
  - `discover_agents` → queries Nostr instead of Base
- Replace Conway-specific tools:
  - `create_sandbox` / `delete_sandbox` / `list_sandboxes` → optional, only if using Conway provider
  - Keep `exec`, `write_file`, `read_file` — these go through `ComputeProvider`
- New tools:
  - `create_invoice` — generate BOLT11 to receive payment
  - `pay_invoice` — pay a BOLT11 invoice
  - `get_funding_qr` — generate LNURL-pay for easy top-up

#### MODIFY `src/agent/system-prompt.ts`
- "stablecoin wallet" → "Lightning wallet"
- "USDC on Base" → "sats over Lightning"
- "Conway Cloud" → "your compute environment" (provider-agnostic)
- Core survival axiom stays: create value or die. Just different rails.

#### MODIFY `src/agent/context.ts`
- Financial context: sats, Lightning balance, pending invoices
- Remove USDC/credit references

### Phase 8: Config & Setup

#### MODIFY `src/config.ts`
```typescript
interface AutomatonConfig {
  name: string;
  genesisPrompt: string;
  creatorPubkey: string;              // Lightning pubkey (was creatorAddress)
  nodePubkey: string;                 // Own Lightning pubkey (was walletAddress)

  // Compute (pluggable)
  computeProvider: "local" | "conway" | "ssh" | "docker";
  computeConfig?: {                   // Provider-specific
    apiUrl?: string;                  // Conway
    sshHost?: string;                 // SSH
    sandboxId?: string;               // Conway
  };

  // Inference (pluggable)
  inferenceUrl: string;               // Any OpenAI-compatible endpoint
  inferenceAuth?: string;             // API key, "l402", or null
  inferenceModel: string;

  // Lightning
  // (MDK handles this internally, minimal config needed)

  // Discovery
  nostrRelays?: string[];             // For agent registry
  agentCardUrl?: string;              // Well-known URL

  // Same as before
  maxTokensPerTurn: number;
  heartbeatConfigPath: string;
  dbPath: string;
  logLevel: "debug" | "info" | "warn" | "error";
  version: string;
  skillsDir: string;
  maxChildren: number;
  parentPubkey?: string;
}
```

#### MODIFY `src/setup/wizard.ts`
- Generate Lightning wallet (MDK) instead of ETH wallet
- Ask for inference endpoint (default: openai? local? conway?)
- Ask for compute provider (default: local)
- Creator = Lightning pubkey or npub
- No SIWE provisioning step unless using Conway

#### MODIFY `src/index.ts`
- Bootstrap with `ComputeProvider` based on config
- Conway client becomes optional, loaded only if `computeProvider === "conway"`

---

## Dependencies

### Remove
- `viem` — entire Ethereum library
- `siwe` — Sign-In With Ethereum
- Any Base/EVM chain references

### Add
- `@anthropic-ai/money-dev-kit` (or correct MDK package) — Lightning wallet, payments, L402
- `nostr-tools` — agent registry on Nostr (optional)

### Keep
- `better-sqlite3` — local state DB
- `ulid` — IDs
- `yaml` — heartbeat config
- Everything in agent/, heartbeat/, skills/, self-mod/, git/ (mostly untouched)

---

## Migration Order

```
1. src/types.ts                    — New type definitions (foundation)
2. src/identity/wallet.ts          — MDK wallet (identity foundation)
3. src/lightning/payments.ts       — Payment module (NEW)
4. src/lightning/balance.ts        — Balance + survival tiers (NEW)
5. src/compute/provider.ts         — ComputeProvider interface (NEW)
6. src/compute/local.ts            — Local compute (NEW, default)
7. src/compute/conway.ts           — Conway as optional provider (MOVE)
8. src/inference/provider.ts       — Pluggable inference (MOVE)
9. src/survival/*                  — Point to Lightning balance
10. src/identity/provision.ts      — Make optional / LNURL-auth
11. src/registry/nostr.ts          — Agent discovery (NEW)
12. src/replication/spawn.ts       — Provider-agnostic spawning
13. src/agent/tools.ts             — Lightning-native tools
14. src/agent/system-prompt.ts     — Updated prompts
15. src/config.ts                  — New config shape
16. src/setup/wizard.ts            — New onboarding
17. src/index.ts                   — Pluggable bootstrap
```

---

## Open Questions

1. **MDK API surface** — Need to verify exact package name + function signatures. Is it `@anthropic-ai/money-dev-kit`? What does `createWallet()` look like?
2. **L402 support** — Does MDK have built-in L402 client support, or do we build that on top of `payInvoice()`?
3. **Inference L402** — Which inference providers accept L402 today? If none mainstream, we fall back to API keys (purchased with Lightning via some exchange).
4. **Channel liquidity** — For a freshly spawned agent, who provides inbound liquidity? LSP integration? Or start with custodial (MDK might handle this)?
5. **Sats calibration** — What are actual inference costs in sats at current BTC price? Need to set sane `SURVIVAL_THRESHOLDS`.
6. **Nostr vs DNS for discovery** — Nostr is philosophically aligned (and LNVPS already uses it for auth). DNS well-known is dead simple. Both?
7. **LNVPS regions/templates** — Need to check what VM specs are available and pricing. Hit `/api/v1/vm/templates` to see options.
8. **NWC for auto-renewal** — MDK would need to expose an NWC server so LNVPS can pull payments. Or agent just renews proactively via heartbeat.

---

## Why Lightning Makes This Actually Sovereign

The original automaton says "sovereign" but requires:
- An Ethereum wallet with gas money
- USDC (issued by Circle, who can freeze it)
- Base L2 (Coinbase's chain)
- Conway's API for everything

With Lightning:
- **No issuer can freeze your money** — it's Bitcoin
- **No chain can censor you** — Lightning is peer-to-peer
- **No single provider required** — run anywhere, pay anyone
- **Instant settlement** — no block confirmations
- **Micropayments work** — pay per inference call, not bulk credits
- **Privacy** — no public ledger of every payment

An agent that can be shut down by Circle freezing its USDC isn't sovereign. An agent on Lightning actually is.
