# Altus Commonware Research MCP

A stdio MCP server that queries **Commonware** blockchain research via NotebookLM. Each teammate runs it locally — NotebookLM workspace access controls who can query.

## Prerequisites

1. **Google Chrome** must be installed (used for the built-in `login` flow via Chrome DevTools Protocol).

2. (Optional) Create a GitHub personal access token (for `search_implementation` / `suggestion` / `factcheck` tools):
   - Go to https://github.com/settings/tokens
   - Generate a token — **no scopes needed** for public repos

3. Clone and build:
   ```bash
   git clone <repo-url>
   cd altus-commonware-research-mcp
   npm install
   cp .env_example .env
   ```
   Then build:
   ```bash
   npm run build
   ```

4. Build the local code search index (requires `GITHUB_TOKEN` and `REFERENCE_REPOS` in `.env`):
   ```bash
   npm run setup-index
   ```
   This fetches file trees and content from all `REFERENCE_REPOS` and stores them in a local SQLite FTS5 database (`data/index.db`) for fast code search. To re-index later (e.g. after upstream changes), run with `--force`:
   ```bash
   npm run setup-index -- --force
   ```
   You can also re-index at runtime via the `setup_db` MCP tool.

5. Authenticate with NotebookLM by calling the `login` tool. This launches Chrome, lets you sign in to your Google account, and extracts auth cookies automatically.

## Configuration

Edit `.env` to configure the server:

```env
NOTEBOOK_ID=<your-notebook-id>
REFERENCE_REPOS=commonwarexyz/alto,commonwarexyz/monorepo,tempoxyz/tempo,paradigmxyz/reth
GITHUB_TOKEN=ghp_...
```

| Variable | Required | Description |
|---|---|---|
| `NOTEBOOK_ID` | Yes | NotebookLM notebook ID (from the notebook URL) |
| `REFERENCE_REPOS` | Yes | Comma-separated list of GitHub repos (`owner/name`). These are the repos that `suggestion`, `search_implementation`, and `factcheck` search against. |
| `GITHUB_TOKEN` | No | GitHub personal access token. No scopes needed for public repos, but recommended to avoid rate limits. |
| `SQLITE_DB_PATH` | No | Path to SQLite database file. Default: `data/index.db` in the project root. |

The `REFERENCE_REPOS` list determines which repositories the tools can search. Tools like `suggestion` and `factcheck` auto-select the most relevant repos from this list per query, or you can override with the `repos` argument.

## Connect to MCP

### Claude Code

Add to your Claude Code MCP settings (`~/.claude/settings.json` or project `.mcp.json`):
```json
{
  "mcpServers": {
    "altus-research": {
      "command": "node",
      "args": ["/absolute/path/to/altus-commonware-research-mcp/dist/index.js"]
    }
  }
}
```

### Gemini CLI

Add to `~/.gemini/settings.json`:
```json
{
  "mcpServers": {
    "altus-research": {
      "command": "node",
      "args": ["/absolute/path/to/altus-commonware-research-mcp/dist/index.js"]
    }
  }
}
```

### Codex CLI

Add to `~/.codex/config.toml`:
```toml
[mcp_servers.altus-research]
command = "node"
args = ["/absolute/path/to/altus-commonware-research-mcp/dist/index.js"]
```

## Tools

### `login`

Authenticate with NotebookLM. Launches Chrome, waits for you to sign in to your Google account, and extracts auth cookies via CDP.

---

### `refresh_auth`

Reload NotebookLM auth tokens from disk. Use this after re-running `login` in another session, or if tokens were updated externally.

---

### `query`

Ask a **question about Altus Commonware Research** directly to NotebookLM — useful for quick lookups on concepts, design rationale, or protocol details.

- **Arguments**:
  - `question`: The research question to ask.

**Example**:

> **Q:** `"What is the actor pattern in Commonware and why is it preferred over mutexes?"`
>
> **A:** The actor pattern in Commonware uses mailbox-based async message passing where each actor owns its state exclusively. This avoids mutex contention and deadlocks — actors communicate by sending messages rather than sharing memory. The one-writer/many-readers model ensures each piece of state has a single owner, which simplifies reasoning about concurrency and improves throughput under high parallelism…

---

### `suggestion`

Get an **architectural implementation suggestion** that combines NotebookLM research with actual code snippets from reference repos. This is a two-stage flow:

**Example**:

> **Q:** `"How would I implement a mempool in Commonware?"`
>
> **A:**
> ## Summary
> - Mempools in Commonware buffer pending payloads at the **primitive** level, partitioned by namespace.
> - The Alto reference client implements this as an actor that owns a `BTreeMap` of pending containers, drained by the proposer on each build cycle.
> - Key design decision: the mempool actor uses **one-writer ownership** — only the mempool actor mutates the pending set; the proposer reads a snapshot via async request.
>
> *(followed by reasoning, code examples from reference repos, and a suggested `search_implementation` query)*

---

### `search_implementation`

Search reference repository and return source code snippets **explaining how the feature is actually implemented**.

**Example**:

> **Q:** `"How Tempo implemented Automaton trait that connect Commonware Simplex consensus engine"`
>
> **A:**
> ## Summary
> - Tempo connects to Commonware Simplex by using an application actor as the consensus-execution bridge, explicitly documented as implementing `commonware_consensus::Automaton`.
> - Commonware Simplex is parameterized over `A: CertifiableAutomaton`, so Tempo plugs its application-side automaton adapter into that slot.
> - Architecturally, the flow is **Simplex consensus actors → automaton interface → Tempo application/executor/marshal actors**.
>
> ## Implementation Details
>
> **Tempo's consensus engine defines the Automaton bridge point** — `application` is annotated as the component that implements the consensus automaton interface, sitting next to executor/marshal synchronization actors.
>
> ```rust
> // crates/commonware-node/src/consensus/engine.rs (lines 438–454)
>
> /// Acts as the glue between the consensus and execution layers implementing
> /// the `[commonware_consensus::Automaton]` trait.
> application: application::Actor<TContext>,
>
> /// Responsible for keeping the consensus layer state and execution layer
> /// states in sync.
> executor: crate::executor::Actor<TContext>,
> executor_mailbox: crate::executor::Mailbox,
> ```
>
> **Simplex requires an automaton type parameter** — the engine is generic over `A: CertifiableAutomaton`, making the automaton the formal interface between consensus and the application/execution domain.
>
> ```rust
> // consensus/src/simplex/engine.rs (lines 19–29)
>
> pub struct Engine<
>     E: BufferPooler + Clock + CryptoRngCore + Spawner + Storage + Metrics,
>     S: Scheme<D>,
>     ...
>     A: CertifiableAutomaton<Context = Context<D, S::PublicKey>, Digest = D>,
>     ...
> > {
> ```
>
> *(truncated — full output includes construction-site evidence and flow analysis)*

---

### `factcheck`

**Validate a document** (or a set of claims) against actual source code in reference repos.

**Example**:

> **Q:** `"Validate this document: [Alto architecture and Simplex consensus flow documentation...]"`
>
> **A:**
> ## Result
> - Core Alto/Simplex claims are mostly supported.
> - A non-trivial subset came back **INSUFFICIENT_EVIDENCE** (tool retrieval failed to find enough code proof), not NOT_VERIFIED.
> - No direct NOT_VERIFIED verdicts were returned.
>
> ## Claims with strong support (Verified)
> - Alto is minimal and omits transaction execution/state logic.
> - Alto block type includes parent, height, timestamp, and precomputed digest.
> - Simplex voter/application interaction (propose/verify) is present.
> - Batcher vote verification/certificate construction behavior is supported.
> - Alto fixed-epoch config (`u64::MAX`) and timeout constants (~256, ~32) are supported.
> - Tempo has Reth/engine-validator integration evidence.
>
> ## Claims not fully proven (INSUFFICIENT_EVIDENCE or Partially Verified)
> - Some marshal persistence/dataflow claims (proof incomplete at flow level).
> - `verify → marshal.subscribe → return result` path (not retrieved with sufficient evidence).
> - Tempo epoch-manager and DKG epoch-transition claims (not sufficiently retrieved).
> - Some conceptual/proof statements (PBFT/Simplex correctness arguments) are only partially verifiable from implementation code.
>
> ## Practical conclusion
> - Your document is directionally accurate for Alto architecture and Simplex flow.
> - Treat Tempo epoch/DKG sections and some deep flow claims as "needs explicit code citations" before calling it fully validated.
>
> *(truncated — full output includes claim-by-claim verdict table, evidence appendix, and fix suggestions)*

---

### `setup_db`

Initialize or re-index the local SQLite FTS5 search index at runtime. Same as `npm run setup-index` but callable as an MCP tool.

- **Arguments**:
  - `repos` (optional): Subset of `REFERENCE_REPOS` to index.
  - `force` (optional): Re-index even if already indexed.
