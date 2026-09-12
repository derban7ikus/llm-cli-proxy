import express, { type Request, type Response } from 'express';
import { createClaudeChatHandler } from './claude-chat.js';
import { randomUUID } from 'node:crypto';
import { RequestPacer } from './request-pacer.js';
import {
  toOpenAIResponse,
  toOpenAIStreamChunk,
} from './openai-adapter.js';
import type { ISession, OpenAIMessage } from './types.js';

// ── Proxy Server ────────────────────────────────────────────────────

/**
 * Creates and returns an Express server that serves an OpenAI-compatible
 * API backed by a CLI session manager.
 *
 * Endpoints:
 * - POST /v1/chat/completions — chat completion (streaming + non-streaming)
 * - GET  /v1/models           — list available models
 * - GET  /health              — session health check
 */
export function createServer(
  session: ISession,
  workspace: string,
): express.Application {
  const app = express();
  const pacer = new RequestPacer();

  // Middleware
  app.use(express.json({ limit: '10mb' }));

  // CORS
  app.use((_req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (_req.method === 'OPTIONS') {
      res.sendStatus(204);
      return;
    }
    next();
  });

  // Request logging
  app.use((req, _res, next) => {
    console.log(`[http] ${req.method} ${req.path}`);
    next();
  });

  // ── POST /v1/chat/completions ───────────────────────────────────

  if (session.getProvider().binary === 'claude') {
    app.post('/v1/chat/completions', createClaudeChatHandler({ workspace, model: session.getModel() }));
  }
  app.post('/v1/chat/completions', async (req: Request, res: Response) => {
    try {
      const { messages, stream, model: requestedModel } = req.body as {
        messages?: OpenAIMessage[];
        stream?: boolean;
        model?: string;
      };

      if (!messages || !Array.isArray(messages) || messages.length === 0) {
        res.status(400).json({
          error: {
            message: 'messages array is required and must not be empty',
            type: 'invalid_request_error',
            code: 'invalid_messages',
          },
        });
        return;
      }

      // F7: Per-message content size guard (500KB max per message)
      const MAX_MESSAGE_BYTES = 512_000;
      for (const msg of messages) {
        if (msg.content && msg.content.length > MAX_MESSAGE_BYTES) {
          res.status(400).json({
            error: {
              message: `Message content exceeds maximum size (${MAX_MESSAGE_BYTES} bytes)`,
              type: 'invalid_request_error',
              code: 'content_too_large',
            },
          });
          return;
        }
      }

      if (!session.isAlive()) {
        res.status(503).json({
          error: {
            message: `${session.getProvider().displayName} session is not active. Check /health for details.`,
            type: 'server_error',
            code: 'session_unavailable',
          },
        });
        return;
      }

      // Pace the request
      await pacer.pace();

      const model = requestedModel || session.getModel();

      if (stream) {
        // ── SSE Streaming ─────────────────────────────────────────
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no',
        });

        const chunkId = `chatcmpl-${randomUUID()}`;

        try {
          await session.sendMessageStreaming(messages, (event) => {
            const chunk = toOpenAIStreamChunk(
              event,
              model,
              session.getProvider(),
              chunkId,
            );
            if (chunk) {
              res.write(`data: ${JSON.stringify(chunk)}\n\n`);
            }
          }, requestedModel);
        } catch (err) {
          // Write error as SSE event
          const errorChunk = {
            id: chunkId,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [{
              index: 0,
              delta: { content: `\n\n[Error: ${(err as Error).message}]` },
              finish_reason: 'stop',
            }],
          };
          res.write(`data: ${JSON.stringify(errorChunk)}\n\n`);
        }

        res.write('data: [DONE]\n\n');
        res.end();
      } else {
        // ── Non-streaming ─────────────────────────────────────────
        const response = await session.sendMessage(messages, requestedModel);
        const openaiResponse = toOpenAIResponse(response, model);
        res.json(openaiResponse);
      }
    } catch (err) {
      console.error('[http] Chat completion error:', (err as Error).message);
      res.status(500).json({
        error: {
          message: (err as Error).message,
          type: 'server_error',
          code: 'internal_error',
        },
      });
    }
  });

  // ── GET /v1/models ──────────────────────────────────────────────

  app.get('/v1/models', (_req: Request, res: Response) => {
    const provider = session.getProvider();
    const models = provider.models.map((id) => ({
      id,
      object: 'model' as const,
      created: Math.floor(Date.now() / 1000),
      owned_by: provider.displayName.toLowerCase().replace(/\s+/g, '-'),
    }));

    res.json({
      object: 'list',
      data: models,
    });
  });

  // ── GET /health ─────────────────────────────────────────────────

  app.get('/health', (_req: Request, res: Response) => {
    const provider = session.getProvider();
    res.json({
      status: session.isAlive() ? 'ok' : 'degraded',
      provider: provider.displayName,
      provider_key: provider.binary,
      session_active: session.isAlive(),
      session_id: session.getSessionId(),
      resume_session_id: session.getResumeSessionId() || null,
      model: session.getModel(),
      workspace,
    });
  });

  // ── 404 catch-all ───────────────────────────────────────────────

  app.use((_req: Request, res: Response) => {
    res.status(404).json({
      error: {
        message: `Unknown endpoint: ${_req.method} ${_req.path}`,
        type: 'invalid_request_error',
        code: 'unknown_endpoint',
      },
    });
  });

  return app;
}
