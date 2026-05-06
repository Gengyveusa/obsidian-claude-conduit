# SDK migration notes — `@anthropic-ai/sdk` 0.32 → 0.95

> Companion to [`05_CONDUIT_AGENT_SKETCH.md`](05_CONDUIT_AGENT_SKETCH.md). The agent sketch was written against SDK 0.32; the scaffold pins 0.95 (the latest in the major-zero line at scaffold time). Three import-path patches required when `ConduitAgent.ts` lands.

## Verified against `@anthropic-ai/sdk@0.95.0` (locked in `package-lock.json`)

### 1. Default `Anthropic` import — unchanged

```typescript
import Anthropic from '@anthropic-ai/sdk';
const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
```

Still the canonical entry; `client.messages.create(...)` still works.

### 2. Type imports — module path unchanged, **namespace access removed**

The agent sketch's import is correct as-written:

```typescript
import type {
  Message,
  MessageParam,
  TextBlock,
  ToolUseBlock,
  ToolResultBlockParam,
} from '@anthropic-ai/sdk/resources/messages';
```

But the sketch also uses `Anthropic.MessageCreateParams["system"]` as a type expression. **This no longer compiles in 0.95** — the `Anthropic` default export is a class, not a namespace, and there's no namespace merge for nested types.

**Patch when `ConduitAgent.ts` lands:**

```diff
- import Anthropic from '@anthropic-ai/sdk';
+ import Anthropic from '@anthropic-ai/sdk';
+ import type { MessageCreateParams } from '@anthropic-ai/sdk/resources/messages';

  // ...

- private async callModel(
-   system: Anthropic.MessageCreateParams['system'],
+ private async callModel(
+   system: MessageCreateParams['system'],
    messages: MessageParam[],
  ): Promise<Message> {
```

And in `buildSystemPrompt`:

```diff
- ): Promise<Anthropic.MessageCreateParams['system']> {
+ ): Promise<MessageCreateParams['system']> {
```

### 3. `Anthropic.APIError` namespace access — removed

The sketch's overload check uses `err instanceof Anthropic.APIError`. **This no longer compiles in 0.95** — `APIError` is a top-level named export now.

**Patch:**

```diff
  import Anthropic from '@anthropic-ai/sdk';
+ import { APIError } from '@anthropic-ai/sdk';

  // ...

  private isOverloaded(err: unknown): boolean {
-   if (err instanceof Anthropic.APIError) {
+   if (err instanceof APIError) {
      return err.status === 503 || err.status === 529;
    }
    return false;
  }
```

## What's the same

- `client.messages.create({ model, max_tokens, system, tools, messages })` — same shape.
- `Message`, `MessageParam`, `TextBlock`, `ToolUseBlock`, `ToolResultBlockParam` — all still live at `@anthropic-ai/sdk/resources/messages`.
- `cache_control: { type: 'ephemeral' }` on system blocks — still works (the typed structure is `CacheControlEphemeral`).
- `dangerouslyAllowBrowser: true` — still required inside Obsidian's renderer process.

## What's new in 0.95 worth knowing

The minor-version drift from 0.32 → 0.95 reflects a lot of feature surface added that v0.1 doesn't use yet. Worth tracking for later phases:

- **Streaming has matured.** `client.messages.stream(...)` now returns a `MessageStream` with typed event handlers (`text`, `inputJson`, `toolUse`, `error`, `end`). Cleaner than the 0.32 raw-event model. → Phase 3 streaming wire-up.
- **Citations API.** Native server-side citation block types (`CitationCharLocation`, `CitationPageLocationParam`, etc.). v0.1 builds citations client-side from `search_vault` results — no overlap, but watch this space if Anthropic adds vault-context-style citations server-side.
- **Code execution + bash + text-editor server tools** are now first-class types. Out of scope for Sagittarius (we own the tool surface client-side per spec §4).
- **Thinking blocks.** `ThinkingBlock`, `ThinkingConfigEnabled` — extended thinking is opt-in via `thinking: { type: 'enabled', budget_tokens: ... }`. Not used in v0.1; consider for v0.5+ design sessions inside the agent loop.
- **Memory tool.** `MemoryTool20250818` — server-side memory primitive. Sagittarius's memory layer is Phase 9 per ADR-010; no overlap yet.

## Action items

When Phase 3b begins (the ConduitAgent implementation):

1. Apply patches 2 + 3 above to the implementation.
2. Verify the `system` array shape (`{ type: 'text', text, cache_control? }[]`) still types-check against `MessageCreateParams['system']`. Likely fine; flag if not.
3. Decide whether to use the new `client.messages.stream()` directly or wrap it.
4. Update [`05_CONDUIT_AGENT_SKETCH.md`](05_CONDUIT_AGENT_SKETCH.md) with the patched imports, or replace it entirely once the real `ConduitAgent.ts` exists.
