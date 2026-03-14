import type { Response, NextFunction } from 'express';
import type { AuthenticatedRequest } from '../types/index.js';
import * as treeService from '../services/tree-service.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('tree-controller');

/* ------------------------------------------------------------------ */
/*  Get subtree centered on a person                                   */
/* ------------------------------------------------------------------ */

export async function getSubtree(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
): Promise<void> {
    try {
        const personId = req.params.personId as string;
        log.info('Fetching subtree', { personId });
        const tree = await treeService.getSubtree(personId);
        log.info('Subtree fetched', { personId, nodeCount: Object.keys(tree).length });
        res.json({ people: tree });
    } catch (err) {
        log.error('Fetch subtree failed', { personId: req.params.personId, error: err instanceof Error ? err.message : String(err) });
        next(err);
    }
}

/* ------------------------------------------------------------------ */
/*  Get ancestors (recursive)                                          */
/* ------------------------------------------------------------------ */

export async function getAncestors(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
): Promise<void> {
    try {
        const personId = req.params.personId as string;
        log.info('Fetching ancestors', { personId });
        const ancestors = await treeService.getAncestors(personId);
        log.info('Ancestors fetched', { personId, count: ancestors.length });
        res.json(ancestors);
    } catch (err) {
        log.error('Fetch ancestors failed', { personId: req.params.personId, error: err instanceof Error ? err.message : String(err) });
        next(err);
    }
}

/* ------------------------------------------------------------------ */
/*  Get descendants (recursive)                                        */
/* ------------------------------------------------------------------ */

export async function getDescendants(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
): Promise<void> {
    try {
        const personId = req.params.personId as string;
        log.info('Fetching descendants', { personId });
        const descendants = await treeService.getDescendants(personId);
        log.info('Descendants fetched', { personId, count: descendants.length });
        res.json(descendants);
    } catch (err) {
        log.error('Fetch descendants failed', { personId: req.params.personId, error: err instanceof Error ? err.message : String(err) });
        next(err);
    }
}
