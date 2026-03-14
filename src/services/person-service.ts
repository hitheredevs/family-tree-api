import bcrypt from 'bcryptjs';
import { execute, queryAll, queryOne } from '../db/connection.js';
import {
    AppError,
    type PersonResponse,
    type PersonRow,
} from '../types/index.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('person-service');

type SocialLink = { type: string; url: string; handle: string };

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
}): Promise<PersonResponse> {
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
            phoneNumber: data.phoneNumber ?? null,
            socialLinks: JSON.stringify(data.socialLinks ?? null),
            location: data.location ?? null,
            createdBy: data.createdBy,
        },
    );

    if (!row) throw new AppError('Failed to create person', 500);

    try {
        const baseName = data.firstName.toLowerCase().replace(/[^a-z0-9]/g, '');
        let username = baseName;
        let suffix = 1;

        while (true) {
            const taken = await queryOne(
                `SELECT id FROM app_user WHERE username = :username`,
                { username },
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
        );

        log.info('Auto-created user for person', { username, personId: row.id, firstName: data.firstName });
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
        data.phoneNumber !== undefined ? data.phoneNumber : existing.phone_number;

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
    await execute(`DELETE FROM app_user WHERE person_id = :id`, { id });

    await execute(
        `DELETE FROM relationship WHERE source_person_id = :id OR target_person_id = :id`,
        { id },
    );

    await execute(
        `UPDATE person SET is_deleted = true, updated_at = NOW() WHERE id = :id`,
        { id },
    );
}
