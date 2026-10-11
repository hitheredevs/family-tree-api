import type { Transaction } from 'sequelize';
import { queryOne, queryAll } from '../db/connection.js';
import { AppError, type RelationshipRow } from '../types/index.js';

const fullName = (first: string, last?: string | null) =>
    [first?.trim(), last?.trim()].filter(Boolean).join(' ');

/**
 * Detects if adding "newParentId as PARENT of childId" would create
 * a cycle in the ancestry graph.
 *
 * A cycle exists if childId is already an ancestor of newParentId.
 */
export async function assertNoCycle(
    newParentId: string,
    childId: string,
    t?: Transaction,
): Promise<void> {
    // If child is an ancestor of the new parent → cycle
    const row = await queryOne<{ found: number }>(
        `WITH RECURSIVE ancestors AS (
       SELECT r.source_person_id AS ancestor_id
       FROM relationship r
       INNER JOIN person p ON p.id = r.source_person_id AND p.is_deleted = false
       WHERE r.target_person_id = :startId
         AND r.relationship_type = 'PARENT'
       UNION
       SELECT r.source_person_id
       FROM relationship r
       INNER JOIN ancestors a ON r.target_person_id = a.ancestor_id
       INNER JOIN person p ON p.id = r.source_person_id AND p.is_deleted = false
       WHERE r.relationship_type = 'PARENT'
     )
     SELECT 1 AS found FROM ancestors WHERE ancestor_id = :checkId
     LIMIT 1`,
        { startId: newParentId, checkId: childId },
        { transaction: t },
    );

    if (row) {
        throw new AppError(
            'Adding this parent would create a cycle in the family tree',
            400,
            'ERR_CYCLE_DETECTED',
        );
    }
}

/**
 * Ensures a person does not exceed the maximum number of parents (2).
 * The error names the child and the parents they already have, so the
 * person adding the link can see which one is wrong.
 */
export async function assertMaxParents(
    childId: string,
    max: number = 2,
    t?: Transaction,
): Promise<void> {
    const parents = await queryAll<{ first_name: string; last_name: string | null }>(
        `SELECT p.first_name, p.last_name FROM relationship r
     INNER JOIN person p ON p.id = r.source_person_id AND p.is_deleted = false
     WHERE r.target_person_id = :childId
       AND r.relationship_type = 'PARENT'
     ORDER BY p.first_name`,
        { childId },
        { transaction: t },
    );

    if (parents.length >= max) {
        const child = await queryOne<{ first_name: string; last_name: string | null }>(
            `SELECT first_name, last_name FROM person WHERE id = :childId`,
            { childId },
            { transaction: t },
        );
        const childName = child ? fullName(child.first_name, child.last_name) : 'This person';
        const names = parents.map((p) => fullName(p.first_name, p.last_name)).join(' and ');
        throw new AppError(
            `${childName} already has ${max} parents (${names}). Remove one of them before adding another.`,
            400,
            'ERR_MAX_PARENTS',
        );
    }
}

/**
 * Ensures this exact directed relationship does not already exist.
 */
export async function assertNoDuplicate(
    sourceId: string,
    targetId: string,
    type: string,
    t?: Transaction,
): Promise<void> {
    const row = await queryOne(
        `SELECT r.id FROM relationship r
     INNER JOIN person sp ON sp.id = r.source_person_id AND sp.is_deleted = false
     INNER JOIN person tp ON tp.id = r.target_person_id AND tp.is_deleted = false
     WHERE r.source_person_id = :sourceId
       AND r.target_person_id = :targetId
       AND r.relationship_type = :type`,
        { sourceId, targetId, type },
        { transaction: t },
    );

    if (row) {
        throw new AppError(
            'This relationship already exists',
            409,
            'ERR_DUPLICATE_RELATIONSHIP',
        );
    }
}

/**
 * Ensures a person does not exceed the maximum number of spouses (default 2).
 */
export async function assertMaxSpouses(
    personId: string,
    max: number = 2,
    t?: Transaction,
): Promise<void> {
    const rows = await queryAll<RelationshipRow>(
        `SELECT r.id FROM relationship r
     INNER JOIN person p ON p.id = r.target_person_id AND p.is_deleted = false
     WHERE r.source_person_id = :personId
       AND r.relationship_type = 'SPOUSE'
       AND r.status != 'divorced'`,
        { personId },
        { transaction: t },
    );

    if (rows.length >= max) {
        throw new AppError(
            `Person already has ${max} spouse(s). Cannot add more.`,
            400,
            'ERR_MAX_SPOUSES',
        );
    }
}
