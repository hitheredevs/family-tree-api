import type { Request } from 'express';

/* ------------------------------------------------------------------ */
/*  DB row types (snake_case, matching PostgreSQL columns)              */
/* ------------------------------------------------------------------ */

export interface PersonRow {
    id: string;
    first_name: string;
    last_name: string;
    gender: 'male' | 'female' | 'other';
    is_deceased: boolean;
    birth_date: string | null;
    death_year: number | null;
    bio: string | null;
    phone_number: string | null;
    social_links: { type: string; url: string; handle: string }[] | null;
    phone_verified: boolean;
    phone_verified_at: string | null;
    location: string | null;
    is_deleted: boolean;
    created_by: string | null;
    updated_by: string | null;
    created_at: string;
    updated_at: string;
}

export type RelationshipType = 'PARENT' | 'CHILD' | 'SPOUSE';

export type RelationshipStatus = 'confirmed' | 'pending' | 'divorced';

export interface RelationshipRow {
    id: string;
    source_person_id: string;
    target_person_id: string;
    relationship_type: RelationshipType;
    status: RelationshipStatus;
    created_by: string | null;
    created_at: string;
    updated_at: string;
}

export type UserRole = 'admin' | 'member';

export interface UserRow {
    id: string;
    username: string;
    password_hash: string;
    role: UserRole;
    must_change_password: boolean;
    person_id: string;
    phone_number?: string | null;
    phone_verified?: boolean;
    created_at: string;
    updated_at: string;
}

export type PasswordLinkPurpose = 'setup-password' | 'reset-password';

export interface PasswordLinkTokenRow {
    id: string;
    user_id: string;
    purpose: PasswordLinkPurpose;
    token_hash: string;
    expires_at: string;
    used_at: string | null;
    created_by: string | null;
    created_at: string;
    updated_at: string;
}

/* ------------------------------------------------------------------ */
/*  API response types (camelCase for JSON responses)                   */
/* ------------------------------------------------------------------ */

export interface PersonResponse {
    id: string;
    firstName: string;
    lastName: string;
    gender: string;
    isDeceased: boolean;
    birthDate?: string | null;
    deathYear?: number | null;
    bio?: string | null;
    phoneNumber?: string | null;
    socialLinks?: { type: string; url: string; handle: string }[] | null;
    phoneVerified?: boolean;
    location?: string | null;
    createdBy: string | null;
    updatedBy: string | null;
    createdAt: string;
    updatedAt: string;
}

export interface TreePerson extends PersonResponse {
    parentIds: string[];
    spouseIds: string[];
    exSpouseIds: string[];
    childrenIds: string[];
}

/** Slim tree node — only the fields needed for layout + node rendering */
export interface TreePersonLayout {
    id: string;
    firstName: string;
    lastName: string;
    gender: string;
    isDeceased: boolean;
    parentIds: string[];
    spouseIds: string[];
    exSpouseIds: string[];
    childrenIds: string[];
}

export interface UserResponse {
    id: string;
    username: string;
    role: UserRole;
    mustChangePassword: boolean;
    personId: string;
    phoneNumber?: string | null;
    phoneVerified?: boolean;
}

/* ------------------------------------------------------------------ */
/*  Auth types                                                         */
/* ------------------------------------------------------------------ */

export interface AuthPayload {
    userId: string;
    personId: string;
    role: UserRole;
}

export interface AuthenticatedRequest extends Request {
    user?: AuthPayload;
}

/* ------------------------------------------------------------------ */
/*  Error                                                              */
/* ------------------------------------------------------------------ */

export class AppError extends Error {
    public statusCode: number;
    public code: string;

    constructor(message: string, statusCode: number, code?: string) {
        super(message);
        this.name = 'AppError';
        this.statusCode = statusCode;
        this.code = code ?? 'ERR_UNKNOWN';
    }
}
