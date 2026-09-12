import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';
import { Ajv, type ValidateFunction } from 'ajv';
import { Ajv2020 } from 'ajv/dist/2020.js';

type Obj = Record<string, any>;
const object = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);
class RequestError extends Error {}
export interface ClaudeOptions {
  workspace: string; model: string; binary?: string; binaryArgs?: string[]; timeoutMs?: number;
}

// The caller owns history and executes functions. Never share Claude resume state or
// expose the host's tools to API requests. JSON transcripts preserve tool call/result IDs;
// images use native content blocks. Function decisions use CLI structured output.
export function prepareClaudeRequest(body: Obj, defaultModel: string) {
  if (!object(body) || !Array.isArray(body.messages) || !body.messages.length) throw new RequestError('messages must be a non-empty array');
  const model = body.model ?? defaultModel;
  if (typeof model !== 'string' || !/^claude-[a-zA-Z0-9._-]+$/.test(model)) throw new RequestError('model must be a Claude model identifier');
  if (body.stream !== undefined && typeof body.stream !== 'boolean') throw new RequestError('stream must be boolean');
  const tools = body.tools ?? [];
  if (!Array.isArray(tools) || tools.length > 128) throw new RequestError('tools must contain at most 128 functions');
  const names = new Set<string>();
  for (const t of tools) {
    if (!object(t) || t.type !== 'function' || !object(t.function) || typeof t.function.name !== 'string' ||
        !/^[a-zA-Z0-9_-]{1,64}$/.test(t.function.name) || names.has(t.function.name) ||
        (t.function.parameters !== undefined && !object(t.function.parameters))) throw new RequestError('Invalid or duplicate function definition');
    names.add(t.function.name);
  }
  const choice = body.tool_choice ?? 'auto';
  const forcedName = object(choice) && choice.type === 'function' && object(choice.function) ? choice.function.name : undefined;
  if (!['auto', 'none', 'required'].includes(choice) && !(typeof forcedName === 'string' && names.has(forcedName))) throw new RequestError('Unsupported tool_choice');
  if (choice === 'required' && !tools.length) throw new RequestError('tool_choice required needs tools');
  const selected = choice === 'none' ? [] : tools.filter((t: Obj) => !forcedName || t.function.name === forcedName);
  const validators = new Map<string, ValidateFunction>();
  for (const t of selected) {
    const parameters = t.function.parameters ?? { type: 'object' };
    try {
      const Validator = parameters.$schema?.includes('2020-12') ? Ajv2020 : Ajv;
      const validate = new Validator({ strict: false, logger: false }).compile(parameters);
      if ('$async' in validate && validate.$async) throw new RequestError('Async schemas are unsupported');
      validators.set(t.function.name, validate);
    } catch { throw new RequestError('Unsupported function parameter schema'); }
  }
  const system: string[] = [], transcript: Obj[] = [], images: Obj[] = [];
  for (const msg of body.messages) {
    if (!object(msg) || !['system', 'developer', 'user', 'assistant', 'tool'].includes(msg.role)) throw new RequestError('Unsupported message role');
    if (msg.role === 'system' || msg.role === 'developer') {
      if (typeof msg.content !== 'string') throw new RequestError('System content must be text');
      system.push(msg.content); continue;
    }
    let content = msg.content;
    if (Array.isArray(content)) {
      content = content.map((part: unknown) => {
        if (object(part) && part.type === 'text' && typeof part.text === 'string') return part;
        if (object(part) && part.type === 'image_url' && object(part.image_url) && typeof part.image_url.url === 'string') {
          const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(part.image_url.url);
          if (!match) throw new RequestError('Images must be base64 PNG, JPEG, GIF, or WebP data URLs');
          images.push({ type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } });
          return { type: 'text', text: `[Attached image ${images.length}]` };
        }
        throw new RequestError('Unsupported message content part');
      });
    } else if (content !== null && typeof content !== 'string') throw new RequestError('Message content must be text, content parts, or null');
    const entry: Obj = { role: msg.role, content };
    if (msg.role === 'assistant' && msg.tool_calls !== undefined) {
      if (!Array.isArray(msg.tool_calls)) throw new RequestError('tool_calls must be an array');
      entry.tool_calls = msg.tool_calls;
    }
    if (msg.role === 'tool') {
      if (typeof msg.tool_call_id !== 'string') throw new RequestError('Tool results need tool_call_id');
      entry.tool_call_id = msg.tool_call_id;
    }
    transcript.push(entry);
  }
  if (!transcript.length) throw new RequestError('At least one non-system message is required');
  let schema: Obj | undefined;
  if (selected.length) {
    schema = { type: 'object', additionalProperties: false, required: ['content', 'tool_calls'], properties: {
      content: { type: 'string' }, tool_calls: { type: 'array', minItems: choice === 'required' || forcedName ? 1 : 0,
        items: { type: 'object', additionalProperties: false, required: ['name', 'arguments_json'],
          properties: { name: { type: 'string', enum: selected.map((t: Obj) => t.function.name) }, arguments_json: { type: 'string' } },
        },
      },
    } };
    system.push('TRANSPORT ADAPTER: You are the inference backend of an OpenAI-compatible chat API. Continue the supplied conversation, preserving its roles and tool results. The application instructions above govern the assistant content, NOT the transport envelope. Your final response must be delivered using StructuredOutput with top-level content and tool_calls. NEVER put a serialized transport envelope or function call in content. The external application executes functions: select them by putting their name and serialized JSON object arguments_json in the TOP-LEVEL tool_calls array of StructuredOutput; arguments must satisfy the parameter schema. These are virtual external functions, so do not try to execute them using CLI tools. If the application instructions say to search or call a tool, return that selection now. For a final answer or exact marker, put ONLY that answer or marker in content and return tool_calls: []. StructuredOutput is the internal transport formatter, not an application function. Available external functions:\n' + JSON.stringify(selected));
    if (forcedName || choice === 'required') system.push('You must return at least one requested function call this turn.');
    if (body.parallel_tool_calls === false) system.push('Return at most one function call this turn.');
  } else system.push('Continue the supplied conversation as the assistant. The transcript contains conversation history, including tool results supplied by the caller. Respond to the latest turn. Do not invent or execute tool calls.');
  const args = ['-p', '--model', model, '--input-format', 'stream-json', '--output-format', 'stream-json',
    '--verbose', '--include-partial-messages', '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    '--setting-sources', '', '--settings', '{"disableAllHooks":true}', '--disable-slash-commands', '--no-session-persistence',
    '--system-prompt', system.join('\n\n')];
  if (schema) args.push('--json-schema', JSON.stringify(schema));
  if (args.some(value => value.includes('\0') || Buffer.byteLength(value) > 120_000)) {
    throw new RequestError('System prompt or tool definitions exceed CLI argument limits');
  }
  const input = JSON.stringify({ type: 'user', message: { role: 'user', content: [
    { type: 'text', text: 'Conversation transcript (JSON):\n' + JSON.stringify(transcript) },
    ...images.flatMap((image, index) => [{ type: 'text', text: `Attached image ${index + 1}:` }, image]),
  ] } }) + '\n';
  return { args, input, model, structured: !!schema, validators, required: choice === 'required' || !!forcedName, parallel: body.parallel_tool_calls !== false };
}

export function createClaudeChatHandler(options: ClaudeOptions): RequestHandler {
  let active = 0;
  return (req, res) => {
    let prepared: ReturnType<typeof prepareClaudeRequest>;
    try { prepared = prepareClaudeRequest(req.body, options.model); }
    catch (error) { res.status(400).json({ error: { message: (error as Error).message, type: 'invalid_request_error' } }); return; }
    if (active >= 4) {
      res.setHeader('Retry-After', '2');
      res.status(429).json({ error: { message: 'Claude concurrency limit reached', type: 'rate_limit_error' } });
      return;
    }
    active++;
    const envelope = { id: `chatcmpl-${randomUUID()}`, created: Math.floor(Date.now() / 1000), model: prepared.model };
    const streaming = req.body.stream === true;
    const child = spawn(options.binary ?? 'claude', [...(options.binaryArgs ?? []), ...prepared.args], {
      cwd: options.workspace, stdio: ['pipe', 'pipe', 'pipe'], shell: false,
      detached: process.platform !== 'win32', env: { ...process.env, CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' },
    });
    const lines = createInterface({ input: child.stdout });
    let settled = false, result: Obj | undefined, text = '', partialText = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const kill = (signal: NodeJS.Signals) => {
        try {
          if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
          else child.kill(signal);
        } catch { /* Already exited. */ }
      };
      kill('SIGTERM');
      killTimer ??= setTimeout(() => kill('SIGKILL'), 2000); killTimer.unref();
    };
    const chunk = (delta: Obj, finish_reason: string | null = null) => {
      if (!res.headersSent) res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write(`data: ${JSON.stringify({ ...envelope, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    };
    const fail = (message: string, status = 502) => {
      if (settled) return;
      settled = true; clearTimeout(timer); stop();
      const error = { message, type: 'upstream_error' };
      if (res.headersSent) { res.write(`data: ${JSON.stringify({ error })}\n\n`); res.end(); }
      else res.status(status).json({ error });
    };
    const timer = setTimeout(() => fail('Claude request timed out', 504), options.timeoutMs ?? 300_000);
    res.on('close', () => { if (!settled) { settled = true; clearTimeout(timer); stop(); } });
    // Never log prompts, returned documents, stderr, or credentials.
    child.stderr.resume();
    child.stdin.on('error', () => fail('Claude input pipe failed'));
    child.on('error', () => fail('Unable to start Claude'));
    lines.on('line', (line) => {
      if (settled) return;
      let event: Obj;
      try { event = JSON.parse(line); } catch { fail('Invalid Claude event'); return; }
      if (!object(event)) { fail('Invalid Claude event'); return; }
      if (event.type === 'result') { result = event; return; }
      if (event.type === 'error') { fail('Claude returned an error'); return; }
      if (prepared.structured) return;
      if (event.type === 'stream_event' && event.event?.type === 'content_block_delta' && event.event.delta?.type === 'text_delta') {
        partialText = true; const delta = event.event.delta.text; text += delta;
        if (streaming) chunk({ content: delta });
      } else if (event.type === 'assistant' && !partialText) {
        const delta = (event.message?.content ?? []).filter((c: Obj) => c.type === 'text').map((c: Obj) => c.text).join('');
        text += delta; if (streaming && delta) chunk({ content: delta });
      }
    });
    child.on('close', (code) => {
      active--;
      if (killTimer) clearTimeout(killTimer); lines.close();
      if (settled) return;
      if (code !== 0 || !result || result.is_error || result.subtype !== 'success') { fail('Claude did not complete the request'); return; }
      let calls: Obj[] = [];
      if (prepared.structured) {
        const output = result.structured_output;
        if (!object(output) || typeof output.content !== 'string' || !Array.isArray(output.tool_calls) ||
            (prepared.required && !output.tool_calls.length) || (!prepared.parallel && output.tool_calls.length > 1) ||
            output.tool_calls.some((c: unknown) => {
              if (!object(c) || !prepared.validators.has(c.name) || typeof c.arguments_json !== 'string') return true;
              try { const args = JSON.parse(c.arguments_json); return !object(args) || !prepared.validators.get(c.name)!(args); }
              catch { return true; }
            })) {
          fail('Claude returned invalid structured output'); return;
        }
        text = output.content;
        calls = output.tool_calls.map((c: Obj) => ({ id: `call_${randomUUID()}`, type: 'function', function: { name: c.name, arguments: c.arguments_json } }));
      }
      const usage = result.usage ?? {};
      const prompt_tokens = (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
      const completion_tokens = usage.output_tokens ?? 0;
      const wireUsage = { prompt_tokens, completion_tokens, total_tokens: prompt_tokens + completion_tokens };
      const finish = calls.length ? 'tool_calls' : 'stop';
      settled = true; clearTimeout(timer);
      if (streaming) {
        if (prepared.structured && text) chunk({ content: text });
        if (calls.length) chunk({ tool_calls: calls.map((c, index) => ({ index, ...c })) });
        chunk({}, finish);
        if (req.body.stream_options?.include_usage) res.write(`data: ${JSON.stringify({ ...envelope, object: 'chat.completion.chunk', choices: [], usage: wireUsage })}\n\n`);
        res.end('data: [DONE]\n\n');
      } else res.json({ ...envelope, object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: text || null, ...(calls.length ? { tool_calls: calls } : {}) }, finish_reason: finish }], usage: wireUsage });
    });
    child.stdin.end(prepared.input);
  };
}
