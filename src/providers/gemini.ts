import type { NdjsonEvent, NormalizedEventType } from '../types.js';
import type { ProviderConfig } from './base.js';

/**
 * Gemini CLI provider configuration.
 *
 * Mode: per-request with stdin pipe and --resume chaining.
 *
 * Actual Gemini stream-json events (discovered via testing):
 *   - "init"    — session init with session_id, model
 *   - "message" — role:"user" (echo, skip) and role:"assistant" (response)
 *   - "result"  — completion with status and stats
 *
 * Session ID comes from the "init" event for --resume chaining.
 */
export const geminiProvider: ProviderConfig = {
  binary: 'gemini',
  displayName: 'Gemini CLI',
  defaultModel: 'gemini-3.1-flash',
  models: [
    'gemini-3.1-flash',
    'gemini-3.1-pro',
    'gemini-2.5-flash',
    'gemini-2.5-pro',
  ],
  mode: 'per-request',
  emitsInit: false,
  usesStdinPipe: true,

  buildSpawnArgs(resumeSessionId: string, model?: string): string[] {
    const args = [
      '--output-format', 'stream-json',
    ];
    if (model) {
      args.push('--model', model);
    }
    if (resumeSessionId) {
      args.push('--resume', resumeSessionId);
    }
    return args;
  },

  buildStdinMessage(content: string): string {
    return content;
  },

  normalizeEventType(rawType: string): NormalizedEventType {
    if (rawType === 'message') return 'text_delta';
    if (rawType === 'init') return 'init';
    if (rawType === 'result') return 'result';
    if (rawType === 'error') return 'error';
    if (rawType === 'tool_use') return 'tool_use';
    if (rawType === 'tool_result') return 'tool_result';
    if (rawType === 'api_retry') return 'unknown';
    return 'unknown';
  },

  extractTextContent(event: NdjsonEvent): string {
    const e = event as Record<string, unknown>;
    // Skip user message echo — only extract assistant responses
    if ((e.role as string) === 'user') return '';
    return (e.content as string) || (e.text as string) || '';
  },

  extractSessionId(event: NdjsonEvent): string | null {
    const e = event as Record<string, unknown>;
    // Gemini's "init" event contains session_id
    if (e.type === 'init' && e.session_id) {
      return e.session_id as string;
    }
    return null;
  },
};
