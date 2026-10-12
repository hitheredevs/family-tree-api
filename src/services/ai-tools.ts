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

/** Only offered to admins (and refused for everyone else in runTool). */
export const ADMIN_AI_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'same_generation_relatives',
            description:
                "Admin only. Everyone in the same generation as a person across EVERY branch of the family, as far back as the tree goes: siblings, first cousins, second cousins, third cousins… (people who share an ancestor the same number of generations up). Each person is counted once, at their closest shared ancestor. Returns exact totals per level, the ancestor branches they come through, paternal/maternal side, living/deceased, and a paged list. Use for 'how many cousins do I have', far/distant cousins, 'everyone at my level'. The totals are exact — report them, don't recount.",
            parameters: {
                type: 'object',
                properties: {
                    id: { type: 'string', description: 'Person id from another tool' },
                    include_siblings: { type: 'boolean', description: 'Count brothers and sisters too (default true)' },
                    max_level: {
                        type: 'integer',
                        description: 'Stop this many generations up (2 = up to first cousins). Default: as far as the tree goes',
                    },
                    living: { type: 'boolean', description: 'true = living only, false = deceased only' },
                    list_level: {
                        type: 'integer',
                        description: 'Only list people at this level (1 = siblings, 2 = first cousins, 3 = second cousins…); totals still cover every level',
                    },
                    list_side: { type: 'string', enum: ['paternal', 'maternal', 'both'], description: "Only list people on this parent's side" },
                    limit: { type: 'integer', description: 'People listed (default 40, max 200)' },
                    offset: { type: 'integer', description: 'Skip this many people in the list, for "show more"' },
                },
                required: ['id'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'relatives_at_distance',
            description:
                'Admin only. People whose closest shared ancestor with the person is exactly `up` generations above the person and `down` generations above them. Examples: up 3 down 3 = second cousins (same generation); up 2 down 1 = aunts/uncles; up 3 down 2 = first cousins once removed, a generation OLDER (parents\' first cousins); up 2 down 3 = first cousins once removed, a generation YOUNGER (first cousins\' children); up 0 = descendants; down 0 = ancestors. Returns an exact count, living/deceased, sides, ancestor branches and a paged list.',
            parameters: {
                type: 'object',
                properties: {
                    id: { type: 'string' },
                    up: { type: 'integer', description: 'Generations up to the shared ancestor (0-15)' },
                    down: { type: 'integer', description: 'Generations down from it to the relatives (0-15)' },
                    living: { type: 'boolean', description: 'true = living only, false = deceased only' },
                    list_side: { type: 'string', enum: ['paternal', 'maternal', 'both'], description: "Only list people on this parent's side" },
                    limit: { type: 'integer', description: 'People listed (default 40, max 200)' },
                    offset: { type: 'integer', description: 'Skip this many people in the list, for "show more"' },
                },
                required: ['id', 'up', 'down'],
            },
        },
    },
];

const ADMIN_TOOL_NAMES = new Set(ADMIN_AI_TOOLS.map((t) => t.function.name));

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
        case 'same_generation_relatives':
            return `Counting ${nameOf(args.id)}'s generation across every branch`;
        case 'relatives_at_distance':
            return `Finding ${nameOf(args.id)}'s ${distanceLabel(clampInt(args.up, 0, 0, 15), clampInt(args.down, 0, 0, 15))}`;
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
/*  Admin: relatives by generation distance                            */
/*                                                                     */
/*  levels[k] = everyone exactly k generations above the person (any   */
/*  line). Going `up` then `down` reaches everyone who shares one of    */
/*  those ancestors; anyone also reachable through a closer shared      */
/*  ancestor at the same generation offset belongs to that closer      */
/*  level instead, so each person is counted once.                     */
/* ------------------------------------------------------------------ */

const MAX_GENERATIONS = 15;
const ORDINAL_WORDS = ['', 'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth'];
const TIMES_WORDS = ['', 'once', 'twice', 'three times', 'four times', 'five times'];
const PLACEHOLDER_NAME = /^(father|mother|son|daughter|husband|wife|brother|sister|child|baby|unknown|n\/?a)$/i;

function greatsPrefix(n: number): string {
    if (n <= 0) return '';
    if (n === 1) return 'great-';
    if (n === 2) return 'great-great-';
    return `${n}× great-`;
}

/** Plural name for "shared ancestor `up` above me, `down` above them". */
function distanceLabel(up: number, down: number): string {
    if (up === 0 && down === 0) return 'self';
    if (up === 0) return down === 1 ? 'children' : `${greatsPrefix(down - 2)}grandchildren`;
    if (down === 0) return up === 1 ? 'parents' : `${greatsPrefix(up - 2)}grandparents`;
    if (up === 1 && down === 1) return 'siblings';
    if (up === 1) return down === 2 ? 'nephews and nieces' : `${greatsPrefix(down - 2)}grand-nephews and nieces`;
    if (down === 1) return up === 2 ? 'aunts and uncles' : `${greatsPrefix(up - 3)}great-aunts and uncles`;
    const degree = Math.min(up, down) - 1;
    const removed = Math.abs(up - down);
    let label = `${ORDINAL_WORDS[degree] ?? `${degree}th`} cousins`;
    if (removed) {
        label += ` ${TIMES_WORDS[removed] ?? `${removed} times`} removed (${up > down ? 'older' : 'younger'} generation)`;
    }
    return label;
}

function parentsOfSet(graph: FamilyGraph, ids: Iterable<string>): Set<string> {
    const out = new Set<string>();
    for (const id of ids) for (const p of graph.people.get(id)?.parentIds ?? []) if (graph.people.has(p)) out.add(p);
    return out;
}

function childrenOfSet(graph: FamilyGraph, ids: Iterable<string>): Set<string> {
    const out = new Set<string>();
    for (const id of ids) for (const c of graph.people.get(id)?.childrenIds ?? []) if (graph.people.has(c)) out.add(c);
    return out;
}

function ancestorLevels(graph: FamilyGraph, id: string): Set<string>[] {
    const levels = [new Set([id])];
    while (levels.length <= MAX_GENERATIONS) {
        const next = parentsOfSet(graph, levels[levels.length - 1]);
        if (next.size === 0) break;
        levels.push(next);
    }
    return levels;
}

function downFrom(graph: FamilyGraph, start: Set<string>, steps: number): Set<string> {
    let current = start;
    for (let i = 0; i < steps && current.size; i++) current = childrenOfSet(graph, current);
    return current;
}

/** Up `up`, down `down`, minus anyone closer at the same generation offset, minus the person. */
function relativesAtDistance(graph: FamilyGraph, levels: Set<string>[], personId: string, up: number, down: number): Set<string> {
    if (up >= levels.length) return new Set();
    const result = new Set(downFrom(graph, levels[up], down));
    for (let k = 1; k <= Math.min(up, down); k++) {
        for (const id of downFrom(graph, levels[up - k], down - k)) result.delete(id);
    }
    result.delete(personId);
    return result;
}

interface SideSets {
    fatherName: string | null;
    motherName: string | null;
    side: (id: string) => 'paternal' | 'maternal' | 'both' | null;
}

/** Which parent's line reaches each relative at this (up, down). */
function sidesAt(graph: FamilyGraph, p: GraphPerson, up: number, down: number): SideSets {
    const { father, mother } = parentsOf(graph, p);
    const reach = (parent: GraphPerson | null) => {
        if (!parent || up < 1) return new Set<string>();
        const levels = ancestorLevels(graph, parent.id);
        return up - 1 < levels.length ? downFrom(graph, levels[up - 1], down) : new Set<string>();
    };
    const viaFather = reach(father);
    const viaMother = reach(mother);
    return {
        fatherName: father?.name ?? null,
        motherName: mother?.name ?? null,
        side: (id) => {
            const f = viaFather.has(id);
            const m = viaMother.has(id);
            return f && m ? 'both' : f ? 'paternal' : m ? 'maternal' : null;
        },
    };
}

interface Branch {
    label: string;
    refs: string[];
    members: Set<string>;
}

/** Branch summary for tool output, with the side most of its people are on. */
function describeBranch(b: Branch, sides: SideSets | null) {
    const counts = new Map<string, number>();
    if (sides) for (const id of b.members) {
        const side = sides.side(id);
        if (side) counts.set(side, (counts.get(side) ?? 0) + 1);
    }
    const side = [...counts].sort((x, y) => y[1] - x[1])[0]?.[0];
    return { ancestors: b.label, ids: b.refs, count: b.members.size, ...(side ? { side } : {}) };
}

const SIDES = new Set(['paternal', 'maternal', 'both']);

/** Group the ancestors at one level into couples and count who descends from each. */
function branchesAt(graph: FamilyGraph, ancestors: Set<string>, down: number, relatives: Set<string>): Branch[] {
    const ids = [...ancestors];
    const parent = new Map(ids.map((id) => [id, id]));
    const find = (id: string): string => (parent.get(id) === id ? id : find(parent.get(id)!));
    for (const id of ids) {
        const p = graph.people.get(id)!;
        for (const s of [...p.spouseIds, ...p.exSpouseIds]) {
            if (ancestors.has(s)) parent.set(find(s), find(id));
        }
    }
    const groups = new Map<string, string[]>();
    for (const id of ids) groups.set(find(id), [...(groups.get(find(id)) ?? []), id]);

    const branches: Branch[] = [];
    for (const members of groups.values()) {
        const reached = downFrom(graph, new Set(members), down);
        const hits = new Set([...reached].filter((id) => relatives.has(id)));
        if (hits.size === 0) continue;
        const people = members.map((id) => graph.people.get(id)!).sort((a, b) => (a.gender === 'male' ? -1 : b.gender === 'male' ? 1 : 0));
        branches.push({ label: people.map((x) => x.name).join(' & '), refs: people.map((x) => x.ref), members: hits });
    }
    return branches.sort((a, b) => b.members.size - a.members.size);
}

function filterLiving(graph: FamilyGraph, ids: Set<string>, living: unknown): Set<string> {
    if (typeof living !== 'boolean') return ids;
    return new Set([...ids].filter((id) => graph.people.get(id)!.isDeceased !== living));
}

function countLiving(graph: FamilyGraph, ids: Iterable<string>): { living: number; deceased: number } {
    let living = 0;
    let deceased = 0;
    for (const id of ids) graph.people.get(id)!.isDeceased ? deceased++ : living++;
    return { living, deceased };
}

function sameGenerationRelatives(graph: FamilyGraph, args: Record<string, unknown>): ToolResult {
    const p = personOrError(graph, args.id);
    if (isError(p)) return p;
    const levels = ancestorLevels(graph, p.id);
    const maxLevel = Math.min(clampInt(args.max_level, MAX_GENERATIONS, 1, MAX_GENERATIONS), levels.length - 1);
    const includeSiblings = args.include_siblings !== false;
    const limit = clampInt(args.limit, 40, 1, 200);
    const offset = clampInt(args.offset, 0, 0, 100_000);

    if (levels.length < 2) {
        return {
            person: ref(graph, p.id),
            total: 0,
            note: 'No parents are recorded for this person, so no relatives in their generation can be found.',
        };
    }

    const seen = new Set<string>([p.id]);
    const perLevel: { up: number; ids: Set<string> }[] = [];
    for (let up = 1; up <= maxLevel; up++) {
        const reached = downFrom(graph, levels[up], up);
        const fresh = new Set([...reached].filter((id) => !seen.has(id)));
        for (const id of reached) seen.add(id);
        if (up === 1 && !includeSiblings) continue;
        perLevel.push({ up, ids: filterLiving(graph, fresh, args.living) });
    }

    const entries: { person: GraphPerson; up: number; side: string | null; via: string }[] = [];
    const levelSummaries = perLevel.map(({ up, ids }) => {
        if (ids.size === 0) return { generations_up: up, relation: distanceLabel(up, up), count: 0 };
        const sides = sidesAt(graph, p, up, up);
        const branches = branchesAt(graph, levels[up], up, ids);
        const viaOf = new Map<string, string>();
        for (const b of branches) for (const id of b.members) if (!viaOf.has(id)) viaOf.set(id, b.label);
        const sideCounts = { paternal: 0, maternal: 0, both: 0 };
        for (const id of ids) {
            const side = sides.side(id);
            if (side) sideCounts[side]++;
            entries.push({ person: graph.people.get(id)!, up, side, via: viaOf.get(id) ?? '' });
        }
        return {
            generations_up: up,
            relation: distanceLabel(up, up),
            count: ids.size,
            ...countLiving(graph, ids),
            sides: sideCounts,
            through: branches.slice(0, 6).map((b) => describeBranch(b, sides)),
            ...(branches.length > 6 ? { more_branches: branches.length - 6 } : {}),
        };
    });

    const sideOrder: Record<string, number> = { both: 0, paternal: 1, maternal: 2 };
    entries.sort(
        (a, b) =>
            a.up - b.up ||
            (sideOrder[a.side ?? ''] ?? 3) - (sideOrder[b.side ?? ''] ?? 3) ||
            a.person.name.localeCompare(b.person.name),
    );
    const total = entries.length;
    const placeholders = entries.filter((e) => PLACEHOLDER_NAME.test(e.person.name.trim())).length;
    const listLevel = args.list_level != null ? clampInt(args.list_level, 0, 1, MAX_GENERATIONS) : null;
    const listSide = SIDES.has(String(args.list_side)) ? String(args.list_side) : null;
    const listed = entries.filter((e) => (listLevel == null || e.up === listLevel) && (!listSide || e.side === listSide));
    const page = listed.slice(offset, offset + limit);
    const { father, mother } = parentsOf(graph, p);

    return {
        person: ref(graph, p.id),
        definition:
            'Same generation = shares an ancestor the same number of generations up (siblings 1 up, first cousins 2 up, second cousins 3 up…). Each person is counted once, at the closest shared ancestor. Married-in spouses are not counted.',
        total,
        ...countLiving(graph, entries.map((e) => e.person.id)),
        ...(typeof args.living === 'boolean' ? { filter: args.living ? 'living only' : 'deceased only' } : {}),
        sides_key: { paternal: `through ${father?.name ?? 'father'}`, maternal: `through ${mother?.name ?? 'mother'}` },
        levels: levelSummaries,
        oldest_ancestor_level: levels.length - 1,
        ...(placeholders
            ? { placeholder_names: placeholders, placeholder_note: 'Some entries have placeholder names like FATHER or SON; they are counted.' }
            : {}),
        people: page.map((e) =>
            brief(graph, e.person, {
                is: distanceLabel(e.up, e.up).replace(/s$/, ''),
                ...(e.side ? { side: e.side } : {}),
                ...(e.via ? { through: e.via } : {}),
            }),
        ),
        ...(listLevel != null || listSide
            ? { list_filter: [listLevel != null ? distanceLabel(listLevel, listLevel) : null, listSide].filter(Boolean).join(', ') }
            : {}),
        shown: `${page.length ? offset + 1 : 0}-${offset + page.length} of ${listed.length}`,
        ...(offset + page.length < listed.length ? { more: listed.length - offset - page.length } : {}),
    };
}

function relativesAtDistanceTool(graph: FamilyGraph, args: Record<string, unknown>): ToolResult {
    const p = personOrError(graph, args.id);
    if (isError(p)) return p;
    const up = clampInt(args.up, 0, 0, MAX_GENERATIONS);
    const down = clampInt(args.down, 0, 0, MAX_GENERATIONS);
    if (up === 0 && down === 0) return { error: 'up and down cannot both be 0' };
    const limit = clampInt(args.limit, 40, 1, 200);
    const offset = clampInt(args.offset, 0, 0, 100_000);

    const levels = ancestorLevels(graph, p.id);
    const ids = filterLiving(graph, relativesAtDistance(graph, levels, p.id, up, down), args.living);
    const label = distanceLabel(up, down);
    if (ids.size === 0) {
        return {
            person: ref(graph, p.id),
            up,
            down,
            relation: label,
            count: 0,
            note:
                up >= levels.length
                    ? `Only ${levels.length - 1} generations of ancestors are recorded above this person.`
                    : 'Nobody is recorded at this distance.',
        };
    }

    const sides = up > 0 ? sidesAt(graph, p, up, down) : null;
    const branches = up > 0 ? branchesAt(graph, levels[up], down, ids) : [];
    const viaOf = new Map<string, string>();
    for (const b of branches) for (const id of b.members) if (!viaOf.has(id)) viaOf.set(id, b.label);
    const listSide = SIDES.has(String(args.list_side)) && sides ? String(args.list_side) : null;
    const sorted = [...ids]
        .map((id) => graph.people.get(id)!)
        .filter((x) => !listSide || sides?.side(x.id) === listSide)
        .sort((a, b) => a.name.localeCompare(b.name));
    const page = sorted.slice(offset, offset + limit);
    const sideCounts = { paternal: 0, maternal: 0, both: 0 };
    if (sides) for (const id of ids) {
        const side = sides.side(id);
        if (side) sideCounts[side]++;
    }

    return {
        person: ref(graph, p.id),
        up,
        down,
        relation: label,
        count: ids.size,
        ...countLiving(graph, ids),
        ...(sides ? { sides: sideCounts } : {}),
        ...(branches.length
            ? { through: branches.slice(0, 6).map((b) => describeBranch(b, sides)) }
            : {}),
        people: page.map((x) =>
            brief(graph, x, {
                ...(sides?.side(x.id) ? { side: sides.side(x.id) } : {}),
                ...(viaOf.get(x.id) ? { through: viaOf.get(x.id) } : {}),
            }),
        ),
        ...(listSide ? { list_filter: listSide } : {}),
        shown: `${page.length ? offset + 1 : 0}-${offset + page.length} of ${sorted.length}`,
        ...(offset + page.length < sorted.length ? { more: sorted.length - offset - page.length } : {}),
    };
}

/* ------------------------------------------------------------------ */
/*  Dispatcher                                                         */
/* ------------------------------------------------------------------ */

export async function runTool(
    name: string,
    rawArgs: string,
    options: { isAdmin?: boolean } = {},
): Promise<{ result: ToolResult; graph: FamilyGraph }> {
    const graph = await getFamilyGraph();
    let args: Record<string, unknown> = {};
    try {
        args = rawArgs ? JSON.parse(rawArgs) : {};
    } catch {
        return { result: { error: 'Arguments were not valid JSON' }, graph };
    }
    if (ADMIN_TOOL_NAMES.has(name) && !options.isAdmin) {
        return { result: { error: 'This lookup is only available to admins.' }, graph };
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
        case 'same_generation_relatives':
            result = sameGenerationRelatives(graph, args);
            break;
        case 'relatives_at_distance':
            result = relativesAtDistanceTool(graph, args);
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
