import { getDb, queryAll, queryOne, execute } from '../db/connection.js';
import { AppError, type RelationshipRow, type RelationshipStatus, type RelationshipType } from '../types/index.js';
import {
    assertNoCycle,
    assertMaxParents,
    assertNoDuplicate,
    assertMaxSpouses,
} from '../validators/graph-validator.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('relationship-service');

/* ------------------------------------------------------------------ */
/*  Inverse map                                                        */
/* ------------------------------------------------------------------ */

const INVERSE: Record<RelationshipType, RelationshipType> = {
    PARENT: 'CHILD',
    CHILD: 'PARENT',
    SPOUSE: 'SPOUSE',
};

/* ------------------------------------------------------------------ */
/*  Add relationship (with full validation)                            */
/* ------------------------------------------------------------------ */

export async function addRelationship(data: {
    sourcePersonId: string;
    targetPersonId: string;
    relationshipType: RelationshipType;
    createdBy: string;
}): Promise<{ forward: RelationshipRow; inverse: RelationshipRow }> {
    const { sourcePersonId, targetPersonId, relationshipType, createdBy } = data;

    // Self-reference guard
    if (sourcePersonId === targetPersonId) {
        throw new AppError(
            'A person cannot have a relationship with themselves',
            400,
            'ERR_SELF_REFERENCE',
        );
    }

    // Ensure both persons exist
    const srcExists = await queryOne(
        `SELECT id FROM person WHERE id = :id AND is_deleted = false`,
        { id: sourcePersonId },
    );
    const tgtExists = await queryOne(
        `SELECT id FROM person WHERE id = :id AND is_deleted = false`,
        { id: targetPersonId },
    );

    if (!srcExists || !tgtExists) {
        throw new AppError('One or both persons not found', 404, 'ERR_NOT_FOUND');
    }

    // Type-specific validations
    if (relationshipType === 'PARENT') {
        // source is PARENT of target → check cycle: target must not be ancestor of source
        await assertNoCycle(sourcePersonId, targetPersonId);
        // target gains a parent → check max parents
        await assertMaxParents(targetPersonId);
    } else if (relationshipType === 'CHILD') {
        // source is CHILD of target → target is PARENT of source
        await assertNoCycle(targetPersonId, sourcePersonId);
        await assertMaxParents(sourcePersonId);
    } else if (relationshipType === 'SPOUSE') {
        await assertMaxSpouses(sourcePersonId);
        await assertMaxSpouses(targetPersonId);
    }

    // Duplicate check for both directions
    await assertNoDuplicate(sourcePersonId, targetPersonId, relationshipType);
    await assertNoDuplicate(
        targetPersonId,
        sourcePersonId,
        INVERSE[relationshipType],
    );

    // Insert both directions in a transaction
    const db = await getDb();
    const t = await db.transaction();

    try {
        const forwardRows = await db.query(
            `INSERT INTO relationship (source_person_id, target_person_id, relationship_type, created_by)
       VALUES (:source, :target, :type, :createdBy)
       RETURNING *`,
            {
                replacements: {
                    source: sourcePersonId,
                    target: targetPersonId,
                    type: relationshipType,
                    createdBy,
                },
                transaction: t,
            },
        );

        const inverseRows = await db.query(
            `INSERT INTO relationship (source_person_id, target_person_id, relationship_type, created_by)
       VALUES (:source, :target, :type, :createdBy)
       RETURNING *`,
            {
                replacements: {
                    source: targetPersonId,
                    target: sourcePersonId,
                    type: INVERSE[relationshipType],
                    createdBy,
                },
                transaction: t,
            },
        );

        await t.commit();

        const forward = (forwardRows[0] as RelationshipRow[])[0];
        const inverse = (inverseRows[0] as RelationshipRow[])[0];

        return { forward, inverse };
    } catch (err) {
        await t.rollback();
        log.error('Add relationship transaction failed', { sourcePersonId, targetPersonId, relationshipType, error: err instanceof Error ? err.message : String(err) });
        throw err;
    }
}

/* ------------------------------------------------------------------ */
/*  Remove relationship (removes both directions)                      */
/* ------------------------------------------------------------------ */

export async function removeRelationship(relationshipId: string): Promise<void> {
    const rel = await queryOne<RelationshipRow>(
        `SELECT * FROM relationship WHERE id = :id`,
        { id: relationshipId },
    );

    if (!rel) {
        throw new AppError('Relationship not found', 404, 'ERR_NOT_FOUND');
    }

    const db = await getDb();
    const t = await db.transaction();

    try {
        // Delete forward
        await db.query(`DELETE FROM relationship WHERE id = :id`, {
            replacements: { id: relationshipId },
            transaction: t,
        });

        // Delete inverse
        await db.query(
            `DELETE FROM relationship
       WHERE source_person_id = :source
         AND target_person_id = :target
         AND relationship_type = :type`,
            {
                replacements: {
                    source: rel.target_person_id,
                    target: rel.source_person_id,
                    type: INVERSE[rel.relationship_type],
                },
                transaction: t,
            },
        );

        await t.commit();
    } catch (err) {
        await t.rollback();
        throw err;
    }
}

/* ------------------------------------------------------------------ */
/*  Get relationships for a person                                     */
/* ------------------------------------------------------------------ */

export async function getRelationshipsForPerson(
    personId: string,
): Promise<RelationshipRow[]> {
    return queryAll<RelationshipRow>(
        `SELECT r.* FROM relationship r
     INNER JOIN person p ON p.id = r.target_person_id AND p.is_deleted = false
     WHERE r.source_person_id = :personId
     ORDER BY r.relationship_type, r.created_at`,
        { personId },
    );
}

/* ------------------------------------------------------------------ */
/*  Update relationship status (e.g. mark as divorced)                 */
/* ------------------------------------------------------------------ */

export async function updateRelationshipStatus(
    sourcePersonId: string,
    targetPersonId: string,
    status: RelationshipStatus,
): Promise<void> {
    // Update both directions
    await execute(
        `UPDATE relationship
         SET status = :status, updated_at = NOW()
         WHERE source_person_id = :source
           AND target_person_id = :target
           AND relationship_type = 'SPOUSE'`,
        { status, source: sourcePersonId, target: targetPersonId },
    );
    await execute(
        `UPDATE relationship
         SET status = :status, updated_at = NOW()
         WHERE source_person_id = :target
           AND target_person_id = :source
           AND relationship_type = 'SPOUSE'`,
        { status, source: sourcePersonId, target: targetPersonId },
    );
}
