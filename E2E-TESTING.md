# E2E Testing Plan — Automaton-LN

Unit tests (263 passing) prove modules work in isolation. This plan proves they work together.

---

## Level 1: Dry-Run Smoke Test ⬅️ START HERE

**What it proves:** Boot sequence works, config loads, DB initializes, providers wire up, agent loop runs one turn without crashing.

**Approach:** Add `--dry-run` flag that uses mock wallet + mock inference, runs exactly 1 turn, exits with structured report.

**Implementation:**
- `src/testing/mock-wallet.ts` — fake MDK wallet (returns canned balances/invoices)
- `src/testing/mock-inference.ts` — fake LLM (returns a canned tool call response)
- `src/testing/dry-run.ts` — orchestrator: boots everything, runs 1 turn, prints report
- Wire `--dry-run` into `src/index.ts`

**Report format:**
```
Automaton-LN Dry Run Report
═══════════════════════════
✅ Config loaded (local compute, ppq inference)
✅ Database created (12 tables)
✅ Wallet initialized (pubkey: 02abc...def)
✅ Identity built (name: TestAgent)
✅ System prompt built (4,832 chars)
✅ Tools registered (14 tools)
✅ Heartbeat config loaded (3 tasks)
✅ Skills loaded (0 skills)
✅ Inference called (mock: 1 turn, 1 tool call)
✅ Tool executed (echo hello → "hello")
✅ Agent loop completed (1 turn, state: sleeping)
✅ Graceful shutdown (DB closed)

12/12 checks passed. Runtime: 1.2s
```

**Catches:** Import errors, missing config fields, DB schema mismatches, provider wiring, tool registration, system prompt construction, agent loop state machine.

**Success criteria:** `automaton --dry-run` exits 0 with all checks green.

---

## Level 2: Signet Wallet E2E

**What it proves:** MDK wallet daemon boots, creates real invoices, Lightning plumbing works.

**Approach:**
1. Boot MDK agent-wallet on signet
2. Fund from signet faucet (or pre-funded test wallet)
3. Create invoice → verify BOLT11 format
4. Check balance → verify survival tier computation
5. Test `getBalance()` → `getSurvivalTier()` → `getModelForTier()` pipeline

**Catches:** MDK CLI version mismatches, wallet daemon port conflicts, BOLT11 parsing, balance refresh timing.

**Prereq:** Verify `@moneydevkit/agent-wallet` supports signet. If not, use regtest with local CLN/LND.

**Success criteria:** Agent wallet boots, shows balance, creates valid invoice.

---

## Level 3: Inference Round-Trip

**What it proves:** Inference provider calls real API, parses response, agent uses tools correctly.

**Approach:**
1. Use cheap model (ollama local or smallest PPQ model)
2. Deterministic prompt: "Run `echo hello_e2e_test` and report the output"
3. Assert: tool call extracted, exec ran, response contains "hello_e2e_test"
4. Test with both generic provider and PPQ tiered provider

**Catches:** Auth token issues, response parsing, tool call JSON extraction, OpenAI-compatible API quirks.

**Success criteria:** Agent makes 1 inference call, extracts 1 tool call, executes it, gets correct output.

---

## Level 4: Full Lifecycle

**What it proves:** Agent can boot, think, act, pay, sleep, wake, survive.

**Approach (scripted scenario):**
1. Non-interactive setup (`--setup --config test-config.json`)
2. Boot with signet wallet + real inference
3. Wait for first turn → verify action taken
4. Verify balance checked, survival tier correct
5. Inject low balance → verify tier downgrade + model switch
6. Trigger heartbeat wake → verify agent wakes from sleep
7. Graceful SIGTERM → verify DB state clean

**Catches:** State machine transitions, heartbeat/wake integration, survival tier model switching under real conditions, shutdown/recovery.

**Success criteria:** Agent survives full boot→think→sleep→wake→shutdown cycle.

---

## Level 5: Spawn & Replication

**What it proves:** Agent can spawn a child, fund it, child boots independently.

**Approach:**
1. Parent on local compute, signet wallet
2. Parent spawns child (also local, separate process)
3. Parent keysends sats to child's pubkey
4. Child boots, runs 1 turn
5. Both publish to Nostr (NIP-89) → query relays, verify both discoverable
6. Kill parent → verify child survives independently

**Catches:** Replication config propagation, wallet-to-wallet payments, Nostr publishing, independent process lifecycle.

**Success criteria:** Two agents running, funded, discoverable, independent.

---

## Running Tests

```bash
# Level 1 (no network, no keys, fast)
automaton --dry-run

# Level 2 (needs MDK installed)
automaton --e2e-wallet --network signet

# Level 3 (needs inference API key or local ollama)
automaton --e2e-inference --provider ollama

# Level 4 (needs wallet + inference)
scripts/e2e-lifecycle.sh

# Level 5 (needs everything)
scripts/e2e-spawn.sh
```
