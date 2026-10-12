/**
 * In-memory copy of the whole family (people + links) for the AI
 * assistant's tools. Loaded with two flat queries and reused until the
 * data changes — a cheap fingerprint query (counts + last update times)
 * is checked at most every few seconds.
 */

import { queryAll, queryOne } from '../db/connection.js';
import type { KinPerson } from './kinship.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('family-graph');

const FINGERPRINT_CHECK_MS = 5000;

export interface GraphPerson extends KinPerson {
    id: string;
    /** Short id used in AI tool output and [[NAME|id]] mentions */
    ref: string;
    name: string;
    gender: 'male' | 'female' | 'other';
    isDeceased: boolean;
    birthDate: string | null;
    deathYear: number | null;
    location: string | null;
    bio: string | null;
    parentIds: string[];
    childrenIds: string[];
    spouseIds: string[];
    exSpouseIds: string[];
}

export interface FamilyGraph {
    people: Map<string, GraphPerson>;
    /** short ref → full id */
    byRef: Map<string, string>;
    fingerprint: string;
}

interface PersonGraphRow {
    id: string;
    first_name: string;
    last_name: string | null;
    gender: 'male' | 'female' | 'other';
    is_deceased: boolean;
    birth_date: string | null;
    death_year: number | null;
    location: string | null;
    bio: string | null;
}

interface RelGraphRow {
    source_person_id: string;
    target_person_id: string;
    relationship_type: 'PARENT' | 'CHILD' | 'SPOUSE';
    status: string | null;
}

let cached: FamilyGraph | null = null;
let checkedAt = 0;
let loading: Promise<FamilyGraph> | null = null;

async function readFingerprint(): Promise<string> {
    const row = await queryOne<{ fp: string }>(
        `SELECT concat_ws(':',
            (SELECT count(*) FROM person),
            (SELECT max(updated_at) FROM person),
            (SELECT count(*) FROM relationship),
            (SELECT max(updated_at) FROM relationship)) AS fp`,
    );
    return row?.fp ?? '';
}

async function loadGraph(fingerprint: string): Promise<FamilyGraph> {
    const started = Date.now();
    const [rows, rels] = await Promise.all([
        queryAll<PersonGraphRow>(
            `SELECT id, first_name, last_name, gender, is_deceased, birth_date,
                    death_year, location, bio
             FROM person WHERE is_deleted = false`,
        ),
        queryAll<RelGraphRow>(
            `SELECT r.source_person_id, r.target_person_id, r.relationship_type, r.status
             FROM relationship r
             JOIN person s ON s.id = r.source_person_id AND s.is_deleted = false
             JOIN person t ON t.id = r.target_person_id AND t.is_deleted = false`,
        ),
    ]);

    const people = new Map<string, GraphPerson>();
    for (const r of rows) {
        people.set(r.id, {
            id: r.id,
            ref: r.id.slice(0, 8),
            name: `${r.first_name ?? ''} ${r.last_name ?? ''}`.trim() || 'UNNAMED',
            gender: r.gender,
            isDeceased: r.is_deceased,
            birthDate: r.birth_date,
            deathYear: r.death_year,
            location: r.location?.trim() || null,
            bio: r.bio?.trim() || null,
            parentIds: [],
            childrenIds: [],
            spouseIds: [],
            exSpouseIds: [],
        });
    }

    for (const r of rels) {
        const p = people.get(r.source_person_id);
        if (!p) continue;
        if (r.relationship_type === 'CHILD') p.parentIds.push(r.target_person_id);
        else if (r.relationship_type === 'PARENT') p.childrenIds.push(r.target_person_id);
        else if (r.status === 'divorced') p.exSpouseIds.push(r.target_person_id);
        else p.spouseIds.push(r.target_person_id);
    }

    // Short refs: 8 hex chars, longer only where two ids share a prefix
    const byPrefix = new Map<string, string[]>();
    for (const id of people.keys()) {
        const key = id.slice(0, 8);
        byPrefix.set(key, [...(byPrefix.get(key) ?? []), id]);
    }
    const byRef = new Map<string, string>();
    for (const [prefix, ids] of byPrefix) {
        if (ids.length === 1) {
            byRef.set(prefix, ids[0]);
            continue;
        }
        for (const id of ids) {
            const ref = id.replace(/-/g, '').slice(0, 12);
            people.get(id)!.ref = ref;
            byRef.set(ref, id);
        }
    }

    log.info('Family graph loaded', {
        people: people.size,
        relationships: rels.length,
        ms: Date.now() - started,
    });
    return { people, byRef, fingerprint };
}

export async function getFamilyGraph(): Promise<FamilyGraph> {
    if (cached && Date.now() - checkedAt < FINGERPRINT_CHECK_MS) return cached;
    if (loading) return loading;

    loading = (async () => {
        try {
            const fingerprint = await readFingerprint();
            checkedAt = Date.now();
            if (cached && cached.fingerprint === fingerprint) return cached;
            cached = await loadGraph(fingerprint);
            return cached;
        } finally {
            loading = null;
        }
    })();
    return loading;
}

/** Resolve a full uuid, a short ref, or any unique id prefix. */
export function resolvePersonId(graph: FamilyGraph, idOrRef: string | undefined | null): string | null {
    if (!idOrRef) return null;
    const key = String(idOrRef).trim().toLowerCase().replace(/^\[+|\]+$/g, '');
    if (graph.people.has(key)) return key;
    const byRef = graph.byRef.get(key) ?? graph.byRef.get(key.replace(/-/g, ''));
    if (byRef) return byRef;
    if (key.length >= 6) {
        const matches = [...graph.people.keys()].filter((id) => id.startsWith(key));
        if (matches.length === 1) return matches[0];
    }
    return null;
}
