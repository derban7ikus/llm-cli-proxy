import type { NdjsonEvent, NormalizedEventType } from '../types.js';
import type { ProviderConfig } from './base.js';

/**
 * OpenAI Codex CLI provider configuration.
 *
 * Mode: per-request with stdin pipe.
 * `echo "prompt" | codex exec --json -`
 *
 * Actual Codex JSONL events (discovered via testing):
 *   - "thread.started"  — contains thread_id (session ID for resume)
 *   - "turn.started"    — turn begins
 *   - "item.completed"  — response with item.text containing the message
 *   - "turn.completed"  — completion with usage stats (input_tokens, output_tokens)
 *
 * Text content path: event.item.text (in item.completed events)
 * Session ID path: event.thread_id (in thread.started events)
 */
export const codexProvider: ProviderConfig = {
  binary: 'codex',
  displayName: 'Codex CLI',
  defaultModel: 'gpt-5.4',
  models: [
    'gpt-5.4',
    'gpt-5.4-pro',
  ],
  mode: 'per-request',
  emitsInit: false,
  usesStdinPipe: true,

  buildSpawnArgs(resumeSessionId: string, model?: string): string[] {
    if (resumeSessionId) {
      const args = [
        'exec', 'resume',
        '--last',
        '--json',
      ];
      if (model) {
        args.push('-m', model);
      }
      return args;
    }
    const args = [
      'exec',
      '--json',
      '-',  // Read prompt from stdin
    ];
    if (model) {
      args.push('-m', model);
    }
    return args;
  },

  buildStdinMessage(content: string): string {
    return content;
  },

  normalizeEventType(rawType: string): NormalizedEventType {
    // CodexDirectSession streaming emits {type:'text_delta', content: delta}
    if (rawType === 'text_delta') return 'text_delta';
    // Codex JSONL event types (verified via testing)
    if (rawType === 'item.completed') return 'text_delta';     // Contains item.text
    if (rawType === 'turn.completed') return 'result';          // Completion with usage
    if (rawType === 'thread.started') return 'init';            // Session start with thread_id
    if (rawType === 'turn.started') return 'unknown';           // Informational, ignore
    if (rawType === 'error') return 'error';
    return 'unknown';
  },

  extractTextContent(event: NdjsonEvent): string {
    const e = event as Record<string, unknown>;
    // CodexDirectSession streaming emits {type:'text_delta', content: delta}
    if (typeof e.content === 'string') {
      return e.content;
    }
    // Codex item.completed: { type: "item.completed", item: { text: "..." } }
    const item = e.item as Record<string, unknown> | undefined;
    if (!item) return '';

    // Only extract agent_message items (skip tool calls, etc.)
    if (item.type && item.type !== 'agent_message') return '';

    return (item.text as string) || '';
  },

  extractSessionId(event: NdjsonEvent): string | null {
    const e = event as Record<string, unknown>;
    // Codex thread.started: { type: "thread.started", thread_id: "..." }
    if (e.type === 'thread.started' && e.thread_id) {
      return e.thread_id as string;
    }
    return null;
  },
};
