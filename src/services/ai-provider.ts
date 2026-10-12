/**
 * Streaming client for any OpenAI-compatible chat-completions API.
 * Defaults to DeepSeek (deepseek-flash = DeepSeek V4.1 Flash); point
 * AI_BASE_URL / AI_MODEL / AI_API_KEY elsewhere to switch provider.
 */

import { createLogger } from '../utils/logger.js';

const log = createLogger('ai-provider');

export interface ToolCall {
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
}

export interface ProviderMessage {
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string | null;
    tool_calls?: ToolCall[];
    tool_call_id?: string;
    /** DeepSeek thinking models want this echoed back inside a tool loop */
    reasoning_content?: string;
}

export interface Usage {
    promptTokens: number;
    completionTokens: number;
    cachedTokens: number;
}

export interface StreamResult {
    content: string;
    reasoning: string;
    toolCalls: ToolCall[];
    finishReason: string | null;
    usage: Usage;
}

export interface AiConfig {
    enabled: boolean;
    baseUrl: string;
    apiKey: string;
    model: string;
    modelLabel: string;
    reasoningEffort: string;
}

export function getAiConfig(): AiConfig {
    const apiKey = (process.env.AI_API_KEY || process.env.DEEPSEEK_API_KEY || '').trim();
    return {
        enabled: Boolean(apiKey),
        baseUrl: (process.env.AI_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, ''),
        apiKey,
        model: process.env.AI_MODEL || 'deepseek-flash',
        modelLabel: process.env.AI_MODEL_LABEL || 'DeepSeek V4.1 Flash',
        // 'none' answers fastest; tools do the reasoning. 'low' / 'high' turn thinking on.
        reasoningEffort: process.env.AI_REASONING_EFFORT || 'none',
    };
}

export class ProviderError extends Error {
    constructor(
        message: string,
        public status: number,
        public retryable: boolean,
    ) {
        super(message);
        this.name = 'ProviderError';
    }
}

const FIRST_BYTE_TIMEOUT_MS = 30_000;
const TOTAL_TIMEOUT_MS = 120_000;

export async function streamChat(options: {
    messages: ProviderMessage[];
    tools?: unknown[];
    toolChoice?: 'auto' | 'none';
    maxTokens?: number;
    /** false = answer straight away without the model's thinking phase */
    thinking?: boolean;
    signal?: AbortSignal;
    onContent?: (delta: string) => void;
    onReasoning?: (delta: string) => void;
}): Promise<StreamResult> {
    const config = getAiConfig();
    if (!config.enabled) throw new ProviderError('AI is not configured on the server', 503, false);

    const timeout = new AbortController();
    const firstByteTimer = setTimeout(() => timeout.abort(new Error('first-byte timeout')), FIRST_BYTE_TIMEOUT_MS);
    const totalTimer = setTimeout(() => timeout.abort(new Error('total timeout')), TOTAL_TIMEOUT_MS);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout.signal]) : timeout.signal;

    const body: Record<string, unknown> = {
        model: config.model,
        stream: true,
        stream_options: { include_usage: true },
        max_tokens: options.maxTokens ?? 4000,
        messages: options.messages,
    };
    if (options.thinking === false || config.reasoningEffort === 'none') {
        body.thinking = { type: 'disabled' };
    } else if (config.reasoningEffort) {
        body.reasoning_effort = config.reasoningEffort;
    }
    if (options.tools?.length) {
        body.tools = options.tools;
        body.tool_choice = options.toolChoice ?? 'auto';
    }

    const result: StreamResult = {
        content: '',
        reasoning: '',
        toolCalls: [],
        finishReason: null,
        usage: { promptTokens: 0, completionTokens: 0, cachedTokens: 0 },
    };

    try {
        let response: Response;
        try {
            response = await fetch(`${config.baseUrl}/chat/completions`, {
                method: 'POST',
                signal,
                headers: {
                    'Content-Type': 'application/json',
                    Accept: 'text/event-stream',
                    Authorization: `Bearer ${config.apiKey}`,
                },
                body: JSON.stringify(body),
            });
        } catch (err) {
            if (options.signal?.aborted) throw err;
            throw new ProviderError(
                timeout.signal.aborted ? 'The AI service took too long to respond' : 'Could not reach the AI service',
                504,
                true,
            );
        }

        if (!response.ok || !response.body) {
            const text = await response.text().catch(() => '');
            log.error('AI provider request failed', { status: response.status, body: text.slice(0, 400) });
            const status = response.status;
            const message =
                status === 401 || status === 403
                    ? 'The AI key was rejected'
                    : status === 402
                      ? 'The AI account has run out of credit'
                      : status === 429
                        ? 'The AI service is busy — try again in a moment'
                        : 'The AI service could not answer right now';
            throw new ProviderError(message, status === 429 ? 429 : 502, status === 429 || status >= 500);
        }

        const toolCalls: ToolCall[] = [];
        const decoder = new TextDecoder();
        let buffer = '';
        let gotFirstByte = false;

        for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
            if (!gotFirstByte) {
                gotFirstByte = true;
                clearTimeout(firstByteTimer);
            }
            buffer += decoder.decode(chunk, { stream: true });
            let newline: number;
            while ((newline = buffer.indexOf('\n')) >= 0) {
                const line = buffer.slice(0, newline).trim();
                buffer = buffer.slice(newline + 1);
                if (!line.startsWith('data:')) continue;
                const data = line.slice(5).trim();
                if (!data || data === '[DONE]') continue;

                let event: {
                    choices?: Array<{
                        delta?: {
                            content?: string | null;
                            reasoning_content?: string | null;
                            tool_calls?: Array<{
                                index: number;
                                id?: string;
                                function?: { name?: string; arguments?: string };
                            }>;
                        };
                        finish_reason?: string | null;
                    }>;
                    usage?: {
                        prompt_tokens?: number;
                        completion_tokens?: number;
                        prompt_cache_hit_tokens?: number;
                        prompt_tokens_details?: { cached_tokens?: number };
                    } | null;
                };
                try {
                    event = JSON.parse(data);
                } catch {
                    continue;
                }

                const choice = event.choices?.[0];
                const delta = choice?.delta;
                if (delta?.reasoning_content) {
                    result.reasoning += delta.reasoning_content;
                    options.onReasoning?.(delta.reasoning_content);
                }
                if (delta?.content) {
                    result.content += delta.content;
                    options.onContent?.(delta.content);
                }
                for (const tc of delta?.tool_calls ?? []) {
                    const slot = (toolCalls[tc.index] ??= {
                        id: '',
                        type: 'function',
                        function: { name: '', arguments: '' },
                    });
                    if (tc.id) slot.id = tc.id;
                    if (tc.function?.name) slot.function.name += tc.function.name;
                    if (tc.function?.arguments) slot.function.arguments += tc.function.arguments;
                }
                if (choice?.finish_reason) result.finishReason = choice.finish_reason;
                if (event.usage) {
                    result.usage = {
                        promptTokens: event.usage.prompt_tokens ?? 0,
                        completionTokens: event.usage.completion_tokens ?? 0,
                        cachedTokens:
                            event.usage.prompt_cache_hit_tokens ??
                            event.usage.prompt_tokens_details?.cached_tokens ??
                            0,
                    };
                }
            }
        }

        result.toolCalls = toolCalls.filter((tc) => tc && tc.function.name);
        return result;
    } catch (err) {
        if (err instanceof ProviderError) throw err;
        if (options.signal?.aborted) throw err;
        if (timeout.signal.aborted) {
            throw new ProviderError('The AI service took too long to respond', 504, true);
        }
        log.error('AI stream failed', { error: err instanceof Error ? err.message : String(err) });
        throw new ProviderError('The AI answer was cut off', 502, true);
    } finally {
        clearTimeout(firstByteTimer);
        clearTimeout(totalTimer);
    }
}

/** One short non-streaming completion (used for chat titles). */
export async function completeOnce(messages: ProviderMessage[], maxTokens = 60): Promise<string> {
    let text = '';
    await streamChat({ messages, maxTokens, thinking: false, onContent: (d) => (text += d) });
    return text.trim();
}
