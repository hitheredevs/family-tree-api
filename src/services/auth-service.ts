import bcrypt from 'bcryptjs';
import { getDb, execute, queryOne } from '../db/connection.js';
import jwt from 'jsonwebtoken';
import {
    AppError,
    type AuthPayload,
    type PasswordLinkPurpose,
    type PasswordLinkTokenRow,
    type UserResponse,
    type UserRow,
} from '../types/index.js';
import { createLogger } from '../utils/logger.js';
import { hashPasswordLinkToken } from '../utils/password-link.js';

const log = createLogger('auth-service');

const JWT_SECRET = process.env.JWT_SECRET ?? 'fallback-secret';
const TOKEN_EXPIRY = '7d';

function normalizePhoneNumber(phoneNumber: string): string {
    const normalized = phoneNumber.trim().replace(/[\s()-]/g, '');

    if (!normalized) {
        throw new AppError('Phone number is required', 400, 'ERR_VALIDATION');
    }

    return normalized;
}

function toUserResponse(row: UserRow): UserResponse {
    return {
        id: row.id,
        username: row.username,
        role: row.role,
        mustChangePassword: row.must_change_password,
        personId: row.person_id,
        phoneNumber: row.phone_number ?? null,
        phoneVerified: row.phone_verified ?? false,
    };
}

async function getUserWithPersonByUserId(userId: string): Promise<UserRow> {
    const row = await queryOne<UserRow>(
        `SELECT u.*, p.phone_number, p.phone_verified
         FROM app_user u
         INNER JOIN person p ON p.id = u.person_id
         WHERE u.id = :userId`,
        { userId },
    );

    if (!row) {
        log.warn('User not found by userId', { userId });
        throw new AppError('User not found', 404, 'ERR_NOT_FOUND');
    }

    return row;
}

async function getUserWithPersonByUsername(username: string): Promise<UserRow> {
    const row = await queryOne<UserRow>(
        `SELECT u.*, p.phone_number, p.phone_verified
         FROM app_user u
         INNER JOIN person p ON p.id = u.person_id
         WHERE u.username = :username`,
        { username },
    );

    if (!row) {
        log.warn('User not found by username', { username });
        throw new AppError('Invalid username or password', 401, 'ERR_AUTH');
    }

    return row;
}

type PasswordLinkLookupRow = PasswordLinkTokenRow & {
    username: string;
    person_id: string;
    phone_number: string | null;
};

async function getPasswordLinkByToken(token: string): Promise<PasswordLinkLookupRow> {
    if (!token?.trim()) {
        throw new AppError('Password link token is required', 400, 'ERR_VALIDATION');
    }

    const tokenHash = hashPasswordLinkToken(token.trim());
    const row = await queryOne<PasswordLinkLookupRow>(
        `SELECT plt.*, u.username, u.person_id, p.phone_number
         FROM password_link_token plt
         INNER JOIN app_user u ON u.id = plt.user_id
                 INNER JOIN person p ON p.id = u.person_id
         WHERE plt.token_hash = :tokenHash
           AND plt.used_at IS NULL
           AND plt.expires_at > NOW()`,
        { tokenHash },
    );

    if (!row) {
        throw new AppError('This password link is invalid or expired', 400, 'ERR_LINK_INVALID');
    }

    return row;
}

async function assertPhoneNumberAvailable(
    phoneNumber: string,
    currentPersonId?: string,
): Promise<void> {
    const existing = await queryOne<{ id: string }>(
        `SELECT id
         FROM person
         WHERE phone_number = :phoneNumber
           AND is_deleted = false
           AND (:currentPersonId::uuid IS NULL OR id != :currentPersonId::uuid)
         LIMIT 1`,
        {
            phoneNumber,
            currentPersonId: currentPersonId ?? null,
        },
    );

    if (existing) {
        throw new AppError(
            'This phone number is already being used by another person',
            409,
            'ERR_DUPLICATE_PHONE',
        );
    }
}

export async function login(
    username: string,
    password: string,
): Promise<{ token: string; user: UserResponse }> {
    log.info('Login service called', { username });
    const row = await getUserWithPersonByUsername(username);

    const valid = await bcrypt.compare(password, row.password_hash);
    if (!valid) {
        log.warn('Invalid password for user', { username, userId: row.id });
        throw new AppError('Invalid username or password', 401, 'ERR_AUTH');
    }

    const payload: AuthPayload = {
        userId: row.id,
        personId: row.person_id,
        role: row.role,
    };

    const token = jwt.sign(payload, JWT_SECRET, { expiresIn: TOKEN_EXPIRY });
    log.info('JWT issued', { userId: row.id, role: row.role });

    return {
        token,
        user: toUserResponse(row),
    };
}

export async function getCurrentUser(userId: string): Promise<UserResponse> {
    log.info('getCurrentUser called', { userId });
    return toUserResponse(await getUserWithPersonByUserId(userId));
}

export async function changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
): Promise<void> {
    const row = await getUserWithPersonByUserId(userId);

    const valid = await bcrypt.compare(currentPassword, row.password_hash);
    if (!valid) {
        throw new AppError('Current password is incorrect', 400, 'ERR_BAD_PASSWORD');
    }

    if (newPassword.length < 6) {
        throw new AppError(
            'New password must be at least 6 characters',
            400,
            'ERR_VALIDATION',
        );
    }

    const newHash = await bcrypt.hash(newPassword, 12);

    await execute(
        `UPDATE app_user
         SET password_hash = :newHash,
             must_change_password = false,
             updated_at = NOW()
         WHERE id = :userId`,
        { newHash, userId },
    );
}

export async function getPasswordLinkDetails(token: string): Promise<{
    username: string;
    purpose: PasswordLinkPurpose;
    expiresAt: string;
}> {
    const row = await getPasswordLinkByToken(token);
    return {
        username: row.username,
        purpose: row.purpose,
        expiresAt: row.expires_at,
    };
}

export async function consumePasswordLink(
    token: string,
    newPassword: string,
    phoneNumber: string,
): Promise<{ message: string }> {
    if (!newPassword?.trim() || newPassword.length < 6) {
        throw new AppError('New password must be at least 6 characters', 400, 'ERR_VALIDATION');
    }

    const link = await getPasswordLinkByToken(token);
    const normalizedPhoneNumber = normalizePhoneNumber(phoneNumber);

    if (link.purpose === 'reset-password') {
        if (!link.phone_number) {
            throw new AppError(
                'No phone number is saved on this profile. Ask an admin to generate a setup link instead.',
                400,
                'ERR_PHONE_REQUIRED',
            );
        }

        if (normalizePhoneNumber(link.phone_number) !== normalizedPhoneNumber) {
            throw new AppError(
                'The phone number does not match this user profile',
                400,
                'ERR_PHONE_MISMATCH',
            );
        }
    } else {
        await assertPhoneNumberAvailable(normalizedPhoneNumber, link.person_id);
    }

    const newHash = await bcrypt.hash(newPassword, 12);
    const db = await getDb();
    const transaction = await db.transaction();

    try {
        await db.query(
            `UPDATE person
             SET phone_number = :phoneNumber,
                 phone_verified = false,
                 updated_at = NOW()
             WHERE id = :personId`,
            {
                replacements: {
                    phoneNumber: normalizedPhoneNumber,
                    personId: link.person_id,
                },
                transaction,
            },
        );

        await db.query(
            `UPDATE app_user
             SET password_hash = :newHash,
                 must_change_password = false,
                 updated_at = NOW()
             WHERE id = :userId`,
            {
                replacements: { newHash, userId: link.user_id },
                transaction,
            },
        );

        await db.query(
            `UPDATE password_link_token
             SET used_at = NOW(), updated_at = NOW()
             WHERE id = :id`,
            {
                replacements: { id: link.id },
                transaction,
            },
        );

        await db.query(
            `DELETE FROM password_link_token
             WHERE user_id = :userId
               AND id != :id
               AND used_at IS NULL`,
            {
                replacements: { userId: link.user_id, id: link.id },
                transaction,
            },
        );

        await transaction.commit();
        log.info('Password link consumed', {
            userId: link.user_id,
            username: link.username,
            purpose: link.purpose,
        });
        return { message: 'Password updated successfully' };
    } catch (err) {
        await transaction.rollback();
        throw err;
    }
}
