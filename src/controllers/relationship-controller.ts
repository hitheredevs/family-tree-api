import type { Response, NextFunction } from 'express';
import type { AuthenticatedRequest, RelationshipType } from '../types/index.js';
import * as relationshipService from '../services/relationship-service.js';
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
        res.status(201).json(result);
    } catch (err) {
        log.error('Add relationship failed', { error: err instanceof Error ? err.message : String(err) });
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
        res.json({ message: 'Relationship status updated' });
    } catch (err) {
        log.error('Update relationship status failed', { error: err instanceof Error ? err.message : String(err) });
        next(err);
    }
}
