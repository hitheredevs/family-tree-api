import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { execute, queryOne } from '../db/connection.js';
import {
    AppError,
    type AuthPayload,
    type OtpPurpose,
    type OtpRequestRow,
    type UserResponse,
    type UserRow,
} from '../types/index.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('auth-service');

const JWT_SECRET = process.env.JWT_SECRET ?? 'fallback-secret';
const TOKEN_EXPIRY = '7d';
const OTP_EXPIRY_MINUTES = 10;

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

function generateOtp(): string {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

async function createOtpRequest(
    userId: string,
    phoneNumber: string,
    purpose: OtpPurpose,
): Promise<string> {
    const otpCode = generateOtp();
    await execute(
        `INSERT INTO otp_request (user_id, phone_number, purpose, otp_code, expires_at)
         VALUES (:userId, :phoneNumber, :purpose, :otpCode, NOW() + INTERVAL '${OTP_EXPIRY_MINUTES} minutes')`,
        { userId, phoneNumber, purpose, otpCode },
    );
    return otpCode;
}

/**
 * Send an SMS OTP using Fast2SMS (India-native, no DLT registration required
 * for the OTP route). Set FAST2SMS_API_KEY in the API .env file.
 *
 * phoneNumber is expected in E.164 format: +919876543210
 * Fast2SMS needs the raw 10-digit number: 9876543210
 */
async function sendSmsOtp(
    phoneNumber: string,
    otp: string,
): Promise<void> {
    const apiKey = process.env.FAST2SMS_API_KEY;
    if (!apiKey) {
        // In development without a key, just log and continue so the rest of
        // the flow works; the OTP is still stored in the DB.
        log.warn('FAST2SMS_API_KEY not set — OTP not sent via SMS', { otp });
        return;
    }

    // Strip country code to get the 10-digit number Fast2SMS expects
    const digits = phoneNumber.replace(/^\+91/, '').replace(/\D/g, '');

    const res = await fetch('https://www.fast2sms.com/dev/bulkV2', {
        method: 'POST',
        headers: {
            authorization: apiKey,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            route: 'otp',
            variables_values: otp,
            numbers: digits,
        }),
    });

    if (!res.ok) {
        const body = await res.text().catch(() => '');
        log.error('Fast2SMS error', { status: res.status, body });
        // Don't throw — the OTP is in the DB; user can retry
    }
}

async function getLatestOtpRequest(
    userId: string,
    purpose: OtpPurpose,
): Promise<OtpRequestRow> {
    const row = await queryOne<OtpRequestRow>(
        `SELECT *
         FROM otp_request
         WHERE user_id = :userId
           AND purpose = :purpose
           AND verified_at IS NULL
           AND expires_at > NOW()
         ORDER BY created_at DESC
         LIMIT 1`,
        { userId, purpose },
    );

    if (!row) {
        throw new AppError('Please request a new OTP first', 400, 'ERR_OTP_REQUIRED');
    }

    return row;
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

    if (row.must_change_password && !row.phone_verified) {
        throw new AppError(
            'Verify your phone number with OTP before changing the default password',
            400,
            'ERR_PHONE_NOT_VERIFIED',
        );
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

export async function requestPhoneVerificationOtp(
    userId: string,
    phoneNumber: string,
): Promise<{ message: string; phoneNumber: string }> {
    if (!phoneNumber?.trim()) {
        throw new AppError('Phone number is required', 400, 'ERR_VALIDATION');
    }

    const user = await getUserWithPersonByUserId(userId);

    await execute(
        `UPDATE person
         SET phone_number = :phoneNumber,
             phone_verified = false,
             phone_verified_at = NULL,
             updated_at = NOW()
         WHERE id = :personId`,
        { phoneNumber, personId: user.person_id },
    );

    await createOtpRequest(user.id, phoneNumber, 'verify-phone');

    return { message: 'OTP sent successfully', phoneNumber };
}

export async function verifyPhoneOtp(
    userId: string,
    otp: string,
): Promise<UserResponse> {
    if (!otp?.trim()) {
        throw new AppError('OTP is required', 400, 'ERR_VALIDATION');
    }

    const request = await getLatestOtpRequest(userId, 'verify-phone');

    await execute(
        `UPDATE otp_request
         SET verified_at = NOW(), updated_at = NOW()
         WHERE id = :id`,
        { id: request.id },
    );

    const user = await getUserWithPersonByUserId(userId);
    await execute(
        `UPDATE person
         SET phone_verified = true,
             phone_verified_at = NOW(),
             updated_at = NOW()
         WHERE id = :personId`,
        { personId: user.person_id },
    );

    return toUserResponse(await getUserWithPersonByUserId(userId));
}

export async function requestPasswordResetOtp(
    username: string,
    phoneNumber: string,
): Promise<{ message: string }> {
    if (!username?.trim() || !phoneNumber?.trim()) {
        throw new AppError('Username and phone number are required', 400, 'ERR_VALIDATION');
    }

    const user = await getUserWithPersonByUsername(username);
    if (user.phone_number !== phoneNumber) {
        throw new AppError('Username and phone number do not match', 400, 'ERR_VALIDATION');
    }

    const otp = await createOtpRequest(user.id, phoneNumber, 'reset-password');
    await sendSmsOtp(phoneNumber, otp);
    return { message: 'OTP sent successfully' };
}

export async function resetPasswordWithOtp(
    username: string,
    phoneNumber: string,
    otp: string,
    newPassword: string,
): Promise<void> {
    if (!username?.trim() || !phoneNumber?.trim() || !otp?.trim()) {
        throw new AppError(
            'Username, phone number and OTP are required',
            400,
            'ERR_VALIDATION',
        );
    }

    if (newPassword.length < 6) {
        throw new AppError(
            'New password must be at least 6 characters',
            400,
            'ERR_VALIDATION',
        );
    }

    const user = await getUserWithPersonByUsername(username);
    if (user.phone_number !== phoneNumber) {
        throw new AppError('Username and phone number do not match', 400, 'ERR_VALIDATION');
    }

    const request = await getLatestOtpRequest(user.id, 'reset-password');
    if (request.phone_number !== phoneNumber) {
        throw new AppError('OTP request does not match the phone number', 400, 'ERR_VALIDATION');
    }

    await execute(
        `UPDATE otp_request
         SET verified_at = NOW(), updated_at = NOW()
         WHERE id = :id`,
        { id: request.id },
    );

    const newHash = await bcrypt.hash(newPassword, 12);
    await execute(
        `UPDATE app_user
         SET password_hash = :newHash,
             must_change_password = false,
             updated_at = NOW()
         WHERE id = :userId`,
        { newHash, userId: user.id },
    );
}

/**
 * Reset password after the caller has verified identity via WhatsApp (OTpless).
 * The whatsappPhone is the E.164 number returned by OTpless — it is already
 * verified to be owned by the person holding that WhatsApp account.
 */
export async function resetPasswordWithWhatsApp(
    username: string,
    whatsappPhone: string,
    newPassword: string,
): Promise<void> {
    if (!username?.trim() || !whatsappPhone?.trim()) {
        throw new AppError('Username and phone number are required', 400, 'ERR_VALIDATION');
    }

    if (newPassword.length < 6) {
        throw new AppError('New password must be at least 6 characters', 400, 'ERR_VALIDATION');
    }

    const user = await getUserWithPersonByUsername(username);
    if (user.phone_number !== whatsappPhone) {
        throw new AppError(
            'The WhatsApp number does not match the records for this username',
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
        { newHash, userId: user.id },
    );
}
