import type { Response, NextFunction } from 'express';
import type { AuthenticatedRequest } from '../types/index.js';
import * as adminService from '../services/admin-service.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('admin-controller');

/* ------------------------------------------------------------------ */
/*  Create user for a person                                           */
/* ------------------------------------------------------------------ */

export async function createUser(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
): Promise<void> {
    try {
        const { username, password, role, personId } = req.body;

        if (!username || !password || !personId) {
            res.status(400).json({
                error: 'username, password, and personId are required',
            });
            return;
        }

        log.info('Creating user', { username, role: role ?? 'member', personId });
        const user = await adminService.createUser({
            username,
            password,
            role: role ?? 'member',
            personId,
        });

        log.info('User created', { userId: user.id, username });
        res.status(201).json(user);
    } catch (err) {
        log.error('Create user failed', { username: req.body?.username, error: err instanceof Error ? err.message : String(err) });
        next(err);
    }
}

/* ------------------------------------------------------------------ */
/*  List all users                                                     */
/* ------------------------------------------------------------------ */

export async function listUsers(
    _req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
): Promise<void> {
    try {
        log.info('Listing users');
        const users = await adminService.listUsers();
        log.info('Users listed', { count: users.length });
        res.json(users);
    } catch (err) {
        log.error('List users failed', { error: err instanceof Error ? err.message : String(err) });
        next(err);
    }
}

export async function generatePasswordLink(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
): Promise<void> {
    try {
        if (!req.user) {
            res.status(401).json({ error: 'Not authenticated' });
            return;
        }

        const personId = req.params.personId as string;
        const { purpose } = req.body as { purpose?: 'setup-password' | 'reset-password' };

        if (!purpose || (purpose !== 'setup-password' && purpose !== 'reset-password')) {
            res.status(400).json({ error: 'purpose must be setup-password or reset-password' });
            return;
        }

        log.info('Generating password link', {
            personId,
            purpose,
            adminUserId: req.user.userId,
        });

        const result = await adminService.generatePasswordLink({
            personId,
            purpose,
            createdByUserId: req.user.userId,
        });

        res.json(result);
    } catch (err) {
        log.error('Generate password link failed', {
            personId: req.params.personId,
            error: err instanceof Error ? err.message : String(err),
        });
        next(err);
    }
}
