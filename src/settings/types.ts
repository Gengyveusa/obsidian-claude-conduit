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
};
