import type { Response, NextFunction } from 'express';
import type { AuthenticatedRequest } from '../types/index.js';
import { AppError } from '../types/index.js';
import { getAiConfig } from '../services/ai-provider.js';
import * as chatService from '../services/ai-chat-service.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('ai-controller');

const HEARTBEAT_MS = 15_000;

function userIdOf(req: AuthenticatedRequest): string {
    const userId = req.user?.userId;
    if (!userId) throw new AppError('Not signed in', 401, 'ERR_AUTH');
    return userId;
}

/** GET /api/ai/status — is the assistant switched on, and which model */
export function status(_req: AuthenticatedRequest, res: Response): void {
    const config = getAiConfig();
    res.json({ enabled: config.enabled, model: config.model, modelLabel: config.modelLabel });
}

/** GET /api/ai/sessions */
export async function listSessions(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
        res.json(await chatService.listSessions(userIdOf(req), Number(req.query.limit) || 100));
    } catch (err) {
        next(err);
    }
}

/** POST /api/ai/sessions  { title? } */
export async function createSession(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
        res.status(201).json(await chatService.createSession(userIdOf(req), req.body?.title));
    } catch (err) {
        next(err);
    }
}

/** GET /api/ai/sessions/:id — session + messages */
export async function getSession(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
        res.json(await chatService.getSessionWithMessages(userIdOf(req), req.params.id as string));
    } catch (err) {
        next(err);
    }
}

/** PATCH /api/ai/sessions/:id  { title?, isPinned? } */
export async function updateSession(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
        res.json(await chatService.updateSession(userIdOf(req), req.params.id as string, req.body ?? {}));
    } catch (err) {
        next(err);
    }
}

/** DELETE /api/ai/sessions/:id */
export async function deleteSession(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
        await chatService.deleteSession(userIdOf(req), req.params.id as string);
        res.json({ message: 'Chat deleted' });
    } catch (err) {
        next(err);
    }
}

/**
 * POST /api/ai/sessions/:id/messages  (id may be "new")
 * Body: { content, contextPersonIds?, regenerate? }
 *
 * Streams Server-Sent Events: ready, status, delta, discard, replace,
 * done, error. Problems found before streaming starts (bad input, rate
 * limit, busy chat) come back as a normal JSON error instead.
 */
export async function sendMessage(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    const abort = new AbortController();
    res.on('close', () => {
        if (!res.writableEnded) abort.abort();
    });

    let streaming = false;
    let heartbeat: NodeJS.Timeout | undefined;
    const emit = (event: string, data: unknown) => {
        if (res.writableEnded || abort.signal.aborted) return;
        if (!streaming) {
            streaming = true;
            res.status(200);
            res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
            res.setHeader('Cache-Control', 'no-cache, no-transform');
            res.setHeader('Connection', 'keep-alive');
            res.setHeader('X-Accel-Buffering', 'no');
            res.flushHeaders();
            heartbeat = setInterval(() => {
                if (!res.writableEnded) res.write(': ping\n\n');
            }, HEARTBEAT_MS);
        }
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    try {
        const userId = userIdOf(req);
        await chatService.runSavedTurn({
            userId,
            personId: req.user?.personId,
            sessionId: req.params.id as string,
            content: req.body?.content,
            contextPersonIds: req.body?.contextPersonIds,
            regenerate: req.body?.regenerate === true,
            signal: abort.signal,
            emit,
        });
    } catch (err) {
        if (!streaming) {
            next(err);
            return;
        }
        log.error('AI stream failed after start', { error: err instanceof Error ? err.message : String(err) });
        emit('error', {
            error: err instanceof AppError ? err.message : 'Something went wrong while answering.',
            retryable: !(err instanceof AppError),
        });
    } finally {
        if (heartbeat) clearInterval(heartbeat);
        if (streaming && !res.writableEnded) res.end();
    }
}

/**
 * POST /api/ai/chat — kept for app versions loaded before the Ask
 * redesign. Body: { messages, contextPersonIds? } → { reply }
 */
export async function chat(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    const abort = new AbortController();
    res.on('close', () => {
        if (!res.writableEnded) abort.abort();
    });
    try {
        const { messages, contextPersonIds } = req.body as {
            messages?: { role: 'user' | 'assistant'; content: string }[];
            contextPersonIds?: string[];
        };
        if (!Array.isArray(messages) || messages.length === 0) {
            res.status(400).json({ error: 'messages array is required' });
            return;
        }
        const clean = messages.filter(
            (m) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string',
        );
        const reply = await chatService.answerStateless({
            userId: req.user?.userId,
            personId: req.user?.personId,
            messages: clean,
            contextPersonIds: Array.isArray(contextPersonIds) ? contextPersonIds.map(String) : [],
            signal: abort.signal,
        });
        res.json({ reply });
    } catch (err) {
        if (abort.signal.aborted) return;
        if (err instanceof Error && err.name === 'ProviderError') {
            res.status(502).json({ error: err.message });
            return;
        }
        next(err);
    }
}
