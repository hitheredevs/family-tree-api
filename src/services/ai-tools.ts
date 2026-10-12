/**
 * Tools the AI assistant can call to read the family tree. Every fact in
 * an answer comes from here; the model never sees the raw tables.
 *
 * Output is compact JSON keyed by short person refs (see family-graph).
 * Phone numbers and social links are never exposed to the model.
 */

import {
    getFamilyGraph,
    resolvePersonId,
    type FamilyGraph,
    type GraphPerson,
} from './family-graph.js';
import { describeKinship } from './kinship.js';

/* ------------------------------------------------------------------ */
/*  Tool schemas (OpenAI-compatible function calling)                  */
/* ------------------------------------------------------------------ */

const RELATIONS = [
    'parents',
    'children',
    'spouses',
    'siblings',
    'grandparents',
    'grandchildren',
    'aunts_uncles',
    'nephews_nieces',
    'cousins',
    'in_laws',
    'ancestors',
    'descendants',
] as const;
type Relation = (typeof RELATIONS)[number];

export const AI_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'search_people',
            description:
                "Find people by name (spelling-tolerant). Add the father's name after the person's name to narrow it down, e.g. 'musaiyab saleem'. Returns each match with id, father and mother so same-name people can be told apart.",
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'Name to look for' },
                    limit: { type: 'integer', description: 'Max results (default 8, max 25)' },
                },
                required: ['query'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'get_person',
            description:
                'Full profile of one person: status, birthday, location, bio, parents, spouses, children, siblings, grandparents and descendant counts.',
            parameters: {
                type: 'object',
                properties: { id: { type: 'string', description: 'Person id from another tool' } },
                required: ['id'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'find_relationship',
            description:
                'Exactly how two people are related. Answers "what is person_b to person_a" (e.g. paternal uncle / Chacha), with the chain of links between them. Always use this for kinship questions instead of working it out yourself.',
            parameters: {
                type: 'object',
                properties: {
                    person_a: { type: 'string', description: 'Id of the reference person (often the user)' },
                    person_b: { type: 'string', description: 'Id of the other person' },
                },
                required: ['person_a', 'person_b'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'list_relatives',
            description:
                'List one kind of relative of a person. cousins = first cousins; in_laws = spouse\'s parents and siblings, siblings\' spouses, children\'s spouses; ancestors/descendants include the generation number.',
            parameters: {
                type: 'object',
                properties: {
                    id: { type: 'string' },
                    relation: { type: 'string', enum: [...RELATIONS] },
                    limit: { type: 'integer', description: 'Max people returned (default 60, max 300)' },
                },
                required: ['id', 'relation'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'find_people',
            description:
                'Filter the whole family: by location, gender, living/deceased, birthday month or upcoming birthdays, number of children, bio text, or people with no parents recorded. Returns a count and a list.',
            parameters: {
                type: 'object',
                properties: {
                    name_contains: { type: 'string' },
                    location_contains: { type: 'string' },
                    bio_contains: { type: 'string' },
                    gender: { type: 'string', enum: ['male', 'female'] },
                    living: { type: 'boolean', description: 'true = living only, false = deceased only' },
                    birthday_month: { type: 'integer', description: '1-12' },
                    birthday_within_days: { type: 'integer', description: 'Birthdays in the next N days (from today)' },
                    min_children: { type: 'integer' },
                    has_parents: { type: 'boolean', description: 'false = people with no parents recorded' },
                    limit: { type: 'integer', description: 'Max people returned (default 30, max 150)' },
                },
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'family_stats',
            description:
                'Overview of the whole tree: totals, living/deceased, men/women, generations, who has the most children / grandchildren / descendants, common places, birthdays recorded and upcoming birthdays.',
            parameters: { type: 'object', properties: {} },
        },
    },
];

/** Short line shown in the chat while a tool runs, e.g. "Searching for FAZAL…" */
export function describeToolCall(name: string, args: Record<string, unknown>, graph?: FamilyGraph): string {
    const nameOf = (v: unknown) => {
        if (!graph) return 'someone';
        const id = resolvePersonId(graph, String(v ?? ''));
        return id ? graph.people.get(id)!.name : 'someone';
    };
    switch (name) {
        case 'search_people':
            return `Searching for ${String(args.query ?? '').toUpperCase()}`;
        case 'get_person':
            return `Reading ${nameOf(args.id)}'s profile`;
        case 'find_relationship':
            return `Working out how ${nameOf(args.person_b)} is related to ${nameOf(args.person_a)}`;
        case 'list_relatives': {
            const words: Record<string, string> = {
                aunts_uncles: 'aunts and uncles',
                nephews_nieces: 'nephews and nieces',
                in_laws: 'in-laws',
            };
            const relation = String(args.relation ?? 'relatives');
            return `Listing ${nameOf(args.id)}'s ${words[relation] ?? relation.replace(/_/g, ' ')}`;
        }
        case 'find_people':
            return 'Filtering the family';
        case 'family_stats':
            return 'Counting the whole family';
        default:
            return 'Looking it up';
    }
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function parseBirthday(value: string | null): { month: number; day: number; year: number | null } | null {
    if (!value) return null;
    const md = value.match(/^--(\d{2})-(\d{2})$/);
    if (md) return { month: Number(md[1]), day: Number(md[2]), year: null };
    const iso = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (iso) return { month: Number(iso[2]), day: Number(iso[3]), year: Number(iso[1]) };
    return null;
}

function formatBirthday(value: string | null): string | null {
    const b = parseBirthday(value);
    if (!b || b.month < 1 || b.month > 12) return null;
    return `${b.day} ${MONTHS[b.month - 1]}${b.year ? ` ${b.year}` : ''}`;
}

function daysUntilBirthday(value: string | null, today: Date): number | null {
    const b = parseBirthday(value);
    if (!b) return null;
    const start = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
    let next = Date.UTC(today.getUTCFullYear(), b.month - 1, b.day);
    if (next < start) next = Date.UTC(today.getUTCFullYear() + 1, b.month - 1, b.day);
    return Math.round((next - start) / 86_400_000);
}

function clampInt(v: unknown, fallback: number, min: number, max: number): number {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, Math.round(n)));
}

function parentsOf(graph: FamilyGraph, p: GraphPerson) {
    const parents = p.parentIds.map((id) => graph.people.get(id)).filter(Boolean) as GraphPerson[];
    return {
        father: parents.find((x) => x.gender === 'male') ?? null,
        mother: parents.find((x) => x.gender === 'female') ?? null,
        other: parents.filter((x) => x.gender !== 'male' && x.gender !== 'female'),
    };
}

/** One-line summary used in every list. */
function brief(graph: FamilyGraph, p: GraphPerson, extra: Record<string, unknown> = {}) {
    const { father, mother } = parentsOf(graph, p);
    const out: Record<string, unknown> = {
        id: p.ref,
        name: p.name,
        gender: p.gender,
    };
    if (p.isDeceased) out.deceased = p.deathYear ?? true;
    if (father) out.father = father.name;
    if (mother) out.mother = mother.name;
    if (!father && !mother) out.parents = 'none recorded';
    const spouse = p.spouseIds.map((id) => graph.people.get(id)?.name).filter(Boolean);
    if (spouse.length) out.spouse = spouse.join(', ');
    return { ...out, ...extra };
}

function ref(graph: FamilyGraph, id: string) {
    const p = graph.people.get(id);
    return p ? { id: p.ref, name: p.name } : null;
}

function siblingsOf(graph: FamilyGraph, p: GraphPerson): { person: GraphPerson; half: boolean }[] {
    const result = new Map<string, { person: GraphPerson; half: boolean }>();
    for (const parentId of p.parentIds) {
        for (const childId of graph.people.get(parentId)?.childrenIds ?? []) {
            if (childId === p.id || result.has(childId)) continue;
            const sib = graph.people.get(childId);
            if (!sib) continue;
            const shared = sib.parentIds.filter((x) => p.parentIds.includes(x)).length;
            const half = shared === 1 && p.parentIds.length >= 2 && sib.parentIds.length >= 2;
            result.set(childId, { person: sib, half });
        }
    }
    return [...result.values()];
}

function descendantsOf(graph: FamilyGraph, id: string): Map<string, number> {
    const gen = new Map<string, number>();
    let frontier = [id];
    let depth = 0;
    while (frontier.length) {
        depth++;
        const next: string[] = [];
        for (const cur of frontier) {
            for (const c of graph.people.get(cur)?.childrenIds ?? []) {
                if (gen.has(c) || c === id) continue;
                gen.set(c, depth);
                next.push(c);
            }
        }
        frontier = next;
    }
    return gen;
}

function ancestorsOf(graph: FamilyGraph, id: string): Map<string, number> {
    const gen = new Map<string, number>();
    let frontier = [id];
    let depth = 0;
    while (frontier.length) {
        depth++;
        const next: string[] = [];
        for (const cur of frontier) {
            for (const parentId of graph.people.get(cur)?.parentIds ?? []) {
                if (gen.has(parentId) || parentId === id) continue;
                gen.set(parentId, depth);
                next.push(parentId);
            }
        }
        frontier = next;
    }
    return gen;
}

/* ---- Spelling-tolerant name matching ---- */

const STOP_WORDS = new Set(['of', 'the', 's', 'o', 'd', 'w', 'son', 'daughter', 'bin', 'bint', 'binte', 'and']);

function normalizeText(s: string): string {
    return s
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^\p{L}\p{M}\p{N}\s]/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/** Rough sound-alike key for romanised Urdu/Hindi names (Shakeela ≈ Shakila, Zaitun ≈ Zaitoon). */
function soundKey(word: string): string {
    let w = word;
    if (/^(mohd|mohammad|mohammed|mohamad|muhammed|mohmmad|md)$/.test(w)) return 'mhmd';
    w = w.replace(/ee/g, 'i').replace(/oo|ou/g, 'u').replace(/aa/g, 'a').replace(/ph/g, 'f');
    w = w.replace(/q/g, 'k').replace(/w/g, 'v').replace(/z/g, 'j').replace(/y$/, 'i');
    w = w[0] + w.slice(1).replace(/h/g, '');
    w = w.replace(/(.)\1+/g, '$1');
    return w;
}

function editDistance(a: string, b: string, max: number): number {
    if (Math.abs(a.length - b.length) > max) return max + 1;
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
        const cur = [i];
        let rowMin = i;
        for (let j = 1; j <= b.length; j++) {
            cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
            rowMin = Math.min(rowMin, cur[j]);
        }
        if (rowMin > max) return max + 1;
        prev = cur;
    }
    return prev[b.length];
}

function tokenScore(q: string, t: string): number {
    if (q === t) return 3;
    const qk = soundKey(q);
    const tk = soundKey(t);
    if (qk === tk) return 2.6;
    if (q.length >= 3 && t.startsWith(q)) return 2;
    if (q.length >= 4 && t.includes(q)) return 1.5;
    if (qk.length >= 4) {
        const d = editDistance(qk, tk, 2);
        if (d === 1) return 1.3;
        if (d === 2 && qk.length >= 7) return 0.8;
    }
    return 0;
}

function scorePerson(graph: FamilyGraph, p: GraphPerson, queryTokens: string[]): number {
    const own = normalizeText(p.name).split(' ').filter(Boolean);
    const parentTokens = p.parentIds
        .flatMap((id) => normalizeText(graph.people.get(id)?.name ?? '').split(' '))
        .filter(Boolean);
    let total = 0;
    let ownHits = 0;
    let misses = 0;
    for (const q of queryTokens) {
        const bestOwn = Math.max(0, ...own.map((t) => tokenScore(q, t)));
        const bestParent = Math.max(0, ...parentTokens.map((t) => tokenScore(q, t))) * 0.6;
        if (bestOwn > 0 && bestOwn >= bestParent) ownHits++;
        const best = Math.max(bestOwn, bestParent);
        if (best === 0) misses++;
        total += best;
    }
    if (ownHits === 0) return 0;
    // Exact full-name match ranks first
    if (own.join(' ') === queryTokens.join(' ')) total += 2;
    return total * Math.pow(0.5, misses);
}

/* ------------------------------------------------------------------ */
/*  Tool implementations                                               */
/* ------------------------------------------------------------------ */

type ToolResult = Record<string, unknown>;

function personOrError(graph: FamilyGraph, idOrRef: unknown): GraphPerson | ToolResult {
    const id = resolvePersonId(graph, String(idOrRef ?? ''));
    if (!id) return { error: `No person with id "${String(idOrRef)}". Use search_people first.` };
    return graph.people.get(id)!;
}

const isError = (v: GraphPerson | ToolResult): v is ToolResult => 'error' in v;

function searchPeople(graph: FamilyGraph, args: Record<string, unknown>): ToolResult {
    const query = normalizeText(String(args.query ?? ''));
    const tokens = query.split(' ').filter((t) => t && !STOP_WORDS.has(t));
    if (tokens.length === 0) return { error: 'Empty query' };
    const limit = clampInt(args.limit, 8, 1, 25);

    const scored: { p: GraphPerson; score: number }[] = [];
    for (const p of graph.people.values()) {
        const score = scorePerson(graph, p, tokens);
        if (score > 0) scored.push({ p, score });
    }
    scored.sort((a, b) => b.score - a.score || a.p.name.length - b.p.name.length);

    const strong = scored.filter((s) => s.score >= tokens.length * 1.5);
    const picked = (strong.length ? strong : scored).slice(0, limit);
    return {
        query: args.query,
        total_matches: strong.length || scored.length,
        ...(strong.length ? {} : { note: 'No close match; these are the nearest spellings.' }),
        people: picked.map(({ p }) =>
            brief(graph, p, normalizeText(p.name) === tokens.join(' ') ? { exact: true } : {}),
        ),
    };
}

function getPerson(graph: FamilyGraph, args: Record<string, unknown>): ToolResult {
    const p = personOrError(graph, args.id);
    if (isError(p)) return p;
    const { father, mother, other } = parentsOf(graph, p);
    const grandparents = (parent: GraphPerson | null) =>
        parent
            ? parent.parentIds.map((id) => graph.people.get(id)).filter(Boolean).map((gp) => ({
                  id: gp!.ref,
                  name: gp!.name,
                  gender: gp!.gender,
              }))
            : [];
    const descendants = descendantsOf(graph, p.id);
    const grandchildren = [...descendants.values()].filter((d) => d === 2).length;

    return {
        id: p.ref,
        name: p.name,
        gender: p.gender,
        status: p.isDeceased ? `deceased${p.deathYear ? ` (${p.deathYear})` : ''}` : 'living',
        birthday: formatBirthday(p.birthDate) ?? 'not recorded',
        location: p.location ?? 'not recorded',
        ...(p.bio ? { bio: p.bio.slice(0, 600) } : {}),
        father: father ? ref(graph, father.id) : 'not recorded',
        mother: mother ? ref(graph, mother.id) : 'not recorded',
        ...(other.length ? { other_parents: other.map((x) => ref(graph, x.id)) } : {}),
        spouses: p.spouseIds.map((id) => ref(graph, id)).filter(Boolean),
        ...(p.exSpouseIds.length ? { ex_spouses: p.exSpouseIds.map((id) => ref(graph, id)).filter(Boolean) } : {}),
        children: p.childrenIds.map((id) => {
            const c = graph.people.get(id);
            if (!c) return null;
            const otherParent = c.parentIds.find((x) => x !== p.id);
            return {
                id: c.ref,
                name: c.name,
                gender: c.gender,
                ...(otherParent ? { other_parent: graph.people.get(otherParent)?.name } : {}),
            };
        }).filter(Boolean),
        siblings: siblingsOf(graph, p).map(({ person, half }) => ({
            id: person.ref,
            name: person.name,
            gender: person.gender,
            ...(half ? { half: true } : {}),
        })),
        paternal_grandparents: grandparents(father),
        maternal_grandparents: grandparents(mother),
        counts: {
            children: p.childrenIds.length,
            grandchildren,
            all_descendants: descendants.size,
        },
    };
}

function findRelationship(graph: FamilyGraph, args: Record<string, unknown>): ToolResult {
    const a = personOrError(graph, args.person_a);
    if (isError(a)) return a;
    const b = personOrError(graph, args.person_b);
    if (isError(b)) return b;

    const k = describeKinship(graph.people, a.id, b.id);
    if (k.kind === 'none') {
        return {
            person_a: ref(graph, a.id),
            person_b: ref(graph, b.id),
            answer: `${b.name} and ${a.name} are not connected in the tree yet.`,
        };
    }
    const label = k.label === 'Relative' ? 'relative' : k.label;
    return {
        person_a: ref(graph, a.id),
        person_b: ref(graph, b.id),
        answer: `${b.name} is ${a.name}'s ${label.toLowerCase()}${k.term ? ` (${k.term})` : ''}.`,
        relation: label,
        ...(k.term ? { urdu_term: k.term } : {}),
        chain: `${a.name}'s ${k.chain.toLowerCase()}`,
        ...(k.also ? { also_related_as: k.also } : {}),
        steps: (k.path ?? []).length,
        path: (k.path ?? []).map((s) => ({
            via: s.step,
            ...ref(graph, s.personId),
        })),
    };
}

function listRelatives(graph: FamilyGraph, args: Record<string, unknown>): ToolResult {
    const p = personOrError(graph, args.id);
    if (isError(p)) return p;
    const relation = String(args.relation) as Relation;
    if (!RELATIONS.includes(relation)) return { error: `relation must be one of ${RELATIONS.join(', ')}` };
    const limit = clampInt(args.limit, 60, 1, 300);

    const people = (ids: Iterable<string>) =>
        [...new Set(ids)].map((id) => graph.people.get(id)).filter(Boolean) as GraphPerson[];
    const parentsOfIds = (ids: string[]) => ids.flatMap((id) => graph.people.get(id)?.parentIds ?? []);
    const childrenOfIds = (ids: string[]) => ids.flatMap((id) => graph.people.get(id)?.childrenIds ?? []);
    const siblingIds = (id: string) => siblingsOf(graph, graph.people.get(id)!).map((s) => s.person.id);

    let list: { person: GraphPerson; extra?: Record<string, unknown> }[] = [];
    switch (relation) {
        case 'parents':
            list = people(p.parentIds).map((person) => ({ person }));
            break;
        case 'children':
            list = people(p.childrenIds).map((person) => ({ person }));
            break;
        case 'spouses':
            list = [
                ...people(p.spouseIds).map((person) => ({ person, extra: { status: 'current' } })),
                ...people(p.exSpouseIds).map((person) => ({ person, extra: { status: 'divorced' } })),
            ];
            break;
        case 'siblings':
            list = siblingsOf(graph, p).map(({ person, half }) => ({ person, extra: half ? { half: true } : undefined }));
            break;
        case 'grandparents':
            list = people(parentsOfIds(p.parentIds)).map((person) => ({ person }));
            break;
        case 'grandchildren':
            list = people(childrenOfIds(p.childrenIds)).map((person) => ({ person }));
            break;
        case 'aunts_uncles': {
            const ids = p.parentIds.flatMap((parentId) => siblingIds(parentId));
            list = people(ids).map((person) => ({ person }));
            break;
        }
        case 'nephews_nieces':
            list = people(childrenOfIds(siblingIds(p.id))).map((person) => ({ person }));
            break;
        case 'cousins': {
            const auntsUncles = p.parentIds.flatMap((parentId) => siblingIds(parentId));
            const exclude = new Set([p.id, ...siblingIds(p.id)]);
            list = people(childrenOfIds(auntsUncles).filter((id) => !exclude.has(id))).map((person) => ({ person }));
            break;
        }
        case 'in_laws': {
            const ids = [
                ...parentsOfIds(p.spouseIds),
                ...p.spouseIds.flatMap((s) => siblingIds(s)),
                ...siblingIds(p.id).flatMap((s) => graph.people.get(s)?.spouseIds ?? []),
                ...p.childrenIds.flatMap((c) => graph.people.get(c)?.spouseIds ?? []),
            ].filter((id) => id !== p.id);
            list = people(ids).map((person) => ({ person }));
            break;
        }
        case 'ancestors':
            list = [...ancestorsOf(graph, p.id)]
                .sort((a, b) => a[1] - b[1])
                .map(([id, generation]) => ({ person: graph.people.get(id)!, extra: { generations_up: generation } }));
            break;
        case 'descendants':
            list = [...descendantsOf(graph, p.id)]
                .sort((a, b) => a[1] - b[1])
                .map(([id, generation]) => ({ person: graph.people.get(id)!, extra: { generations_down: generation } }));
            break;
    }

    const withLabels = list.length <= 80;
    return {
        person: ref(graph, p.id),
        relation,
        count: list.length,
        ...(list.length === 0 ? { note: emptyNote(graph, p, relation, siblingIds) } : {}),
        ...(list.length > limit ? { truncated: true, shown: limit } : {}),
        people: list.slice(0, limit).map(({ person, extra }) => {
            const k = withLabels ? describeKinship(graph.people, p.id, person.id) : null;
            return brief(graph, person, {
                ...(k && k.label && k.label !== 'Relative' ? { is: k.label + (k.term ? ` (${k.term})` : '') } : {}),
                ...extra,
            });
        }),
    };
}

/** Why a relatives list is empty, in terms of what is recorded. */
function emptyNote(
    graph: FamilyGraph,
    p: GraphPerson,
    relation: Relation,
    siblingIds: (id: string) => string[],
): string {
    const names = (ids: string[]) =>
        ids.map((id) => graph.people.get(id)?.name).filter(Boolean).join(', ');
    const parents = p.parentIds;
    switch (relation) {
        case 'parents':
            return 'No parents are recorded for this person.';
        case 'siblings':
            return parents.length
                ? `Parents recorded (${names(parents)}) have no other children recorded.`
                : 'No parents are recorded, so siblings cannot be found.';
        case 'grandparents':
            return parents.length
                ? `Parents recorded (${names(parents)}), but none of them has parents recorded.`
                : 'No parents are recorded.';
        case 'aunts_uncles':
            return parents.length
                ? `Parents recorded (${names(parents)}), but no siblings of theirs are recorded.`
                : 'No parents are recorded.';
        case 'cousins': {
            const auntsUncles = parents.flatMap((id) => siblingIds(id));
            if (!parents.length) return 'No parents are recorded.';
            return auntsUncles.length
                ? `${auntsUncles.length} aunts/uncles are recorded (${names(auntsUncles)}), but none of them has children recorded.`
                : `Parents recorded (${names(parents)}), but none of their siblings are recorded.`;
        }
        case 'nephews_nieces': {
            const sibs = siblingIds(p.id);
            return sibs.length
                ? `${sibs.length} siblings are recorded (${names(sibs)}), but none has children recorded.`
                : 'No siblings are recorded.';
        }
        case 'grandchildren':
            return p.childrenIds.length
                ? `Children recorded (${names(p.childrenIds)}), but none of them has children recorded.`
                : 'No children are recorded.';
        case 'children':
        case 'descendants':
            return 'No children are recorded for this person.';
        case 'spouses':
            return 'No spouse is recorded for this person.';
        case 'ancestors':
            return 'No parents are recorded for this person.';
        case 'in_laws':
            return p.spouseIds.length ? "The spouse's family is not recorded." : 'No spouse is recorded.';
    }
}

function findPeople(graph: FamilyGraph, args: Record<string, unknown>): ToolResult {
    const limit = clampInt(args.limit, 30, 1, 150);
    const today = new Date();
    const nameQ = args.name_contains ? normalizeText(String(args.name_contains)) : '';
    const locQ = args.location_contains ? normalizeText(String(args.location_contains)) : '';
    const bioQ = args.bio_contains ? normalizeText(String(args.bio_contains)) : '';
    const month = args.birthday_month != null ? clampInt(args.birthday_month, 0, 1, 12) : null;
    const within = args.birthday_within_days != null ? clampInt(args.birthday_within_days, 30, 0, 366) : null;
    const minChildren = args.min_children != null ? clampInt(args.min_children, 0, 0, 100) : null;

    const matches: { p: GraphPerson; extra: Record<string, unknown>; sort: number }[] = [];
    for (const p of graph.people.values()) {
        if (nameQ && !normalizeText(p.name).includes(nameQ)) continue;
        if (locQ && !normalizeText(p.location ?? '').includes(locQ)) continue;
        if (bioQ && !normalizeText(p.bio ?? '').includes(bioQ)) continue;
        if (args.gender && p.gender !== args.gender) continue;
        if (typeof args.living === 'boolean' && p.isDeceased === args.living) continue;
        if (typeof args.has_parents === 'boolean' && (p.parentIds.length > 0) !== args.has_parents) continue;
        if (minChildren != null && p.childrenIds.length < minChildren) continue;
        const extra: Record<string, unknown> = {};
        let sort = 0;
        if (month != null || within != null) {
            const b = parseBirthday(p.birthDate);
            if (!b) continue;
            if (month != null && b.month !== month) continue;
            const days = daysUntilBirthday(p.birthDate, today);
            if (within != null && (days == null || days > within)) continue;
            extra.birthday = formatBirthday(p.birthDate);
            if (days != null) extra.days_until_birthday = days;
            sort = month != null ? b.day : (days ?? 0);
        }
        if (locQ && p.location) extra.location = p.location;
        if (minChildren != null) {
            extra.children = p.childrenIds.length;
            sort = -p.childrenIds.length;
        }
        matches.push({ p, extra, sort });
    }
    matches.sort((a, b) => a.sort - b.sort || a.p.name.localeCompare(b.p.name));
    return {
        count: matches.length,
        ...(matches.length > limit ? { truncated: true, shown: limit } : {}),
        people: matches.slice(0, limit).map(({ p, extra }) => brief(graph, p, extra)),
    };
}

function familyStats(graph: FamilyGraph): ToolResult {
    const all = [...graph.people.values()];
    const today = new Date();
    const descendantCount = new Map<string, number>();
    const grandchildCount = new Map<string, number>();
    for (const p of all) {
        if (p.childrenIds.length === 0) continue;
        const d = descendantsOf(graph, p.id);
        descendantCount.set(p.id, d.size);
        grandchildCount.set(p.id, [...d.values()].filter((x) => x === 2).length);
    }
    const top = (m: Map<string, number>, n = 5) =>
        [...m].sort((a, b) => b[1] - a[1]).slice(0, n).map(([id, count]) => ({ ...ref(graph, id), count }));

    // Longest parent→child chain
    const depth = new Map<string, number>();
    const depthOf = (id: string, guard = new Set<string>()): number => {
        if (depth.has(id)) return depth.get(id)!;
        if (guard.has(id)) return 0;
        guard.add(id);
        const p = graph.people.get(id)!;
        const d = 1 + Math.max(0, ...p.parentIds.filter((x) => graph.people.has(x)).map((x) => depthOf(x, guard)));
        depth.set(id, d);
        return d;
    };
    let generations = 0;
    for (const p of all) generations = Math.max(generations, depthOf(p.id));

    const places = new Map<string, number>();
    for (const p of all) {
        if (!p.location) continue;
        const key = p.location.split(',')[0].trim().toUpperCase();
        places.set(key, (places.get(key) ?? 0) + 1);
    }

    const upcoming = all
        .map((p) => ({ p, days: daysUntilBirthday(p.birthDate, today) }))
        .filter((x) => x.days != null && x.days <= 30 && !x.p.isDeceased)
        .sort((a, b) => a.days! - b.days!)
        .slice(0, 15)
        .map(({ p, days }) => ({ ...ref(graph, p.id), birthday: formatBirthday(p.birthDate), in_days: days }));

    return {
        total_people: all.length,
        living: all.filter((p) => !p.isDeceased).length,
        deceased: all.filter((p) => p.isDeceased).length,
        men: all.filter((p) => p.gender === 'male').length,
        women: all.filter((p) => p.gender === 'female').length,
        generations,
        married_couples: all.reduce((n, p) => n + p.spouseIds.length, 0) / 2,
        people_without_parents_recorded: all.filter((p) => p.parentIds.length === 0).length,
        birthdays_recorded: all.filter((p) => parseBirthday(p.birthDate)).length,
        locations_recorded: all.filter((p) => p.location).length,
        most_children: top(new Map(all.map((p) => [p.id, p.childrenIds.length]))),
        most_grandchildren: top(grandchildCount),
        most_descendants: top(descendantCount),
        common_places: [...places].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([place, count]) => ({ place, count })),
        upcoming_birthdays_30_days: upcoming,
    };
}

/* ------------------------------------------------------------------ */
/*  Dispatcher                                                         */
/* ------------------------------------------------------------------ */

export async function runTool(name: string, rawArgs: string): Promise<{ result: ToolResult; graph: FamilyGraph }> {
    const graph = await getFamilyGraph();
    let args: Record<string, unknown> = {};
    try {
        args = rawArgs ? JSON.parse(rawArgs) : {};
    } catch {
        return { result: { error: 'Arguments were not valid JSON' }, graph };
    }
    let result: ToolResult;
    switch (name) {
        case 'search_people':
            result = searchPeople(graph, args);
            break;
        case 'get_person':
            result = getPerson(graph, args);
            break;
        case 'find_relationship':
            result = findRelationship(graph, args);
            break;
        case 'list_relatives':
            result = listRelatives(graph, args);
            break;
        case 'find_people':
            result = findPeople(graph, args);
            break;
        case 'family_stats':
            result = familyStats(graph);
            break;
        default:
            result = { error: `Unknown tool ${name}` };
    }
    return { result, graph };
}

/** The asking user's own line for the system prompt. */
export function describePersonForPrompt(graph: FamilyGraph, personId: string | undefined | null): string | null {
    if (!personId) return null;
    const p = graph.people.get(personId);
    if (!p) return null;
    const { father, mother } = parentsOf(graph, p);
    const mention = (x: GraphPerson) => `[[${x.name}|${x.ref}]]`;
    const parts = [`${mention(p)} (${p.gender})`];
    if (father) parts.push(`father ${mention(father)}`);
    if (mother) parts.push(`mother ${mention(mother)}`);
    const spouses = p.spouseIds.map((id) => graph.people.get(id)).filter(Boolean) as GraphPerson[];
    if (spouses.length) parts.push(`married to ${spouses.map(mention).join(', ')}`);
    return parts.join(', ');
}
