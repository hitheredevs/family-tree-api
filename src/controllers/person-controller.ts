import type { NextFunction, Response } from 'express';
import * as personService from '../services/person-service.js';
import type { AuthenticatedRequest } from '../types/index.js';
import { assertCanEdit } from '../validators/permission-validator.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('person-controller');

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
        res.status(201).json(person);
    } catch (err) {
        log.error('Create person failed', { error: err instanceof Error ? err.message : String(err) });
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
        res.json({ message: 'Person deleted' });
    } catch (err) {
        log.error('Delete person failed', { personId: req.params.id, error: err instanceof Error ? err.message : String(err) });
        next(err);
    }
}
