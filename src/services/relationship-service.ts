import type { Transaction } from 'sequelize';
import { getDb, queryAll, queryOne, execute, withTransaction } from '../db/connection.js';
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

export async function addRelationship(
    data: {
        sourcePersonId: string;
        targetPersonId: string;
        relationshipType: RelationshipType;
        createdBy: string;
    },
    parent?: Transaction,
): Promise<{ forward: RelationshipRow; inverse: RelationshipRow }> {
    const { sourcePersonId, targetPersonId, relationshipType, createdBy } = data;

    // Self-reference guard
    if (sourcePersonId === targetPersonId) {
        throw new AppError(
            'A person cannot have a relationship with themselves',
            400,
            'ERR_SELF_REFERENCE',
        );
    }

    // Checks and both inserts share one transaction (the caller's, when
    // it passes one), so a batch either lands completely or not at all.
    return withTransaction(async (t) => {
        const opts = { transaction: t };

        // Ensure both persons exist
        const srcExists = await queryOne(
            `SELECT id FROM person WHERE id = :id AND is_deleted = false`,
            { id: sourcePersonId },
            opts,
        );
        const tgtExists = await queryOne(
            `SELECT id FROM person WHERE id = :id AND is_deleted = false`,
            { id: targetPersonId },
            opts,
        );

        if (!srcExists || !tgtExists) {
            throw new AppError('One or both persons not found', 404, 'ERR_NOT_FOUND');
        }

        // Type-specific validations
        if (relationshipType === 'PARENT') {
            // source is PARENT of target → check cycle: target must not be ancestor of source
            await assertNoCycle(sourcePersonId, targetPersonId, t);
            // target gains a parent → check max parents
            await assertMaxParents(targetPersonId, 2, t);
        } else if (relationshipType === 'CHILD') {
            // source is CHILD of target → target is PARENT of source
            await assertNoCycle(targetPersonId, sourcePersonId, t);
            await assertMaxParents(sourcePersonId, 2, t);
        } else if (relationshipType === 'SPOUSE') {
            await assertMaxSpouses(sourcePersonId, 2, t);
            await assertMaxSpouses(targetPersonId, 2, t);
        }

        // Duplicate check for both directions
        await assertNoDuplicate(sourcePersonId, targetPersonId, relationshipType, t);
        await assertNoDuplicate(
            targetPersonId,
            sourcePersonId,
            INVERSE[relationshipType],
            t,
        );

        try {
            const forward = await queryOne<RelationshipRow>(
                `INSERT INTO relationship (source_person_id, target_person_id, relationship_type, created_by)
           VALUES (:source, :target, :type, :createdBy)
           RETURNING *`,
                { source: sourcePersonId, target: targetPersonId, type: relationshipType, createdBy },
                opts,
            );
            const inverse = await queryOne<RelationshipRow>(
                `INSERT INTO relationship (source_person_id, target_person_id, relationship_type, created_by)
           VALUES (:source, :target, :type, :createdBy)
           RETURNING *`,
                {
                    source: targetPersonId,
                    target: sourcePersonId,
                    type: INVERSE[relationshipType],
                    createdBy,
                },
                opts,
            );
            return { forward: forward!, inverse: inverse! };
        } catch (err) {
            log.error('Add relationship insert failed', { sourcePersonId, targetPersonId, relationshipType, error: err instanceof Error ? err.message : String(err) });
            throw err;
        }
    }, parent);
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
    // Update both directions together, so the pair can't disagree
    await withTransaction(async (t) => {
        await execute(
            `UPDATE relationship
             SET status = :status, updated_at = NOW()
             WHERE source_person_id = :source
               AND target_person_id = :target
               AND relationship_type = 'SPOUSE'`,
            { status, source: sourcePersonId, target: targetPersonId },
            { transaction: t },
        );
        await execute(
            `UPDATE relationship
             SET status = :status, updated_at = NOW()
             WHERE source_person_id = :target
               AND target_person_id = :source
               AND relationship_type = 'SPOUSE'`,
            { status, source: sourcePersonId, target: targetPersonId },
            { transaction: t },
        );
    });
}
