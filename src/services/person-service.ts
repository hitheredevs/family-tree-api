import bcrypt from 'bcryptjs';
import type { Transaction } from 'sequelize';
import { execute, getDb, queryAll, queryOne, withTransaction } from '../db/connection.js';
import {
    AppError,
    type PersonResponse,
    type PersonRow,
    type RelationshipRow,
} from '../types/index.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('person-service');

type SocialLink = { type: string; url: string; handle: string };

function normalizePhoneNumber(phoneNumber: string): string {
    return phoneNumber.trim().replace(/[\s()-]/g, '');
}

async function assertPhoneNumberAvailable(
    phoneNumber: string | null | undefined,
    currentPersonId?: string,
    t?: Transaction,
): Promise<string | null> {
    if (!phoneNumber?.trim()) {
        return null;
    }

    const normalizedPhoneNumber = normalizePhoneNumber(phoneNumber);
    const existing = await queryOne<{ id: string }>(
        `SELECT id
         FROM person
         WHERE phone_number = :phoneNumber
           AND is_deleted = false
           AND (:currentPersonId::uuid IS NULL OR id != :currentPersonId::uuid)
         LIMIT 1`,
        {
            phoneNumber: normalizedPhoneNumber,
            currentPersonId: currentPersonId ?? null,
        },
        { transaction: t },
    );

    if (existing) {
        throw new AppError(
            'This phone number is already being used by another person',
            409,
            'ERR_DUPLICATE_PHONE',
        );
    }

    return normalizedPhoneNumber;
}

function toResponse(row: PersonRow): PersonResponse {
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
    };
}

export async function createPerson(data: {
    firstName: string;
    lastName?: string;
    gender?: string;
    isDeceased?: boolean;
    birthDate?: string;
    deathYear?: number | null;
    bio?: string;
    phoneNumber?: string;
    socialLinks?: SocialLink[] | null;
    location?: string;
    createdBy: string;
}, parent?: Transaction): Promise<PersonResponse> {
    return withTransaction((t) => insertPerson(data, t), parent);
}

async function insertPerson(data: Parameters<typeof createPerson>[0], t: Transaction): Promise<PersonResponse> {
    const opts = { transaction: t };
    const normalizedPhoneNumber = await assertPhoneNumberAvailable(data.phoneNumber, undefined, t);

    const row = await queryOne<PersonRow>(
        `INSERT INTO person (
			first_name,
			last_name,
			gender,
			is_deceased,
			birth_date,
			death_year,
			bio,
			phone_number,
			social_links,
			location,
			created_by,
			updated_by
		)
		VALUES (
			:firstName,
			:lastName,
			:gender,
			:isDeceased,
			:birthDate,
			:deathYear,
			:bio,
			:phoneNumber,
			CAST(:socialLinks AS JSONB),
			:location,
			:createdBy,
			:createdBy
		)
		RETURNING *`,
        {
            firstName: data.firstName,
            lastName: data.lastName ?? '',
            gender: data.gender ?? 'other',
            isDeceased: data.isDeceased ?? false,
            birthDate: data.birthDate ?? null,
            deathYear: data.deathYear ?? null,
            bio: data.bio ?? null,
            phoneNumber: normalizedPhoneNumber,
            socialLinks: JSON.stringify(data.socialLinks ?? null),
            location: data.location ?? null,
            createdBy: data.createdBy,
        },
        opts,
    );

    if (!row) throw new AppError('Failed to create person', 500);

    // The login is best effort, as before: if it fails the person is
    // still created. Inside a transaction that needs a savepoint, or the
    // failed INSERT would abort everything else in the transaction.
    const db = await getDb();
    try {
        await db.transaction({ transaction: t }, async (sp) => {
            const baseName = data.firstName.toLowerCase().replace(/[^a-z0-9]/g, '');
            let username = baseName;
            let suffix = 1;

            while (true) {
                const taken = await queryOne(
                    `SELECT id FROM app_user WHERE username = :username`,
                    { username },
                    { transaction: sp },
                );
                if (!taken) break;
                username = `${baseName}${suffix}`;
                suffix++;
            }

            const defaultPassword = 'login123';
            const passwordHash = await bcrypt.hash(defaultPassword, 12);

            await execute(
                `INSERT INTO app_user (username, password_hash, role, must_change_password, person_id)
    			 VALUES (:username, :passwordHash, 'member', true, :personId)`,
                { username, passwordHash, personId: row.id },
                { transaction: sp },
            );

            log.info('Auto-created user for person', { username, personId: row.id, firstName: data.firstName });
        });
    } catch (err) {
        log.warn('Auto-create user failed (person still created)', { error: err instanceof Error ? err.message : String(err) });
    }

    return toResponse(row);
}

export async function getPersonById(id: string): Promise<PersonResponse> {
    const row = await queryOne<PersonRow>(
        `SELECT * FROM person WHERE id = :id AND is_deleted = false`,
        { id },
    );

    if (!row) throw new AppError('Person not found', 404, 'ERR_NOT_FOUND');
    return toResponse(row);
}

export async function listPeople(): Promise<PersonResponse[]> {
    const rows = await queryAll<PersonRow>(
        `SELECT * FROM person WHERE is_deleted = false ORDER BY created_at`,
    );
    return rows.map(toResponse);
}

export async function updatePerson(
    id: string,
    data: {
        firstName?: string;
        lastName?: string;
        gender?: string;
        isDeceased?: boolean;
        birthDate?: string;
        deathYear?: number | null;
        bio?: string;
        phoneNumber?: string | null;
        socialLinks?: SocialLink[] | null;
        location?: string;
        updatedBy: string;
    },
): Promise<PersonResponse> {
    const existing = await queryOne<PersonRow>(
        `SELECT * FROM person WHERE id = :id AND is_deleted = false`,
        { id },
    );

    if (!existing) throw new AppError('Person not found', 404, 'ERR_NOT_FOUND');

    const nextPhoneNumber =
        data.phoneNumber !== undefined
            ? await assertPhoneNumberAvailable(data.phoneNumber, id)
            : existing.phone_number;

    const row = await queryOne<PersonRow>(
        `UPDATE person SET
		 first_name = :firstName,
		 last_name = :lastName,
		 gender = :gender,
		 is_deceased = :isDeceased,
		 birth_date = :birthDate,
		 death_year = :deathYear,
		 bio = :bio,
		 phone_number = :phoneNumber,
		 social_links = CAST(:socialLinks AS JSONB),
		 phone_verified = :phoneVerified,
		 location = :location,
		 updated_by = :updatedBy,
		 updated_at = NOW()
		WHERE id = :id AND is_deleted = false
		RETURNING *`,
        {
            id,
            firstName: data.firstName ?? existing.first_name,
            lastName: data.lastName ?? existing.last_name,
            gender: data.gender ?? existing.gender,
            isDeceased: data.isDeceased ?? existing.is_deceased,
            birthDate:
                data.birthDate !== undefined ? data.birthDate : existing.birth_date,
            deathYear:
                data.deathYear !== undefined ? data.deathYear : existing.death_year,
            bio: data.bio !== undefined ? data.bio : existing.bio,
            phoneNumber: nextPhoneNumber,
            socialLinks:
                data.socialLinks !== undefined
                    ? JSON.stringify(data.socialLinks)
                    : JSON.stringify(existing.social_links),
            phoneVerified:
                data.phoneNumber !== undefined && data.phoneNumber !== existing.phone_number
                    ? false
                    : existing.phone_verified,
            location: data.location !== undefined ? data.location : existing.location,
            updatedBy: data.updatedBy,
        },
    );

    if (!row) throw new AppError('Failed to update person', 500);
    return toResponse(row);
}

export async function softDeletePerson(id: string): Promise<void> {
    // One transaction: a failure part-way used to leave a person whose
    // login was gone but whose links (or the person) were still there.
    await withTransaction(async (t) => {
        const opts = { transaction: t };
        await execute(`DELETE FROM app_user WHERE person_id = :id`, { id }, opts);
        await execute(
            `DELETE FROM relationship WHERE source_person_id = :id OR target_person_id = :id`,
            { id },
            opts,
        );
        await execute(
            `UPDATE person SET is_deleted = true, updated_at = NOW() WHERE id = :id`,
            { id },
            opts,
        );
    });
}

/* ------------------------------------------------------------------ */
/*  Merge a duplicate into the person being kept                       */
/* ------------------------------------------------------------------ */

export interface MergeResult {
    keptId: string;
    movedLinks: number;
    droppedLinks: number;
    loginMoved: boolean;
}

const displayName = (p: { first_name: string; last_name: string | null }) =>
    [p.first_name?.trim(), p.last_name?.trim()].filter(Boolean).join(' ');

/**
 * Moves every relationship of `duplicateId` onto `keepId`, fills empty
 * profile fields of the kept person, keeps whichever login has been
 * used, then soft-deletes the duplicate — all in one transaction.
 * Deleting a duplicate instead throws all of its links away.
 */
export async function mergePerson(
    duplicateId: string,
    keepId: string,
    mergedBy: string,
): Promise<MergeResult> {
    if (duplicateId === keepId) {
        throw new AppError('Choose two different people to merge', 400, 'ERR_SELF_MERGE');
    }

    return withTransaction(async (t) => {
        const opts = { transaction: t };
        const lock = (id: string) =>
            queryOne<PersonRow>(
                `SELECT * FROM person WHERE id = :id AND is_deleted = false FOR UPDATE`,
                { id },
                opts,
            );
        const dup = await lock(duplicateId);
        const keep = await lock(keepId);
        if (!dup || !keep) throw new AppError('Person not found', 404, 'ERR_NOT_FOUND');

        // 1. Re-point the duplicate's links. A link the kept person
        //    already has, or one between the two of them, is dropped.
        const rels = await queryAll<RelationshipRow>(
            `SELECT * FROM relationship
             WHERE source_person_id = :id OR target_person_id = :id
             ORDER BY created_at, id`,
            { id: duplicateId },
            opts,
        );
        let movedRows = 0;
        let droppedRows = 0;
        for (const r of rels) {
            const source = r.source_person_id === duplicateId ? keepId : r.source_person_id;
            const target = r.target_person_id === duplicateId ? keepId : r.target_person_id;
            const clash =
                source === target ||
                (await queryOne(
                    `SELECT id FROM relationship
                     WHERE source_person_id = :source AND target_person_id = :target
                       AND relationship_type = :type AND id <> :id`,
                    { source, target, type: r.relationship_type, id: r.id },
                    opts,
                ));
            if (clash) {
                await execute(`DELETE FROM relationship WHERE id = :id`, { id: r.id }, opts);
                droppedRows++;
            } else {
                await execute(
                    `UPDATE relationship
                     SET source_person_id = :source, target_person_id = :target, updated_at = NOW()
                     WHERE id = :id`,
                    { source, target, id: r.id },
                    opts,
                );
                movedRows++;
            }
        }

        // 2. The kept person must still follow the tree's rules.
        const parents = await queryAll<{ first_name: string; last_name: string | null }>(
            `SELECT p.first_name, p.last_name FROM relationship r
             JOIN person p ON p.id = r.source_person_id AND p.is_deleted = false
             WHERE r.target_person_id = :id AND r.relationship_type = 'PARENT'
             ORDER BY p.first_name`,
            { id: keepId },
            opts,
        );
        if (parents.length > 2) {
            throw new AppError(
                `Merging would give ${displayName(keep)} ${parents.length} parents (${parents.map(displayName).join(', ')}). Remove the wrong parent link first.`,
                400,
                'ERR_MAX_PARENTS',
            );
        }
        const spouses = await queryOne<{ n: string }>(
            `SELECT count(*) AS n FROM relationship r
             JOIN person p ON p.id = r.target_person_id AND p.is_deleted = false
             WHERE r.source_person_id = :id AND r.relationship_type = 'SPOUSE' AND r.status != 'divorced'`,
            { id: keepId },
            opts,
        );
        if (Number(spouses?.n ?? 0) > 2) {
            throw new AppError(
                `Merging would give ${displayName(keep)} more than 2 current spouses. Mark one as divorced or remove it first.`,
                400,
                'ERR_MAX_SPOUSES',
            );
        }
        const ownAncestor = await queryOne(
            `WITH RECURSIVE ancestors AS (
                SELECT r.source_person_id AS id FROM relationship r
                WHERE r.target_person_id = :id AND r.relationship_type = 'PARENT'
                UNION
                SELECT r.source_person_id FROM relationship r
                JOIN ancestors a ON r.target_person_id = a.id
                WHERE r.relationship_type = 'PARENT'
             )
             SELECT 1 FROM ancestors WHERE id = :id LIMIT 1`,
            { id: keepId },
            opts,
        );
        if (ownAncestor) {
            throw new AppError(
                `Merging would make ${displayName(keep)} their own ancestor. Check the parent links of both entries first.`,
                400,
                'ERR_CYCLE_DETECTED',
            );
        }

        // 3. Fill the kept person's empty fields from the duplicate. The
        //    phone number is unique, so release it from the duplicate first.
        const takePhone = !keep.phone_number && Boolean(dup.phone_number);
        if (takePhone) {
            await execute(`UPDATE person SET phone_number = NULL WHERE id = :id`, { id: duplicateId }, opts);
        }
        await execute(
            `UPDATE person SET
                last_name = COALESCE(NULLIF(last_name, ''), :lastName),
                birth_date = COALESCE(birth_date, :birthDate),
                death_year = COALESCE(death_year, :deathYear),
                bio = COALESCE(NULLIF(bio, ''), :bio),
                location = COALESCE(NULLIF(location, ''), :location),
                social_links = COALESCE(social_links, CAST(:socialLinks AS JSONB)),
                phone_number = COALESCE(phone_number, :phone),
                phone_verified = CASE WHEN phone_number IS NULL AND CAST(:phone AS VARCHAR) IS NOT NULL
                                      THEN :phoneVerified ELSE phone_verified END,
                updated_by = :by,
                updated_at = NOW()
             WHERE id = :id`,
            {
                id: keepId,
                lastName: dup.last_name || null,
                birthDate: dup.birth_date ?? null,
                deathYear: dup.death_year ?? null,
                bio: dup.bio || null,
                location: dup.location || null,
                socialLinks: dup.social_links ? JSON.stringify(dup.social_links) : null,
                phone: takePhone ? dup.phone_number : null,
                phoneVerified: takePhone ? dup.phone_verified : false,
                by: mergedBy,
            },
            opts,
        );

        // 4. Logins: keep the one that has been used (password changed
        //    from the default). If both have been used, stop and ask.
        const users = await queryAll<{ id: string; person_id: string; must_change_password: boolean }>(
            `SELECT id, person_id, must_change_password FROM app_user WHERE person_id IN (:dup, :keep)`,
            { dup: duplicateId, keep: keepId },
            opts,
        );
        const dupUser = users.find((u) => u.person_id === duplicateId);
        const keepUser = users.find((u) => u.person_id === keepId);
        let loginMoved = false;
        if (dupUser) {
            const dupUsed = !dupUser.must_change_password;
            const keepUsed = keepUser ? !keepUser.must_change_password : false;
            if (keepUser && dupUsed && keepUsed) {
                throw new AppError(
                    `${displayName(dup)} and ${displayName(keep)} both have logins that have been used. Decide which login to keep before merging.`,
                    409,
                    'ERR_MERGE_LOGINS',
                );
            }
            if (!keepUser || (dupUsed && !keepUsed)) {
                if (keepUser) await execute(`DELETE FROM app_user WHERE id = :id`, { id: keepUser.id }, opts);
                await execute(`UPDATE app_user SET person_id = :keep WHERE id = :id`, { keep: keepId, id: dupUser.id }, opts);
                loginMoved = true;
            } else {
                await execute(`DELETE FROM app_user WHERE id = :id`, { id: dupUser.id }, opts);
            }
        }

        // 5. Retire the duplicate.
        await execute(
            `UPDATE person SET is_deleted = true, updated_by = :by, updated_at = NOW() WHERE id = :id`,
            { id: duplicateId, by: mergedBy },
            opts,
        );

        const result = {
            keptId: keepId,
            movedLinks: Math.ceil(movedRows / 2),
            droppedLinks: Math.ceil(droppedRows / 2),
            loginMoved,
        };
        log.info('Merged duplicate person', { duplicateId, keepId, ...result });
        return result;
    });
}
