import type { NextFunction, Request, Response } from 'express';
import * as authService from '../services/auth-service.js';
import type { AuthenticatedRequest } from '../types/index.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('auth-controller');

export async function login(
    req: Request,
    res: Response,
    next: NextFunction,
): Promise<void> {
    try {
        const { username, password } = req.body;
        log.info('Login attempt', { username, ip: req.ip });

        if (!username || !password) {
            log.warn('Login failed: missing credentials', { username });
            res.status(400).json({ error: 'Username and password are required' });
            return;
        }

        const result = await authService.login(username, password);
        log.info('Login successful', { username, userId: result.user.id });
        res.json(result);
    } catch (err) {
        log.error('Login failed', {
            username: req.body?.username,
            error: err instanceof Error ? err.message : String(err),
        });
        next(err);
    }
}

export async function getMe(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
): Promise<void> {
    try {
        if (!req.user) {
            log.warn('getMe called without authenticated user');
            res.status(401).json({ error: 'Not authenticated' });
            return;
        }

        log.info('Fetching current user', { userId: req.user.userId });
        const user = await authService.getCurrentUser(req.user.userId);
        log.info('Current user fetched', { userId: req.user.userId, username: user.username });
        res.json(user);
    } catch (err) {
        log.error('getMe failed', {
            userId: req.user?.userId,
            error: err instanceof Error ? err.message : String(err),
        });
        next(err);
    }
}

export function logout(
    _req: Request,
    res: Response,
): void {
    // Stateless JWT — client simply discards the token.
    // This endpoint exists for API completeness.
    res.json({ message: 'Logged out successfully' });
}

export async function changePassword(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
): Promise<void> {
    try {
        if (!req.user) {
            res.status(401).json({ error: 'Not authenticated' });
            return;
        }

        const { currentPassword, newPassword } = req.body;
        log.info('Password change attempt', { userId: req.user.userId });

        if (!currentPassword || !newPassword) {
            log.warn('Password change failed: missing fields', { userId: req.user.userId });
            res.status(400).json({ error: 'Current password and new password are required' });
            return;
        }

        await authService.changePassword(req.user.userId, currentPassword, newPassword);
        log.info('Password changed successfully', { userId: req.user.userId });
        res.json({ message: 'Password changed successfully' });
    } catch (err) {
        log.error('Password change failed', {
            userId: req.user?.userId,
            error: err instanceof Error ? err.message : String(err),
        });
        next(err);
    }
}

export async function getPasswordLinkDetails(
    req: Request,
    res: Response,
    next: NextFunction,
): Promise<void> {
    try {
        const token = String(req.query.token ?? '');
        if (!token) {
            res.status(400).json({ error: 'Password link token is required' });
            return;
        }

        const result = await authService.getPasswordLinkDetails(token);
        res.json(result);
    } catch (err) {
        log.error('Get password link details failed', {
            error: err instanceof Error ? err.message : String(err),
        });
        next(err);
    }
}

export async function consumePasswordLink(
    req: Request,
    res: Response,
    next: NextFunction,
): Promise<void> {
    try {
        const { token, newPassword, phoneNumber } = req.body as {
            token?: string;
            newPassword?: string;
            phoneNumber?: string;
        };

        const result = await authService.consumePasswordLink(
            token ?? '',
            newPassword ?? '',
            phoneNumber ?? '',
        );
        res.json(result);
    } catch (err) {
        log.error('Consume password link failed', {
            error: err instanceof Error ? err.message : String(err),
        });
        next(err);
    }
}
