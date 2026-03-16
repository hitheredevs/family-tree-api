import bcrypt from 'bcryptjs';
import { URL } from 'node:url';
import { queryOne, queryAll, execute } from '../db/connection.js';
import {
    AppError,
    type PasswordLinkPurpose,
    type UserRow,
    type UserResponse,
} from '../types/index.js';
import { createLogger } from '../utils/logger.js';
import {
    generatePasswordLinkToken,
    hashPasswordLinkToken,
} from '../utils/password-link.js';

const log = createLogger('admin-service');
const PASSWORD_LINK_EXPIRY_MS: Record<PasswordLinkPurpose, number> = {
    'setup-password': 24 * 60 * 60 * 1000,
    'reset-password': 60 * 60 * 1000,
};

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

function slugifyUsernamePart(value: string): string {
    return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

async function generateUniqueUsername(firstName: string, lastName: string): Promise<string> {
    const baseUsername =
        [slugifyUsernamePart(firstName), slugifyUsernamePart(lastName)]
            .filter(Boolean)
            .join('') || 'member';

    let username = baseUsername;
    let suffix = 1;

    while (true) {
        const taken = await queryOne<{ id: string }>(
            `SELECT id FROM app_user WHERE username = :username`,
            { username },
        );
        if (!taken) {
            return username;
        }
        username = `${baseUsername}${suffix}`;
        suffix += 1;
    }
}

async function getOrCreateUserForSetup(personId: string): Promise<UserRow> {
    const existingUser = await queryOne<UserRow>(
        `SELECT * FROM app_user WHERE person_id = :personId`,
        { personId },
    );
    if (existingUser) {
        return existingUser;
    }

    const person = await queryOne<{ first_name: string; last_name: string }>(
        `SELECT first_name, last_name
         FROM person
         WHERE id = :personId AND is_deleted = false`,
        { personId },
    );

    if (!person) {
        throw new AppError('Person not found', 404, 'ERR_NOT_FOUND');
    }

    const username = await generateUniqueUsername(person.first_name, person.last_name);
    const temporaryPasswordHash = await bcrypt.hash(generatePasswordLinkToken(), 12);

    const user = await queryOne<UserRow>(
        `INSERT INTO app_user (username, password_hash, role, must_change_password, person_id)
         VALUES (:username, :passwordHash, 'member', true, :personId)
         RETURNING *`,
        {
            username,
            passwordHash: temporaryPasswordHash,
            personId,
        },
    );

    if (!user) {
        throw new AppError('Failed to create user', 500, 'ERR_CREATE_USER');
    }

    log.info('Auto-created user for setup link', { personId, userId: user.id, username });
    return user;
}

function buildPasswordLink(rawToken: string, username: string, purpose: PasswordLinkPurpose): string {
    const baseUrl = process.env.UI_BASE_URL ?? 'http://localhost:5173';
    const url = new URL(baseUrl);
    url.searchParams.set('credentialToken', rawToken);
    url.searchParams.set('username', username);
    url.searchParams.set('purpose', purpose);
    return url.toString();
}

export async function generatePasswordLink(data: {
    personId: string;
    purpose: PasswordLinkPurpose;
    createdByUserId: string;
}): Promise<{
    link: string;
    username: string;
    expiresAt: string;
    purpose: PasswordLinkPurpose;
}> {
    const person = await queryOne<{ id: string }>(
        `SELECT id FROM person WHERE id = :personId AND is_deleted = false`,
        { personId: data.personId },
    );

    if (!person) {
        throw new AppError('Person not found', 404, 'ERR_NOT_FOUND');
    }

    let user = await queryOne<UserRow>(
        `SELECT * FROM app_user WHERE person_id = :personId`,
        { personId: data.personId },
    );

    if (!user && data.purpose === 'setup-password') {
        user = await getOrCreateUserForSetup(data.personId);
    }

    if (!user) {
        throw new AppError(
            'This person does not have a user account yet',
            404,
            'ERR_NO_USER_ACCOUNT',
        );
    }

    await execute(
        `DELETE FROM password_link_token
         WHERE user_id = :userId
           AND used_at IS NULL
           AND expires_at > NOW()`,
        { userId: user.id },
    );

    const rawToken = generatePasswordLinkToken();
    const tokenHash = hashPasswordLinkToken(rawToken);
    const expiresAt = new Date(
        Date.now() + PASSWORD_LINK_EXPIRY_MS[data.purpose],
    ).toISOString();

    await execute(
        `INSERT INTO password_link_token (user_id, purpose, token_hash, expires_at, created_by)
         VALUES (:userId, :purpose, :tokenHash, :expiresAt, :createdBy)`,
        {
            userId: user.id,
            purpose: data.purpose,
            tokenHash,
            expiresAt,
            createdBy: data.createdByUserId,
        },
    );

    log.info('Password link generated', {
        userId: user.id,
        username: user.username,
        purpose: data.purpose,
        expiresAt,
        createdBy: data.createdByUserId,
    });

    return {
        link: buildPasswordLink(rawToken, user.username, data.purpose),
        username: user.username,
        expiresAt,
        purpose: data.purpose,
    };
}
