import type { Response, NextFunction } from 'express';
import type { AuthenticatedRequest, RelationshipType } from '../types/index.js';
import * as relationshipService from '../services/relationship-service.js';
import { recomputeLayout } from '../services/layout-service.js';
import { withTransaction } from '../db/connection.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('relationship-controller');

const VALID_TYPES = new Set<string>(['PARENT', 'CHILD', 'SPOUSE']);

/* ------------------------------------------------------------------ */
/*  Add relationship                                                   */
/* ------------------------------------------------------------------ */

export async function add(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
): Promise<void> {
    try {
        const { sourcePersonId, targetPersonId, relationshipType } = req.body;

        if (!sourcePersonId || !targetPersonId || !relationshipType) {
            res.status(400).json({
                error: 'sourcePersonId, targetPersonId, and relationshipType are required',
            });
            return;
        }

        if (!VALID_TYPES.has(relationshipType)) {
            res.status(400).json({
                error: `relationshipType must be one of: ${[...VALID_TYPES].join(', ')}`,
            });
            return;
        }

        log.info('Adding relationship', { sourcePersonId, targetPersonId, relationshipType, userId: req.user!.userId });
        const result = await relationshipService.addRelationship({
            sourcePersonId,
            targetPersonId,
            relationshipType: relationshipType as RelationshipType,
            createdBy: req.user!.userId,
        });

        log.info('Relationship added', { forwardId: result.forward.id, inverseId: result.inverse.id });
        // Await the recompute so the new node/edge is positioned before
        // the client refreshes the canvas.
        await recomputeLayout();
        res.status(201).json(result);
    } catch (err) {
        log.error('Add relationship failed', { error: err instanceof Error ? err.message : String(err) });
        next(err);
    }
}

/* ------------------------------------------------------------------ */
/*  Add several relationships in one shot (single layout pass)         */
/* ------------------------------------------------------------------ */

export async function addBatch(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
): Promise<void> {
    try {
        const { relationships } = req.body as {
            relationships?: Array<{
                sourcePersonId: string;
                targetPersonId: string;
                relationshipType: string;
            }>;
        };

        if (!Array.isArray(relationships) || relationships.length === 0) {
            res.status(400).json({ error: 'relationships array is required' });
            return;
        }
        for (const rel of relationships) {
            if (
                !rel?.sourcePersonId ||
                !rel?.targetPersonId ||
                !VALID_TYPES.has(rel.relationshipType)
            ) {
                res.status(400).json({
                    error: 'Each relationship needs sourcePersonId, targetPersonId and a valid relationshipType',
                });
                return;
            }
        }

        log.info('Adding relationship batch', {
            count: relationships.length,
            userId: req.user!.userId,
        });

        // All or nothing: a rejected link rolls back the ones before it,
        // so a failed save never leaves partial links the user can't undo.
        const results = await withTransaction(async (t) => {
            const rows = [];
            for (const rel of relationships) {
                const result = await relationshipService.addRelationship({
                    sourcePersonId: rel.sourcePersonId,
                    targetPersonId: rel.targetPersonId,
                    relationshipType: rel.relationshipType as RelationshipType,
                    createdBy: req.user!.userId,
                }, t);
                rows.push(result.forward);
            }
            return rows;
        });
        await recomputeLayout();

        log.info('Relationship batch added', { count: results.length });
        res.status(201).json({ relationships: results });
    } catch (err) {
        log.error('Add relationship batch failed', {
            error: err instanceof Error ? err.message : String(err),
        });
        next(err);
    }
}

/* ------------------------------------------------------------------ */
/*  Remove relationship (admin only — enforced at route level)         */
/* ------------------------------------------------------------------ */

export async function remove(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
): Promise<void> {
    try {
        const id = req.params.id as string;
        log.info('Removing relationship', { relationshipId: id });
        await relationshipService.removeRelationship(id);
        log.info('Relationship removed', { relationshipId: id });
        await recomputeLayout();
        res.json({ message: 'Relationship removed' });
    } catch (err) {
        log.error('Remove relationship failed', { relationshipId: req.params.id, error: err instanceof Error ? err.message : String(err) });
        next(err);
    }
}

/* ------------------------------------------------------------------ */
/*  Get relationships for a person                                     */
/* ------------------------------------------------------------------ */

export async function getForPerson(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
): Promise<void> {
    try {
        const personId = req.params.personId as string;
        log.info('Fetching relationships', { personId });
        const relationships = await relationshipService.getRelationshipsForPerson(personId);
        log.info('Relationships fetched', { personId, count: relationships.length });
        res.json(relationships);
    } catch (err) {
        log.error('Fetch relationships failed', { personId: req.params.personId, error: err instanceof Error ? err.message : String(err) });
        next(err);
    }
}

/* ------------------------------------------------------------------ */
/*  Update relationship status (e.g. divorce)                          */
/* ------------------------------------------------------------------ */

export async function updateStatus(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
): Promise<void> {
    try {
        const { sourcePersonId, targetPersonId, status } = req.body;

        if (!sourcePersonId || !targetPersonId || !status) {
            res.status(400).json({
                error: 'sourcePersonId, targetPersonId, and status are required',
            });
            return;
        }

        const validStatuses = ['confirmed', 'pending', 'divorced'];
        if (!validStatuses.includes(status)) {
            res.status(400).json({
                error: `status must be one of: ${validStatuses.join(', ')}`,
            });
            return;
        }

        log.info('Updating relationship status', { sourcePersonId, targetPersonId, status });
        await relationshipService.updateRelationshipStatus(
            sourcePersonId,
            targetPersonId,
            status,
        );

        log.info('Relationship status updated', { sourcePersonId, targetPersonId, status });
        // Divorce/confirm changes spouse clustering — recompute positions.
        await recomputeLayout();
        res.json({ message: 'Relationship status updated' });
    } catch (err) {
        log.error('Update relationship status failed', { error: err instanceof Error ? err.message : String(err) });
        next(err);
    }
}
