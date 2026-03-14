import { queryAll, queryOne } from '../db/connection.js';
import {
    AppError,
    type PersonRow,
    type RelationshipRow,
    type TreePerson,
} from '../types/index.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('tree-service');

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function personToTree(row: PersonRow, rels: RelationshipRow[]): TreePerson {
    const parentIds: string[] = [];
    const spouseIds: string[] = [];
    const exSpouseIds: string[] = [];
    const childrenIds: string[] = [];

    for (const r of rels) {
        if (r.source_person_id !== row.id) continue;
        switch (r.relationship_type) {
            case 'CHILD':
                parentIds.push(r.target_person_id);
                break;
            case 'SPOUSE':
                if (r.status === 'divorced') {
                    exSpouseIds.push(r.target_person_id);
                } else {
                    spouseIds.push(r.target_person_id);
                }
                break;
            case 'PARENT':
                childrenIds.push(r.target_person_id);
                break;
        }
    }

    return {
        id: row.id,
        firstName: row.first_name,
        lastName: row.last_name,
        gender: row.gender,
        isDeceased: row.is_deceased,
        birthDate: row.birth_date,
        deathYear: row.death_year,
        bio: row.bio,
        phoneNumber: row.phone_number,
        socialLinks: row.social_links,
        phoneVerified: row.phone_verified,
        location: row.location,
        createdBy: row.created_by,
        updatedBy: row.updated_by,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        parentIds,
        spouseIds,
        exSpouseIds,
        childrenIds,
    };
}

/* ------------------------------------------------------------------ */
/*  Get full connected tree centered on a person                       */
/*  Walks every relationship edge recursively to collect all people     */
/*  reachable from the center (ancestors, descendants, spouses, etc.)  */
/* ------------------------------------------------------------------ */

export async function getSubtree(
    centerId: string,
): Promise<Record<string, TreePerson>> {
    // 1. Verify center exists
    const center = await queryOne<PersonRow>(
        `SELECT * FROM person WHERE id = :id AND is_deleted = false`,
        { id: centerId },
    );
    if (!center) {
        log.warn('Subtree center person not found', { centerId });
        throw new AppError('Person not found', 404, 'ERR_NOT_FOUND');
    }
    log.info('Building subtree', { centerId });

    // 2. Recursive CTE: walk ALL relationship edges to find every connected person
    //    Since relationships are stored bidirectionally, following source→target
    //    from each discovered person will traverse the full graph.
    const connectedPeople = await queryAll<PersonRow>(
        `WITH RECURSIVE connected AS (
            SELECT p.id
            FROM person p
            WHERE p.id = :centerId AND p.is_deleted = false

            UNION

            SELECT p.id
            FROM relationship r
            INNER JOIN connected c ON r.source_person_id = c.id
            INNER JOIN person p ON p.id = r.target_person_id
            WHERE p.is_deleted = false
        )
        SELECT DISTINCT p.*
        FROM person p
        INNER JOIN connected c ON p.id = c.id
        WHERE p.is_deleted = false`,
        { centerId },
    );

    if (connectedPeople.length === 0) return {};

    // 3. Fetch ALL relationships for these people (exclude deleted targets)
    const idArray = connectedPeople.map((p) => p.id);
    const allRels = await queryAll<RelationshipRow>(
        `SELECT r.* FROM relationship r
         INNER JOIN person p ON p.id = r.target_person_id AND p.is_deleted = false
         WHERE r.source_person_id = ANY(ARRAY[${idArray.map((_, i) => `:id${i}`).join(',')}]::uuid[])`,
        Object.fromEntries(idArray.map((id, i) => [`id${i}`, id])),
    );

    // 4. Compose tree
    const result: Record<string, TreePerson> = {};
    for (const p of connectedPeople) {
        result[p.id] = personToTree(p, allRels);
    }

    return result;
}

/* ------------------------------------------------------------------ */
/*  Recursive ancestors                                                */
/* ------------------------------------------------------------------ */

export async function getAncestors(personId: string): Promise<TreePerson[]> {
    // Recursive CTE: walk up parent edges
    const rows = await queryAll<PersonRow>(
        `WITH RECURSIVE ancestors AS (
       -- direct parents
       SELECT p.*
       FROM person p
       INNER JOIN relationship r ON r.target_person_id = p.id
       WHERE r.source_person_id = :personId
         AND r.relationship_type = 'CHILD'
         AND p.is_deleted = false

       UNION

       -- grandparents and up
       SELECT p.*
       FROM person p
       INNER JOIN relationship r ON r.target_person_id = p.id
       INNER JOIN ancestors a ON r.source_person_id = a.id
       WHERE r.relationship_type = 'CHILD'
         AND p.is_deleted = false
     )
     SELECT DISTINCT * FROM ancestors`,
        { personId },
    );

    // Fetch relationships for each ancestor (exclude deleted targets)
    if (rows.length === 0) return [];

    const ids = rows.map((r) => r.id);
    const rels = await queryAll<RelationshipRow>(
        `SELECT r.* FROM relationship r
     INNER JOIN person p ON p.id = r.target_person_id AND p.is_deleted = false
     WHERE r.source_person_id = ANY(ARRAY[${ids.map((_, i) => `:id${i}`).join(',')}]::uuid[])`,
        Object.fromEntries(ids.map((id, i) => [`id${i}`, id])),
    );

    return rows.map((r) => personToTree(r, rels));
}

/* ------------------------------------------------------------------ */
/*  Recursive descendants                                              */
/* ------------------------------------------------------------------ */

export async function getDescendants(personId: string): Promise<TreePerson[]> {
    const rows = await queryAll<PersonRow>(
        `WITH RECURSIVE descendants AS (
       -- direct children
       SELECT p.*
       FROM person p
       INNER JOIN relationship r ON r.target_person_id = p.id
       WHERE r.source_person_id = :personId
         AND r.relationship_type = 'PARENT'
         AND p.is_deleted = false

       UNION

       -- grandchildren and down
       SELECT p.*
       FROM person p
       INNER JOIN relationship r ON r.target_person_id = p.id
       INNER JOIN descendants d ON r.source_person_id = d.id
       WHERE r.relationship_type = 'PARENT'
         AND p.is_deleted = false
     )
     SELECT DISTINCT * FROM descendants`,
        { personId },
    );

    if (rows.length === 0) return [];

    const ids = rows.map((r) => r.id);
    const rels = await queryAll<RelationshipRow>(
        `SELECT r.* FROM relationship r
     INNER JOIN person p ON p.id = r.target_person_id AND p.is_deleted = false
     WHERE r.source_person_id = ANY(ARRAY[${ids.map((_, i) => `:id${i}`).join(',')}]::uuid[])`,
        Object.fromEntries(ids.map((id, i) => [`id${i}`, id])),
    );

    return rows.map((r) => personToTree(r, rels));
}
