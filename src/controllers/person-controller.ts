import type { NextFunction, Response } from 'express';
import * as personService from '../services/person-service.js';
import * as relationshipService from '../services/relationship-service.js';
import type { AuthenticatedRequest, RelationshipType } from '../types/index.js';
import { assertCanEdit } from '../validators/permission-validator.js';
import { assertMaxParents, assertMaxSpouses } from '../validators/graph-validator.js';
import { recomputeLayout } from '../services/layout-service.js';
import { withTransaction } from '../db/connection.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('person-controller');

const VALID_RELATION_TYPES = new Set<string>(['PARENT', 'CHILD', 'SPOUSE']);

export async function create(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
): Promise<void> {
    try {
        const {
            firstName,
            lastName,
            gender,
            isDeceased,
            birthDate,
            deathYear,
            bio,
            phoneNumber,
            socialLinks,
            location,
        } = req.body;

        if (!firstName) {
            res.status(400).json({ error: 'firstName is required' });
            return;
        }

        log.info('Creating person', { firstName, lastName, userId: req.user!.userId });
        const person = await personService.createPerson({
            firstName,
            lastName,
            gender,
            isDeceased,
            birthDate,
            deathYear,
            bio,
            phoneNumber,
            socialLinks,
            location,
            createdBy: req.user!.userId,
        });

        log.info('Person created', { personId: person.id, firstName });
        await recomputeLayout();
        res.status(201).json(person);
    } catch (err) {
        log.error('Create person failed', { error: err instanceof Error ? err.message : String(err) });
        next(err);
    }
}

/* ------------------------------------------------------------------ */
/*  Create person + relationships in one shot (single layout pass)     */
/* ------------------------------------------------------------------ */

interface RelationInput {
    targetPersonId: string;
    relationshipType: RelationshipType;
}

export async function createWithRelations(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
): Promise<void> {
    try {
        const { person, relations } = req.body as {
            person?: Record<string, unknown>;
            relations?: RelationInput[];
        };

        if (!person?.firstName) {
            res.status(400).json({ error: 'person.firstName is required' });
            return;
        }
        const relationList: RelationInput[] = Array.isArray(relations) ? relations : [];
        for (const rel of relationList) {
            if (!rel?.targetPersonId || !VALID_RELATION_TYPES.has(rel.relationshipType)) {
                res.status(400).json({
                    error: 'Each relation needs targetPersonId and a valid relationshipType',
                });
                return;
            }
        }

        /* Pre-flight validations BEFORE creating the person, so a
         * predictable failure doesn't leave an orphan node behind.
         * (Cycles/duplicates are impossible for a brand-new person.) */
        const parentRows = relationList.filter((r) => r.relationshipType === 'CHILD');
        if (parentRows.length > 2) {
            res.status(400).json({ error: 'A person cannot have more than 2 parents' });
            return;
        }
        for (const rel of relationList) {
            if (rel.relationshipType === 'PARENT') {
                // New person becomes a parent of target → target gains a parent
                await assertMaxParents(rel.targetPersonId);
            } else if (rel.relationshipType === 'SPOUSE') {
                await assertMaxSpouses(rel.targetPersonId);
            }
        }

        log.info('Creating person with relations', {
            firstName: person.firstName,
            relationCount: relationList.length,
            userId: req.user!.userId,
        });

        // Person + every link in one transaction: if any link is rejected
        // nothing is saved, instead of leaving a half-linked person behind.
        const { created, relationships } = await withTransaction(async (t) => {
            const created = await personService.createPerson({
                ...(person as object),
                createdBy: req.user!.userId,
            } as Parameters<typeof personService.createPerson>[0], t);

            const relationships = [];
            for (const rel of relationList) {
                const result = await relationshipService.addRelationship({
                    sourcePersonId: created.id,
                    targetPersonId: rel.targetPersonId,
                    relationshipType: rel.relationshipType,
                    createdBy: req.user!.userId,
                }, t);
                relationships.push(result.forward);
            }
            return { created, relationships };
        });

        await recomputeLayout();
        log.info('Person created with relations', {
            personId: created.id,
            relationCount: relationships.length,
        });
        res.status(201).json({ person: created, relationships });
    } catch (err) {
        log.error('Create person with relations failed', {
            error: err instanceof Error ? err.message : String(err),
        });
        next(err);
    }
}

/* ------------------------------------------------------------------ */
/*  Get person by ID                                                   */
/* ------------------------------------------------------------------ */

export async function getById(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
): Promise<void> {
    try {
        const id = req.params.id as string;
        log.info('Fetching person', { personId: id });
        const person = await personService.getPersonById(id);
        res.json(person);
    } catch (err) {
        log.error('Fetch person failed', { personId: req.params.id, error: err instanceof Error ? err.message : String(err) });
        next(err);
    }
}

/* ------------------------------------------------------------------ */
/*  List all people                                                    */
/* ------------------------------------------------------------------ */

export async function list(
    _req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
): Promise<void> {
    try {
        log.info('Listing all people');
        const people = await personService.listPeople();
        log.info('Listed people', { count: people.length });
        res.json(people);
    } catch (err) {
        log.error('List people failed', { error: err instanceof Error ? err.message : String(err) });
        next(err);
    }
}

/* ------------------------------------------------------------------ */
/*  Update person (permission-checked)                                 */
/* ------------------------------------------------------------------ */

export async function update(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
): Promise<void> {
    try {
        const personId = req.params.id as string;
        log.info('Updating person', { personId, userId: req.user!.userId });
        await assertCanEdit(req.user!, personId);

        const person = await personService.updatePerson(personId, {
            ...req.body,
            updatedBy: req.user!.userId,
        });

        log.info('Person updated', { personId });
        res.json(person);
    } catch (err) {
        log.error('Update person failed', { personId: req.params.id, error: err instanceof Error ? err.message : String(err) });
        next(err);
    }
}

/* ------------------------------------------------------------------ */
/*  Soft delete (admin only)                                           */
/* ------------------------------------------------------------------ */

export async function remove(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
): Promise<void> {
    try {
        const id = req.params.id as string;
        log.info('Deleting person', { personId: id });
        await personService.softDeletePerson(id);
        log.info('Person deleted', { personId: id });
        await recomputeLayout();
        res.json({ message: 'Person deleted' });
    } catch (err) {
        log.error('Delete person failed', { personId: req.params.id, error: err instanceof Error ? err.message : String(err) });
        next(err);
    }
}

/* ------------------------------------------------------------------ */
/*  Merge a duplicate into another person (admin only)                 */
/* ------------------------------------------------------------------ */

export async function merge(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
): Promise<void> {
    try {
        const duplicateId = req.params.id as string;
        const { keepId } = req.body as { keepId?: string };
        if (!keepId) {
            res.status(400).json({ error: 'keepId is required' });
            return;
        }
        log.info('Merging person', { duplicateId, keepId, userId: req.user!.userId });
        const result = await personService.mergePerson(duplicateId, keepId, req.user!.userId);
        await recomputeLayout();
        res.json(result);
    } catch (err) {
        log.error('Merge person failed', { personId: req.params.id, error: err instanceof Error ? err.message : String(err) });
        next(err);
    }
}
