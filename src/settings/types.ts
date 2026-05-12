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
};
