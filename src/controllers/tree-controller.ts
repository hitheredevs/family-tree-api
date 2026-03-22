import type { Response, NextFunction } from 'express';
import type { AuthenticatedRequest } from '../types/index.js';
import * as treeService from '../services/tree-service.js';
import * as layoutService from '../services/layout-service.js';
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
/*  Get subtree layout (slim – only fields needed for rendering)       */
/* ------------------------------------------------------------------ */

export async function getSubtreeLayout(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
): Promise<void> {
    try {
        const personId = req.params.personId as string;
        log.info('Fetching subtree layout', { personId });
        const tree = await treeService.getSubtreeLayout(personId);
        log.info('Subtree layout fetched', { personId, nodeCount: Object.keys(tree).length });
        res.json({ people: tree });
    } catch (err) {
        log.error('Fetch subtree layout failed', { personId: req.params.personId, error: err instanceof Error ? err.message : String(err) });
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

/* ------------------------------------------------------------------ */
/*  Recompute layout positions (admin only)                            */
/* ------------------------------------------------------------------ */

export async function recomputeLayout(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
): Promise<void> {
    try {
        const personId = req.params.personId as string;
        log.info('Recomputing layout', { personId, user: req.user?.userId });
        const result = await layoutService.recomputeLayout(personId);
        log.info('Layout recomputed', { personId, ...result });
        res.json(result);
    } catch (err) {
        log.error('Recompute layout failed', { personId: req.params.personId, error: err instanceof Error ? err.message : String(err) });
        next(err);
    }
}

/* ------------------------------------------------------------------ */
/*  Get all edges (loaded once on mount)                               */
/* ------------------------------------------------------------------ */

export async function getAllEdges(
    _req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
): Promise<void> {
    try {
        const edges = await layoutService.getAllEdges();
        res.json({ edges });
    } catch (err) {
        log.error('Get all edges failed', { error: err instanceof Error ? err.message : String(err) });
        next(err);
    }
}

/* ------------------------------------------------------------------ */
/*  Get tree viewport (spatial query)                                  */
/* ------------------------------------------------------------------ */

export async function getTreeViewport(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
): Promise<void> {
    try {
        const minX = parseFloat(req.query.minX as string);
        const maxX = parseFloat(req.query.maxX as string);
        const minY = parseFloat(req.query.minY as string);
        const maxY = parseFloat(req.query.maxY as string);
        const zoom = parseFloat(req.query.zoom as string) || 1;

        if ([minX, maxX, minY, maxY].some(isNaN)) {
            res.status(400).json({ error: 'minX, maxX, minY, maxY are required numeric query params' });
            return;
        }

        const result = await layoutService.getTreeViewport({ minX, maxX, minY, maxY, zoom });
        res.json(result);
    } catch (err) {
        log.error('Viewport query failed', { error: err instanceof Error ? err.message : String(err) });
        next(err);
    }
}
