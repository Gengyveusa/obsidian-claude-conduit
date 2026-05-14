/**
 * Plugin settings — per docs/02_SPEC.md §3.1.
 *
 * Persisted to `<vault>/.obsidian/plugins/obsidian-claude-conduit/data.json`
 * via Obsidian's plugin API (`this.loadData()` / `this.saveData()`).
 *
 * The API key field MUST never be committed to git; the plugin's data dir
 * is gitignored by default per spec §7 threat model.
 */
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
   * SHA-256 hex hash of the bearer token. Generated on first enable;
   * the raw token is shown once via "Reveal token" then re-hashed.
   * Empty string = not yet generated; server refuses to start.
   */
  mcpToken: string;
  /**
   * Optional allowlist of MCP `clientInfo.name` values. Empty = any
   * authenticated client may connect. Use to restrict the bridge to
   * a specific external app (e.g. `['claude-desktop']`).
   */
  mcpAllowedClients: string[];

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
  mcpAllowedClients: [],

  curatorEnabled: false,
  curatorMaxPerSweep: 20,
  curatorStaleNoteThresholdDays: 90,
  curatorEnabledRules: {},
};
