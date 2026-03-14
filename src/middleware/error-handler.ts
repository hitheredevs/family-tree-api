import type { Request, Response, NextFunction } from 'express';
import { AppError } from '../types/index.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('error-handler');

/**
 * Global Express error handler.
 * Catches AppError instances and unknown errors.
 */
export function errorHandler(
    err: Error,
    _req: Request,
    res: Response,
    _next: NextFunction,
): void {
    if (err instanceof AppError) {
        log.warn('AppError', {
            statusCode: err.statusCode,
            code: err.code,
            message: err.message,
            path: _req.path,
            method: _req.method,
        });
        res.status(err.statusCode).json({
            error: err.message,
            code: err.code,
        });
        return;
    }

    log.error('Unhandled error', {
        message: err.message,
        stack: err.stack,
        path: _req.path,
        method: _req.method,
    });
    res.status(500).json({
        error: 'Internal server error',
        code: 'ERR_INTERNAL',
    });
}
