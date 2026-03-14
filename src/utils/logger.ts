/**
 * Lightweight structured logger for production debugging.
 */

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

function formatMessage(level: LogLevel, context: string, message: string, meta?: Record<string, unknown>): string {
    const ts = new Date().toISOString();
    const metaStr = meta && Object.keys(meta).length > 0
        ? ' ' + JSON.stringify(meta)
        : '';
    return `[${ts}] ${level.toUpperCase()} [${context}] ${message}${metaStr}`;
}

export function createLogger(context: string) {
    return {
        debug(message: string, meta?: Record<string, unknown>) {
            console.debug(formatMessage('debug', context, message, meta));
        },
        info(message: string, meta?: Record<string, unknown>) {
            console.log(formatMessage('info', context, message, meta));
        },
        warn(message: string, meta?: Record<string, unknown>) {
            console.warn(formatMessage('warn', context, message, meta));
        },
        error(message: string, meta?: Record<string, unknown>) {
            console.error(formatMessage('error', context, message, meta));
        },
    };
}
