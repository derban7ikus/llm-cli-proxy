# llm-cli-proxy

**Use your Claude, Gemini, or ChatGPT subscription from any OpenAI-compatible tool — no API keys needed.**

Wraps the official Claude Code, Gemini CLI, and Codex CLIs and exposes a local OpenAI-compatible HTTP API. Point any tool that supports `OPENAI_BASE_URL` or `ANTHROPIC_BASE_URL` at it and your subscription handles the billing.

```bash
npx llm-cli-proxy --provider claude --port 3456
```

## Prerequisites

Node.js 20+ and at least one CLI installed and authenticated:

| Provider | Subscription | Install | Authenticate |
|----------|-------------|---------|-------------|
| Claude | Claude Pro or Max | `npm install -g @anthropic-ai/claude-code` | Run `claude` and sign in |
| Gemini | Gemini Advanced (Google One AI Premium) | `npm install -g @google/gemini-cli` | Run `gemini` and sign in |
| Codex | ChatGPT Plus, Pro, or Team | `npm install -g @openai/codex` | Run `codex` and sign in |

## Installation

```bash
npm install -g llm-cli-proxy
```

Or use without installing:

```bash
npx llm-cli-proxy --provider claude
```

## Usage

Start one instance per provider you want to use:

```bash
llm-cli-proxy --provider claude   # listens on port 3456
llm-cli-proxy --provider gemini   # listens on port 3457
llm-cli-proxy --provider codex    # listens on port 3458
```

Then point your tool at the local URL:

```bash
# For tools using the Anthropic SDK
export ANTHROPIC_BASE_URL=http://localhost:3456/v1

# For tools using the Google Gemini SDK
export GOOGLE_GEMINI_BASE_URL=http://localhost:3457/v1

# For tools using the OpenAI SDK
export OPENAI_BASE_URL=http://localhost:3458/v1
```

> Some SDKs will refuse to initialize without an API key env var set. If you hit that, set it to any non-empty string — the proxy ignores it.

### Options

```
llm-cli-proxy --provider <claude|gemini|codex> [options]

  --provider, -p  <name>   Provider: claude, gemini, or codex (required)
  --port          <port>   HTTP port (default: 3456/claude, 3457/gemini, 3458/codex)
  --workspace, -w <dir>    Working directory for the CLI (default: current directory)
  --model, -m     <model>  Model override
  --version, -V            Show version
  --help, -h               Show help
```

## API

### POST /v1/chat/completions

```bash
# Non-streaming
curl http://localhost:3456/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-sonnet-4-6","messages":[{"role":"user","content":"Hello"}]}'

# Streaming
curl http://localhost:3456/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-sonnet-4-6","messages":[{"role":"user","content":"Hello"}],"stream":true}'
```

### GET /v1/models

Returns available models for the running provider.

### GET /health

```json
{
  "status": "ok",
  "provider": "Claude Code",
  "session_active": true,
  "model": "claude-sonnet-4-6",
  "workspace": "/your/project"
}
```

## Models

| Provider | Default | Available |
|----------|---------|-----------|
| Claude | `claude-sonnet-4-6` | `claude-sonnet-4-6`, `claude-opus-4-6` |
| Gemini | `gemini-2.5-flash` | `gemini-2.5-flash`, `gemini-2.5-pro` |
| Codex | `codex-mini-latest` | `codex-mini-latest` |

## How It Works

- **Claude & Gemini** — spawns the official CLI per request using `--resume` to maintain conversation context. The CLI handles authentication automatically.
- **Codex** — calls the Codex API endpoint directly using the OAuth token stored by the Codex CLI. This avoids a [known bug](https://github.com/openai/codex/issues/16213) in `exec resume` that causes the system prompt to be re-injected on every turn, multiplying token usage.

## License

MIT

### Claude OpenAI compatibility (v1.0.3)

The Claude route is stateless: every request runs a fresh CLI invocation and uses
only the supplied messages. It no longer resumes a shared conversation. The CLI
has built-in tools, external MCP servers, hooks, skills and session persistence
disabled; API functions are always executed by the calling application.

- Text-only requests stream native text deltas without duplicating complete messages.
- `tools` uses Claude CLI structured output to choose external functions, then maps
  the validated result to OpenAI `tool_calls`. Arguments are checked against the
  original JSON Schema (draft-07 or 2020-12). Tool-bearing responses are buffered
  until complete, then emitted as standard SSE chunks; argument streaming is not incremental.
- `tool_choice` supports `auto`, `none`, `required`, and a named function.
  `parallel_tool_calls: false` allows at most one function call.
- Supplied assistant calls and tool results retain their IDs in a JSON conversation
  transcript. This is a transcript adapter, not native Claude message-history injection.
- Images must be PNG/JPEG/GIF/WebP base64 data URLs and are sent as native image
  blocks with stable labels. Remote image URLs return 400; the HTTP body limit is 10 MB.
- Upstream failure, missing structured output, invalid arguments and timeouts fail
  explicitly. A failed SSE stream never ends with a successful `stop` reason.
  Disconnects terminate the CLI process group; a maximum of four calls run at once.

Open WebUI can expose this bridge as `http://claude-bridge:3456/v1`; clients of
Open WebUI use `http://<openwebui-host>:3018/api` and model `claude-sonnet-5`.
HR Helper requires both function calls and image support for search and scanned PDFs.
Embeddings are a separate Open WebUI connection to an embedding-capable provider.

Run `npm test` for HTTP/protocol tests with a fake CLI (no credentials required).
Live acceptance should also cover function call -> result -> answer, image
transcription, and a fresh request that cannot recall the preceding conversation.
