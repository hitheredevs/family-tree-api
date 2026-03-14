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

export async function requestPhoneOtp(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
): Promise<void> {
    try {
        if (!req.user) {
            res.status(401).json({ error: 'Not authenticated' });
            return;
        }

        const { phoneNumber } = req.body;
        log.info('Phone OTP requested', { userId: req.user.userId, phoneNumber });
        const result = await authService.requestPhoneVerificationOtp(
            req.user.userId,
            phoneNumber,
        );
        log.info('Phone OTP sent', { userId: req.user.userId });
        res.json(result);
    } catch (err) {
        log.error('Phone OTP request failed', {
            userId: req.user?.userId,
            error: err instanceof Error ? err.message : String(err),
        });
        next(err);
    }
}

export async function verifyPhoneOtp(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
): Promise<void> {
    try {
        if (!req.user) {
            res.status(401).json({ error: 'Not authenticated' });
            return;
        }

        const { otp } = req.body;
        log.info('Phone OTP verification attempt', { userId: req.user.userId });
        const user = await authService.verifyPhoneOtp(req.user.userId, otp);
        log.info('Phone verified successfully', { userId: req.user.userId });
        res.json({ message: 'Phone verified successfully', user });
    } catch (err) {
        log.error('Phone OTP verification failed', {
            userId: req.user?.userId,
            error: err instanceof Error ? err.message : String(err),
        });
        next(err);
    }
}

export async function requestForgotPasswordOtp(
    req: Request,
    res: Response,
    next: NextFunction,
): Promise<void> {
    try {
        const { username, phoneNumber } = req.body;
        log.info('Forgot password OTP requested', { username });
        const result = await authService.requestPasswordResetOtp(username, phoneNumber);
        log.info('Forgot password OTP sent', { username });
        res.json(result);
    } catch (err) {
        log.error('Forgot password OTP failed', {
            username: req.body?.username,
            error: err instanceof Error ? err.message : String(err),
        });
        next(err);
    }
}

export async function resetPasswordWithOtp(
    req: Request,
    res: Response,
    next: NextFunction,
): Promise<void> {
    try {
        const { username, phoneNumber, otp, newPassword } = req.body;
        log.info('Password reset with OTP attempt', { username });
        await authService.resetPasswordWithOtp(
            username,
            phoneNumber,
            otp,
            newPassword,
        );
        log.info('Password reset with OTP successful', { username });
        res.json({ message: 'Password reset successfully' });
    } catch (err) {
        log.error('Password reset with OTP failed', {
            username: req.body?.username,
            error: err instanceof Error ? err.message : String(err),
        });
        next(err);
    }
}

export async function resetPasswordWithWhatsApp(
    req: Request,
    res: Response,
    next: NextFunction,
): Promise<void> {
    try {
        const { username, whatsappPhone, newPassword } = req.body;
        log.info('Password reset with WhatsApp attempt', { username });
        await authService.resetPasswordWithWhatsApp(username, whatsappPhone, newPassword);
        log.info('Password reset with WhatsApp successful', { username });
        res.json({ message: 'Password reset successfully' });
    } catch (err) {
        log.error('Password reset with WhatsApp failed', {
            username: req.body?.username,
            error: err instanceof Error ? err.message : String(err),
        });
        next(err);
    }
}
