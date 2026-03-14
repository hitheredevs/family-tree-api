import bcrypt from 'bcryptjs';
import { queryOne, queryAll, execute } from '../db/connection.js';
import { AppError, type UserRow, type UserResponse } from '../types/index.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('admin-service');

/* ------------------------------------------------------------------ */
/*  Create a user account for an existing person                       */
/* ------------------------------------------------------------------ */

export async function createUser(data: {
    username: string;
    password: string;
    role: 'admin' | 'member';
    personId: string;
}): Promise<UserResponse> {
    // Ensure person exists
    const person = await queryOne(
        `SELECT id FROM person WHERE id = :id AND is_deleted = false`,
        { id: data.personId },
    );
    if (!person) {
        throw new AppError('Person not found', 404, 'ERR_NOT_FOUND');
    }

    // Ensure person doesn't already have a user
    const existing = await queryOne(
        `SELECT id FROM app_user WHERE person_id = :personId`,
        { personId: data.personId },
    );
    if (existing) {
        throw new AppError(
            'This person already has a user account',
            409,
            'ERR_DUPLICATE_USER',
        );
    }

    // Ensure username is unique
    const usernameTaken = await queryOne(
        `SELECT id FROM app_user WHERE username = :username`,
        { username: data.username },
    );
    if (usernameTaken) {
        throw new AppError('Username already taken', 409, 'ERR_DUPLICATE_USERNAME');
    }

    const passwordHash = await bcrypt.hash(data.password, 12);

    const row = await queryOne<UserRow>(
        `INSERT INTO app_user (username, password_hash, role, must_change_password, person_id)
     VALUES (:username, :passwordHash, :role, true, :personId)
     RETURNING *`,
        {
            username: data.username,
            passwordHash,
            role: data.role,
            personId: data.personId,
        },
    );

    if (!row) throw new AppError('Failed to create user', 500);

    log.info('User created in admin-service', { userId: row.id, username: row.username, role: row.role });
    return {
        id: row.id,
        username: row.username,
        role: row.role,
        mustChangePassword: row.must_change_password,
        personId: row.person_id,
    };
}

/* ------------------------------------------------------------------ */
/*  List all users                                                     */
/* ------------------------------------------------------------------ */

export async function listUsers(): Promise<
    (UserResponse & { personFirstName: string; personLastName: string })[]
> {
    const rows = await queryAll<
        UserRow & { person_first_name: string; person_last_name: string }
    >(
        `SELECT u.*, p.first_name AS person_first_name, p.last_name AS person_last_name
     FROM app_user u
     INNER JOIN person p ON p.id = u.person_id
     WHERE p.is_deleted = false
     ORDER BY u.created_at`,
    );

    return rows.map((r) => ({
        id: r.id,
        username: r.username,
        role: r.role,
        mustChangePassword: r.must_change_password,
        personId: r.person_id,
        personFirstName: r.person_first_name,
        personLastName: r.person_last_name,
    }));
}
