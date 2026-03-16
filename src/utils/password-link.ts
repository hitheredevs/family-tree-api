import { createHash, randomBytes } from 'node:crypto';

export function generatePasswordLinkToken(): string {
    return randomBytes(32).toString('hex');
}

export function hashPasswordLinkToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
}
