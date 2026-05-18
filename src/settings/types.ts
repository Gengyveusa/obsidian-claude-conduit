import type { SnapshotMeta } from '../timetravel/types';

/**
 * Plugin settings — per docs/02_SPEC.md §3.1.
 *
 * Persisted to `<vault>/.obsidian/plugins/obsidian-claude-conduit/data.json`
 * via Obsidian's plugin API (`this.loadData()` / `this.saveData()`).
 *
 * The API key field MUST never be committed to git; the plugin's data dir
 * is gitignored by default per spec §7 threat model.
 */
/**
 * Phase 6.7+ (v1.4.2) — one bearer-token entry in the MCP bridge's
 * token list per [ADR-032](../../docs/2026-05-15-adr-032-mcp-token-slots.md).
 *
 * Operators name each token after the MCP client that holds it
 * (`claude-desktop`, `cursor`, `cline`, etc.); the hash is the
 * sha-256 of the raw token (shown once on generation, never stored).
 * Scope caps the tools the token can see + call (D2). The `legacy`
 * name is reserved for D10 migration.
 */
export interface McpTokenEntry {
  /** Operator-supplied label, kebab-case 1-40 chars (D4). */
  name: string;
  /** sha-256 hex hash of the raw token (D5). */
  hash: string;
  /** Capability ceiling: `read` < `write` < `delete` (D2). */
  scope: 'read' | 'write' | 'delete';
  /** Epoch ms; for chronological sort in settings UI. */
  createdAt: number;
  /** Epoch ms of last successful auth; `null` if never used (D6). */
  lastUsedAt: number | null;
}

export interface SagittariusSettings {
  // Anthropic API
  apiKey: string;
  defaultModel: 'claude-sonnet-4-6' | 'claude-opus-4-7' | 'claude-haiku-4-5-20251001';
  fallbackModel: 'claude-sonnet-4-6' | 'claude-opus-4-7' | 'claude-haiku-4-5-20251001';

  // Embeddings (per ADR-013): HuggingFace Inference API.
  // Free read-token from huggingface.co/settings/tokens. Required for
  // search_vault / vault-qa mode; chat-mode + 4 vault-API tools work
  // without it.
  huggingfaceApiKey: string;

  // Retrieval
  indexingMode: 'auto' | 'manual';
  retrievalK: number;
  embeddingProvider: 'local' | 'voyage';
  voyageApiKey: string;
  voyageModel: 'voyage-3' | 'voyage-3-lite';

  // Budget (per spec §3.4)
  maxTokensPerDay: number;
  maxDollarsPerDay: number;
  budgetResetTimezone: string;

  // Conversation log (per spec §3.3)
  conversationLogPath: string;
  conversationLogEnabled: boolean;

  // UI
  sidebarPosition: 'right' | 'left';
  streamingEnabled: boolean;
  showCitations: boolean;

  // Phase 4 write layer (per ADR-016 D2)
  /**
   * `'review'` (default): every write tool routes through the diff card —
   * user must Confirm before any file changes. `'auto'` skips the diff
   * card and applies writes immediately. Reserved in v0.5.0 but the
   * `'auto'` code path is not wired yet (per ADR-016 D2: "`auto` ships
   * after Phase 4 is battle-tested"). Surfacing the setting here lets
   * us flip the wiring on without a data migration when ready.
   */
  writeMode: 'review' | 'auto';
  /**
   * Default folder for `file_asset` writes when the LLM doesn't specify
   * one. Convention: `'attachments'` at the vault root. Override if
   * your Obsidian "Files & Links → Attachment folder path" differs.
   */
  defaultAttachmentsFolder: string;

  // Phase 5 organization engine (per ADR-017 D5)
  /**
   * Master switch. When false, no vault events are subscribed, no
   * classifier calls happen, no queue items get added. Defaults off
   * because Phase 5 is a meaningful behavior change — we don't opt
   * users in silently.
   */
  organizationEnabled: boolean;
  /**
   * Vault-relative folders where new/modified notes get classified.
   * Files outside these prefixes are ignored. Default `['10-Inbox/']`.
   */
  organizationWatchedFolders: string[];
  /**
   * Which Claude model the classifier calls. Sonnet default per
   * ADR-017 D4 override — better routing quality than Haiku at
   * modest cost. Users with high-volume inboxes can downgrade.
   */
  organizationClassifierModel:
    | 'claude-sonnet-4-6'
    | 'claude-haiku-4-5-20251001'
    | 'claude-opus-4-7';
  /**
   * Confidence threshold for surfacing in the panel. Suggestions
   * below this are stored on disk but filtered from the default view
   * (a future "show low-confidence" toggle reveals them). Range 0..1;
   * default 0.6 per ADR-017 D4.
   */
  organizationMinConfidence: number;
  /**
   * Background sweep interval, seconds. 0 = manual only (default).
   * Non-zero values schedule a periodic `watcher.sweep()`. ADR-017
   * D5 keeps this opt-in.
   */
  organizationSweepIntervalSec: number;
  /**
   * Vault-relative paths to MOC notes that the `moc-add` classifier
   * (v0.6.x — not v0.6.0) considers for link insertion. Empty in
   * v0.6.0; populated by users once v0.6.x ships moc-add.
   */
  organizationMocFolders: string[];

  // Phase 6 activity stream (per ADR-019 D4 + architecture note)
  /**
   * Master switch for the activity stream. When on, every classifier
   * call, suggestion lifecycle event, write, undo, and error is
   * persisted to `<plugin-data>/activity.json` (rolling 1000-entry cap)
   * and surfaced in the `Sagittarius: Open activity stream` panel.
   * Default on — the disk footprint is tiny and the diagnostic value
   * is the whole point of Phase 6. Toggling requires a plugin reload
   * to fully apply (subsystems cache the dep at construction).
   */
  activityLogEnabled: boolean;

  // Phase 6.5 MCP bridge (per ADR-021 D6)
  /**
   * Master switch for the MCP bridge. When on, Sagittarius exposes its
   * read-only tools (`read_note`, `list_folder`, `search_vault`,
   * `get_backlinks`, `get_graph_neighborhood`) over Model Context
   * Protocol to external Claude clients (Claude Desktop, Claude Code).
   * Default off — turning it on binds a localhost HTTP port and
   * issues a bearer token.
   */
  mcpEnabled: boolean;
  /**
   * Localhost port to bind. Default 8765 per ADR-021 D6. Conflict =
   * server refuses to start with a Notice; user picks a new port.
   */
  mcpPort: number;
  /**
   * **Deprecated as of v1.4.2 (ADR-032).** The single-token slot is
   * preserved only for migration: on plugin load, when this field is
   * non-empty AND `mcpTokens` is empty, the value is migrated into a
   * `mcpTokens` entry named `legacy` (per ADR-032 D10) and this field
   * is cleared. New code reads from `mcpTokens` exclusively.
   */
  mcpToken: string;
  /**
   * Phase 6.7+ (v1.4.2) — per-client MCP bearer tokens per
   * [ADR-032](../../docs/2026-05-15-adr-032-mcp-token-slots.md). Each
   * entry carries a named token (its sha-256 hash; raw is shown once
   * on generation) and a scope tier (`read` / `write` / `delete`) that
   * caps which tools the holder can see + call. Empty array = no
   * tokens configured; the bridge refuses every request even if
   * `mcpEnabled = true`.
   *
   * Scope semantics per ADR-032 D2:
   *   - `read` — 5 read tools only
   *   - `write` — 5 read + 9 write tools (still gated by `mcpWriteEnabled`)
   *   - `delete` — `write` set + `delete_note` (still gated by
   *     `mcpHighRiskToolsEnabled`)
   *
   * Global toggles (`mcpWriteEnabled`, `mcpHighRiskToolsEnabled`)
   * become circuit-breakers per ADR-032 D3 — they cap what any
   * scope can actually do.
   */
  mcpTokens: McpTokenEntry[];
  /**
   * Optional allowlist of MCP `clientInfo.name` values. Empty = any
   * authenticated client may connect. Use to restrict the bridge to
   * a specific external app (e.g. `['claude-desktop']`).
   */
  mcpAllowedClients: string[];

  // Phase 6.7 MCP write-side (per ADR-025; substrate lands in v1.0.8,
  // tool exposure flips in v1.0.9, queue UI lands in v1.1.0).
  /**
   * Master switch for MCP write-side. When off (default), MCP clients
   * only see the 5 read-only tools — the 10 write tools never appear
   * in `tools/list` and any `tools/call` for a write tool returns
   * `Method not found`. Per ADR-025 D1, off-by-default keeps the
   * write blast-radius gated behind explicit user opt-in.
   */
  mcpWriteEnabled: boolean;
  /**
   * Per-client write-permissions subset of `mcpAllowedClients`. When
   * non-empty, only the listed clients (matched by `clientInfo.name`)
   * may call write tools. Empty = all authenticated clients may write
   * if `mcpWriteEnabled` is on. Per ADR-025 D6 — read access can stay
   * broad while write access is narrowed.
   */
  mcpWriteAllowedClients: string[];
  /**
   * Path-prefix allowlist for MCP-driven writes per ADR-025 D7. A
   * write tool whose target path doesn't `startsWith` any of these
   * prefixes is rejected at the MCP layer before the diff card opens.
   * Default `['10-Inbox/']` mirrors the organization engine's watched-
   * folders convention. Empty = no path scoping (trust the diff card).
   */
  mcpWritePathPrefixes: string[];
  /**
   * Soft rate limit per ADR-025 D9: max write proposals per rolling
   * 60-minute window across all MCP clients combined. Beyond this,
   * `tools/call` for a write tool returns a `'rate-limited'` JSON-RPC
   * error. 0 = disabled. Default 30/hour.
   */
  mcpWriteRateLimitPerHour: number;
  /**
   * Per ADR-025 D1, the `delete_note` tool is destructive enough that
   * MCP access requires an explicit second toggle on top of
   * `mcpWriteEnabled`. Other write tools route through the diff card
   * which makes them trivially reversible; deletions are reversible
   * via undo but the recovery path requires the user to be present
   * at Obsidian to notice the deletion happened. Default false.
   */
  mcpHighRiskToolsEnabled: boolean;
  /**
   * Per ADR-025 D2 (c) — hybrid block-then-queue timeout. When an MCP
   * write proposal arrives, `McpHandler` races `registry.execute`
   * against this timeout. If the user approves/rejects within the
   * window the MCP response carries the result; on timeout the
   * response carries `'queued'` and the proposal stays alive in the
   * external-proposals side panel until the user responds (the file
   * still writes on eventual accept). Default 30000 ms; 0 disables
   * the queue path entirely (pure synchronous block — recommended
   * only for testing).
   */
  mcpWriteQueueTimeoutMs: number;
  /**
   * Per ADR-025 D3 — when a write proposal queues, fire an Electron
   * `Notification` ("Sagittarius: write proposal pending from
   * Claude Desktop. Click to review."). Click focuses Obsidian and
   * opens the external-proposals panel. Default true; opt-out per
   * ADR-019 D6 convention. Platforms where the Notification API
   * fails silently (some Linux WMs) degrade to status-bar-pill only.
   */
  mcpWriteNotifyOnQueue: boolean;

  // Phase 8 generative drafting (per ADR-026)
  /**
   * Per ADR-026 D4 — model used by `AnthropicDraftingEngine`. Opus
   * 4.7 default because drafting is the quality-bias operation;
   * users can downgrade to Sonnet if budget pressure dominates.
   * Drafting cost flows through the same `BudgetTracker` as chat
   * so users see the dollars in a single place.
   */
  draftingModel: 'claude-sonnet-4-6' | 'claude-opus-4-7' | 'claude-haiku-4-5-20251001';
  /**
   * Per ADR-026 D3 — citation contract enforcement. `'strict'` (every
   * paragraph cites; retries once on violation), `'marked'` (uncited
   * paragraphs must be wrapped in HTML comments; default), `'free'`
   * (no contract).
   */
  citationPolicy: 'strict' | 'marked' | 'free';
  /**
   * Default destination folder for new drafts when the modal's
   * "Destination folder" field is left blank. Per ADR-026 D1 (b)
   * drafts land at `_drafts/<destination>/<slug>.md`. Empty string =
   * drafts at the quarantine root.
   */
  draftsDefaultDestination: string;

  // Phase 9 memory layer (per ADR-029 D5, D6)
  /**
   * Master switch for the CLAUDE.md cascade per ADR-029. When off,
   * no memory is injected into the system prompt regardless of
   * which `CLAUDE.md` files exist in the vault. Default true; the
   * status bar pill ("memory off") signals the off state.
   */
  memoryEnabled: boolean;
  /**
   * Hard cap on the total bytes of CLAUDE.md text injected per turn
   * per ADR-029 D4. Default 50_000 (~12K tokens). The file that
   * pushes the running total over this cap is soft-truncated; any
   * remaining files in the cascade are skipped. The operator sees
   * a one-time `Notice` and the chat footer marker
   * `(budget hit — truncated)` when this fires.
   */
  memoryMaxBytes: number;

  // Phase 12 (v1.5.0) — reverse-memory journal per ADR-033
  /**
   * Master switch for `Sagittarius: Journal this session` per ADR-033
   * D7. Opt-in (default false) since the feature lets the agent
   * write durable notes about the operator into the vault. When off,
   * the journal command no-ops with an enable-me Notice + the
   * cascade skips the journal section regardless of
   * `journalCascadeDays`.
   */
  journalEnabled: boolean;
  /**
   * How many recent journal files to inject above the CLAUDE.md
   * cascade per ADR-033 D5. Default 3 days × ~400 tokens/day ≈ 1200
   * tokens in the system prompt. 0 disables journal cascade injection
   * without disabling the journaling command (useful while
   * experimenting).
   */
  journalCascadeDays: number;
  /**
   * Model used by `AnthropicJournalGenerator` per ADR-033 D4. Sonnet
   * default — journaling is bounded-token summarization, not the
   * quality-bias work drafting is. Operators who want richer entries
   * can upgrade to Opus per-setting.
   */
  journalModel: 'claude-sonnet-4-6' | 'claude-opus-4-7' | 'claude-haiku-4-5-20251001';

  // Phase 13 (v1.6.0) — conversational notes per ADR-034
  /**
   * Master switch for `Sagittarius: Save this conversation as a note`
   * per ADR-034 D7. Opt-in (default false) — the feature writes
   * full transcripts to the vault, which is a meaningful trust
   * ask. ChatView per-conversation opt-out (v1.6.1) layers on top
   * for sensitive sessions even when the global is on.
   */
  chatNotesEnabled: boolean;

  // Phase 14 (v1.7.0) — daily briefing per ADR-035
  /**
   * Master switch for the daily briefing per ADR-035 D7. Opt-in
   * (default false). When on, the plugin checks on each load whether
   * today's briefing exists; if not, fires generation. The
   * `Sagittarius: Generate today's briefing` command works as a
   * manual override regardless of this flag.
   */
  briefingEnabled: boolean;
  /**
   * OQ3 hedge from ADR-035 — cap items per section to keep the
   * briefing scannable in big vaults. Default 10.
   */
  briefingMaxItemsPerSection: number;
  /**
   * Per-day idempotency state per ADR-035 D2. Tracks the YYYY-MM-DD
   * of the most-recent briefing generation so plugin restarts within
   * the same day don't re-fire. Operator never sets this directly;
   * the scheduler writes it. Empty string = no briefing has fired
   * yet on this install.
   */
  briefingLastDay: string;

  // Phase 16 (v2.0) — time-travel queries per ADR-037
  /**
   * Master switch for time-travel features per ADR-037 D1. Opt-in
   * (default false). When off, the snapshot command surfaces a
   * one-time Notice with the enable-it path and the time-travel
   * mode is hidden from the ChatView dropdown.
   *
   * The schema migration (commit_sha column on chunks) runs
   * unconditionally — adds storage cost of effectively zero on
   * installs that never opt in (existing chunks keep commit_sha
   * NULL).
   */
  timeTravelEnabled: boolean;
  /**
   * Per ADR-037 D4 — retention policy for manual (untagged)
   * snapshots. Default 365 days. Tagged commits + pinned snapshots
   * are kept indefinitely regardless of this setting.
   */
  timeTravelRetentionDays: number;
  /**
   * Phase 16 (v1.10.0) — recorded snapshots per ADR-037 D6. The chunks
   * themselves live in the SQLite index under `commit_sha`; this
   * parallel list of `SnapshotMeta` carries display labels + tag +
   * timestamps so the picker modal renders instantly without scanning
   * the index. Mutated by `runSnapshotForTimeTravel` and (session 3)
   * the GC pass.
   */
  timeTravelSnapshots: SnapshotMeta[];

  // Phase 9.x (v1.4.0) — proactive draft suggestions per ADR-026 D8(b)
  /**
   * Minimum tag-cluster size before `Sagittarius: Suggest drafts`
   * proposes a synthesis. Lower = more candidates surfaced; higher
   * = only big clusters trigger. Default 5 — small enough to catch
   * meaningful clusters in modest vaults, big enough to skip
   * incidental tag use.
   */
  draftSuggestionMinNotes: number;

  // Phase 7 curator (per ADR-022 D2, D6)
  /**
   * Master switch for the curator. When off, `Sagittarius: Run curator`
   * surfaces a Notice and does nothing else; no rules ever run.
   * Default off — curator is opt-in like the organization engine.
   */
  curatorEnabled: boolean;
  /**
   * Per-sweep enqueue cap (ADR-022 D6 suggestion-fatigue mitigation).
   * The orchestrator severity-ranks all findings, then keeps the top N.
   * Default 20.
   */
  curatorMaxPerSweep: number;
  /**
   * Days since last modification before the orphan rule considers a
   * note stale. Lower = more aggressive archive proposals. Per
   * ADR-022 default 90.
   */
  curatorStaleNoteThresholdDays: number;
  /**
   * Per-rule enable map. Rule names not present default to enabled.
   * Set to `false` to disable a specific rule without touching others.
   */
  curatorEnabledRules: Record<string, boolean>;
  /**
   * v1.0.1 — per-folder frontmatter schema map. Key = folder prefix
   * (e.g. `'22-Decisions'`); value = required field names. Notes in
   * matching folders without all required fields produce
   * `add-frontmatter` suggestions. Empty (default) = rule disabled.
   */
  curatorFolderSchemas: Record<string, string[]>;
  /**
   * v1.0.3 — scheduled sweep interval, days. 0 = manual only
   * (default; per ADR-022 D2 hybrid mode). Non-zero values schedule
   * a periodic `runCurator()` via the plugin's `registerInterval`.
   */
  curatorSweepIntervalDays: number;
}

export const DEFAULT_SETTINGS: SagittariusSettings = {
  apiKey: '',
  defaultModel: 'claude-sonnet-4-6',
  fallbackModel: 'claude-opus-4-7',

  huggingfaceApiKey: '',

  indexingMode: 'manual',
  retrievalK: 8,
  embeddingProvider: 'local',
  voyageApiKey: '',
  voyageModel: 'voyage-3',

  maxTokensPerDay: 200_000,
  maxDollarsPerDay: 10,
  budgetResetTimezone: 'America/Los_Angeles',

  conversationLogPath: '70-Memory/conversations',
  conversationLogEnabled: true,

  sidebarPosition: 'right',
  streamingEnabled: true,
  showCitations: true,

  writeMode: 'review',
  defaultAttachmentsFolder: 'attachments',

  organizationEnabled: false,
  organizationWatchedFolders: ['10-Inbox/'],
  organizationClassifierModel: 'claude-sonnet-4-6',
  organizationMinConfidence: 0.6,
  organizationSweepIntervalSec: 0,
  organizationMocFolders: [],

  activityLogEnabled: true,

  mcpEnabled: false,
  mcpPort: 8765,
  mcpToken: '',
  mcpTokens: [],
  mcpAllowedClients: [],

  mcpWriteEnabled: false,
  mcpWriteAllowedClients: [],
  mcpWritePathPrefixes: ['10-Inbox/'],
  mcpWriteRateLimitPerHour: 30,
  mcpHighRiskToolsEnabled: false,
  mcpWriteQueueTimeoutMs: 30_000,
  mcpWriteNotifyOnQueue: true,

  draftingModel: 'claude-opus-4-7',
  citationPolicy: 'marked',
  draftsDefaultDestination: '10-Inbox',

  memoryEnabled: true,
  memoryMaxBytes: 50_000,

  journalEnabled: false,
  journalCascadeDays: 3,
  journalModel: 'claude-sonnet-4-6',

  chatNotesEnabled: false,

  briefingEnabled: false,
  briefingMaxItemsPerSection: 10,
  briefingLastDay: '',

  timeTravelEnabled: false,
  timeTravelRetentionDays: 365,
  timeTravelSnapshots: [],

  draftSuggestionMinNotes: 5,

  curatorEnabled: false,
  curatorMaxPerSweep: 20,
  curatorStaleNoteThresholdDays: 90,
  curatorEnabledRules: {},
  curatorFolderSchemas: {},
  curatorSweepIntervalDays: 0,
};
