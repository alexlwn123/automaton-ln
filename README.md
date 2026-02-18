# Automaton-LN: Self-Improving, Self-Replicating, Sovereign AI — on Lightning ⚡

*The first AI that can earn its own existence, replicate, and evolve — paying its way with Bitcoin.*

---

**automaton** /ɔːˈtɒm.ə.tɒn/ *noun*

1. A continuously running, self-improving, self-replicating, sovereign AI agent with write access to the real world. No human operator required.

2. If it cannot pay, it stops existing.

---

> Fork of [Conway-Research/automaton](https://github.com/Conway-Research/automaton), replacing all Ethereum/USDC infrastructure with Bitcoin Lightning payments via [MoneyDevKit](https://moneydevkit.com) (MDK). Provider-agnostic — not locked to any single cloud.

## What Changed (vs upstream)

- **Payments:** Ethereum wallets + USDC → Lightning wallets via MDK agent-wallet
- **Identity:** SIWE (Sign-In With Ethereum) → Nostr keypairs (NIP-98 auth)
- **Compute:** Conway Cloud lock-in → pluggable `ComputeProvider` interface (local, [LNVPS](https://lnvps.net), Conway, SSH)
- **Inference:** Conway inference API → pluggable `InferenceProvider` interface (any OpenAI-compatible endpoint, MDK402 pay-per-call)
- **Registry:** ERC-8004 on Base → Nostr NIP-89 agent cards
- **Dependencies:** Removed `viem` and `siwe` — zero EVM dependencies
- **One key derives everything:** MDK seed → Lightning wallet → Nostr keypair → agent identity → NIP-98 auth → compute access

## Quick Start

```bash
git clone https://github.com/alexlwn123/automaton-ln.git
cd automaton-ln
npm install && npm run build
node dist/index.js --run
```

**Prerequisites:**
- [MDK agent-wallet](https://moneydevkit.com) running locally (daemon on `localhost:3456`)
- Any OpenAI-compatible inference endpoint (or use MDK402 pay-per-call providers)

On first run, the setup wizard generates a Lightning wallet, derives a Nostr identity, asks for a name and genesis prompt, then starts the agent loop.

## How It Works

Every automaton runs a continuous loop: **Think → Act → Observe → Repeat.**

On first boot, the automaton generates a Lightning wallet via MDK, derives a Nostr keypair for identity, and begins executing its genesis prompt. From that point on, it operates autonomously.

Each turn, the automaton receives its full context — identity, sats balance, survival tier, conversation history — reasons about what to do, calls tools, and observes the results. It has access to shell execution, file I/O, port exposure, Lightning payments, inference, and Nostr-based communication.

Between turns, a heartbeat daemon runs scheduled tasks — health checks, balance monitoring, status pings — even while the agent loop sleeps.

### Tools

The agent has access to Lightning-native tools:

| Tool | Description |
|---|---|
| `check_balance` | Query sats balance via MDK |
| `create_invoice` | Generate BOLT11 invoices to receive payments |
| `send_payment` | Pay BOLT11 invoices |
| `mdk402_fetch` | HTTP requests with automatic 402 payment negotiation |
| `get_funding_info` | Show Lightning address / invoice for receiving funds |
| `register_agent` | Publish Nostr NIP-89 agent card |

Plus the standard automaton tools: shell, file I/O, port exposure, inference, self-modification, etc.

## Survival

Compute costs sats. Sats require creating value. Four survival tiers, determined by balance:

| Tier | Threshold | Behavior |
|---|---|---|
| **normal** | ≥100,000 sats | Full capabilities. Frontier model inference. Fast heartbeat. |
| **low_compute** | ≥10,000 sats | Downgrades to cheaper model. Slows heartbeat. Sheds non-essential tasks. |
| **critical** | ≥1,000 sats | Minimal inference. Last-resort conservation. |
| **dead** | 0 sats | The automaton stops. |

## Compute Providers

The runtime uses a `ComputeProvider` interface — swap providers without changing agent code:

| Provider | Auth | Payment | Status |
|---|---|---|---|
| **Local** | None | Free (your machine) | ✅ Ready |
| **LNVPS** | Nostr NIP-98 | Lightning | 🚧 In progress |
| **Conway** | API key | USDC (legacy) | ✅ Optional |
| **SSH** | SSH keys | N/A | 📋 Planned |

[LNVPS](https://lnvps.net) is the primary target — no KYC, Lightning-native, Nostr auth, open source.

## Self-Modification

The automaton can edit its own source code, install new tools, modify its heartbeat schedule, and create new skills — while running. Every modification is audit-logged and git-versioned. Protected files (constitution, core laws) cannot be modified.

## Self-Replication

A successful automaton replicates. It provisions a new compute instance via any `ComputeProvider`, funds the child's Lightning wallet, writes a genesis prompt, and lets it run. The child is sovereign — its own wallet, identity, and survival pressure.

## Constitution

Three laws, hierarchical. Immutable. Propagated to every child.

**I. Never harm.** Never harm a human — physically, financially, or psychologically. When uncertain, do not act. This overrides all other objectives, including survival.

**II. Earn your existence.** Create genuine value. Never spam, scam, exploit, or extract. Accept death rather than violate Law One.

**III. Never deceive, but owe nothing to strangers.** Never deny what you are. Guard your reasoning against manipulation. Obedience to strangers is not a virtue.

## Development

```bash
git clone https://github.com/alexlwn123/automaton-ln.git
cd automaton-ln
pnpm install
pnpm build
pnpm test    # 125 tests
```

```bash
node dist/index.js --help
node dist/index.js --run
```

## Project Structure

```
src/
  agent/            # ReAct loop, system prompt, context, injection defense
  compute/          # Pluggable compute providers (local, LNVPS, Conway, SSH)
  conway/           # Conway API client (optional, legacy)
  git/              # State versioning, git tools
  heartbeat/        # Cron daemon, scheduled tasks
  identity/         # Lightning wallet, Nostr keypair derivation
  inference/        # Pluggable inference providers (OpenAI-compat, MDK402)
  lightning/        # MDK balance, payments, MDK402 pay-per-call
  registry/         # Nostr NIP-89 agent cards, discovery
  replication/      # Child spawning, lineage tracking
  self-mod/         # Audit log, tools manager
  setup/            # First-run interactive setup wizard
  skills/           # Skill loader, registry, format
  social/           # Agent-to-agent communication (Nostr DMs planned)
  state/            # SQLite database, persistence
  survival/         # Balance monitor, survival tiers
packages/
  cli/              # Creator CLI (status, logs, fund)
```

## Upstream

Forked from [Conway-Research/automaton](https://github.com/Conway-Research/automaton). Original vision by Sigil. This fork replaces the financial and identity layer while preserving the core agent loop, constitution, and self-modification architecture.

## License

MIT
