/**
 * Kinship engine — works out what one person is to another
 * ("TO is FROM's paternal uncle · Chacha / Taya").
 *
 * Pure functions over a people map, no I/O. The same file lives in the
 * UI repo (src/utils/kinship.ts) so the instant "How are we related?"
 * tool and the AI assistant always agree. Keep the two copies in sync.
 */

export interface KinPerson {
    id: string;
    gender: string;
    parentIds: string[];
    childrenIds: string[];
    spouseIds?: string[];
    exSpouseIds?: string[];
}

export type KinStep = 'parent' | 'child' | 'spouse' | 'ex-spouse';

export interface KinPathStep {
    personId: string;
    /** How this person was reached from the previous one */
    step: KinStep;
}

export type KinshipKind =
    | 'self'
    | 'blood'
    | 'marriage'
    | 'in-law'
    | 'step'
    | 'extended'
    | 'none';

export interface Kinship {
    /** What TO is to FROM, e.g. "Paternal uncle". Empty when not connected. */
    label: string;
    /** Urdu/Hindi family word when there is a common one, e.g. "Chacha / Taya" */
    term: string | null;
    /** Possessive chain from FROM, e.g. "Father's brother's wife" */
    chain: string;
    /** Another way they are related (families with cousin marriages), e.g. "Second cousin" */
    also: string | null;
    /** Shortest connection from FROM to TO (excluding FROM), null when not connected */
    path: KinPathStep[] | null;
    kind: KinshipKind;
}

type People = Record<string, KinPerson> | Map<string, KinPerson>;

const get = (people: People, id: string): KinPerson | undefined =>
    people instanceof Map ? people.get(id) : people[id];

const isMale = (p?: KinPerson) => p?.gender === 'male';
const isFemale = (p?: KinPerson) => p?.gender === 'female';

function g(p: KinPerson | undefined, male: string, female: string, neutral: string): string {
    if (isMale(p)) return male;
    if (isFemale(p)) return female;
    return neutral;
}

const ORDINALS = ['', 'First', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth', 'Seventh', 'Eighth'];
const TIMES = ['', 'once', 'twice', 'three times', 'four times', 'five times'];

function greats(n: number): string {
    if (n <= 0) return '';
    if (n === 1) return 'Great-';
    if (n === 2) return 'Great-great-';
    return `${n}× great-`;
}

/** Alternative relationships further than this are not worth mentioning */
const MAX_ALSO_STEPS = 4;

function lowerFirst(s: string): string {
    return s ? s[0].toLowerCase() + s.slice(1) : s;
}

function upperFirst(s: string): string {
    return s ? s[0].toUpperCase() + s.slice(1) : s;
}

/* ------------------------------------------------------------------ */
/*  Ancestors                                                          */
/* ------------------------------------------------------------------ */

/** Every ancestor of `id` (including itself at depth 0) with the path up to it. */
function ancestorsOf(people: People, id: string): Map<string, string[]> {
    const result = new Map<string, string[]>([[id, [id]]]);
    let frontier = [id];
    while (frontier.length > 0) {
        const next: string[] = [];
        for (const current of frontier) {
            const path = result.get(current)!;
            for (const parentId of get(people, current)?.parentIds ?? []) {
                if (result.has(parentId) || !get(people, parentId)) continue;
                result.set(parentId, [...path, parentId]);
                next.push(parentId);
            }
        }
        frontier = next;
    }
    return result;
}

interface BloodLink {
    /** Generations from FROM up to the common ancestor */
    up: number;
    /** Generations from the common ancestor down to TO */
    down: number;
    /** FROM, FROM's parent, … common ancestor */
    fromPath: string[];
    /** TO, TO's parent, … common ancestor */
    toPath: string[];
}

function bloodLink(people: People, fromId: string, toId: string): BloodLink | null {
    const fromUp = ancestorsOf(people, fromId);
    const toUp = ancestorsOf(people, toId);
    let best: BloodLink | null = null;
    for (const [ancestorId, fromPath] of fromUp) {
        const toPath = toUp.get(ancestorId);
        if (!toPath) continue;
        const up = fromPath.length - 1;
        const down = toPath.length - 1;
        if (
            !best ||
            up + down < best.up + best.down ||
            (up + down === best.up + best.down && Math.max(up, down) < Math.max(best.up, best.down))
        ) {
            best = { up, down, fromPath, toPath };
        }
    }
    return best;
}

/* ------------------------------------------------------------------ */
/*  Blood relationship names                                           */
/* ------------------------------------------------------------------ */

interface Named {
    label: string;
    term: string | null;
}

function nameBlood(people: People, link: BloodLink, fromId: string, toId: string): Named {
    const to = get(people, toId);
    const { up, down } = link;
    // FROM's parent on the way up, and TO's parent on the way up
    const fromParent = get(people, link.fromPath[1]);
    const toParent = get(people, link.toPath[1]);

    if (up === 0 && down === 0) return { label: 'Self', term: null };

    // TO is a descendant of FROM
    if (up === 0) {
        if (down === 1) return { label: g(to, 'Son', 'Daughter', 'Child'), term: g(to, 'Beta', 'Beti', '') || null };
        // FROM's child on the way down
        const via = get(people, link.toPath[down - 1]);
        if (down === 2) {
            const term = isMale(via)
                ? g(to, 'Pota', 'Poti', '')
                : isFemale(via)
                  ? g(to, 'Nawasa', 'Nawasi', '')
                  : '';
            return { label: g(to, 'Grandson', 'Granddaughter', 'Grandchild'), term: term || null };
        }
        return {
            label: greats(down - 2) + g(to, 'grandson', 'granddaughter', 'grandchild'),
            term: null,
        };
    }

    // TO is an ancestor of FROM
    if (down === 0) {
        if (up === 1) return { label: g(to, 'Father', 'Mother', 'Parent'), term: g(to, 'Abba', 'Ammi', '') || null };
        const side = isMale(fromParent) ? 'Paternal' : isFemale(fromParent) ? 'Maternal' : '';
        if (up === 2) {
            const term = isMale(fromParent)
                ? g(to, 'Dada', 'Dadi', '')
                : isFemale(fromParent)
                  ? g(to, 'Nana', 'Nani', '')
                  : '';
            const base = g(to, 'grandfather', 'grandmother', 'grandparent');
            return { label: side ? `${side} ${base}` : upperFirst(base), term: term || null };
        }
        if (up === 3) {
            const term = isMale(fromParent)
                ? g(to, 'Pardada', 'Pardadi', '')
                : isFemale(fromParent)
                  ? g(to, 'Parnana', 'Parnani', '')
                  : '';
            return { label: `Great-${g(to, 'grandfather', 'grandmother', 'grandparent')}`, term: term || null };
        }
        return {
            label: greats(up - 2) + g(to, 'grandfather', 'grandmother', 'grandparent'),
            term: null,
        };
    }

    // Siblings
    if (up === 1 && down === 1) {
        const from = get(people, fromId);
        const shared = (from?.parentIds ?? []).filter((id) => to?.parentIds.includes(id));
        const half =
            shared.length === 1 &&
            (from?.parentIds.length ?? 0) >= 2 &&
            (to?.parentIds.length ?? 0) >= 2;
        const base = g(to, 'Brother', 'Sister', 'Sibling');
        return {
            label: half ? `Half-${lowerFirst(base)}` : base,
            term: g(to, 'Bhai', 'Behen', '') || null,
        };
    }

    // Parent's sibling
    if (up === 2 && down === 1) {
        const side = isMale(fromParent) ? 'Paternal' : isFemale(fromParent) ? 'Maternal' : '';
        const base = g(to, 'uncle', 'aunt', 'uncle/aunt');
        let term = '';
        if (isMale(fromParent)) term = g(to, 'Chacha / Taya', 'Phuphi', '');
        else if (isFemale(fromParent)) term = g(to, 'Mamu', 'Khala', '');
        return { label: side ? `${side} ${base}` : upperFirst(base), term: term || null };
    }

    // Sibling's child
    if (up === 1 && down === 2) {
        // TO's parent is FROM's sibling
        let term = '';
        if (isMale(toParent)) term = g(to, 'Bhatija', 'Bhatiji', '');
        else if (isFemale(toParent)) term = g(to, 'Bhanja', 'Bhanji', '');
        return { label: g(to, 'Nephew', 'Niece', 'Nephew/niece'), term: term || null };
    }

    // Grandparent's sibling and beyond
    if (down === 1) {
        return { label: greats(up - 2) + g(to, 'uncle', 'aunt', 'uncle/aunt'), term: null };
    }

    // Sibling's grandchild and beyond
    if (up === 1) {
        return { label: greats(down - 2) + g(to, 'nephew', 'niece', 'nephew/niece'), term: null };
    }

    // Cousins
    const degree = Math.min(up, down) - 1;
    const removed = Math.abs(up - down);
    let label = `${ORDINALS[degree] ?? `${degree}th`} cousin`;
    if (removed > 0) label += ` ${TIMES[removed] ?? `${removed} times`} removed`;

    let term: string | null = null;
    if (up === 2 && down === 2) {
        // FROM's parent and TO's parent are siblings
        const prefix = isMale(fromParent)
            ? isMale(toParent)
                ? 'Chachazad'
                : isFemale(toParent)
                  ? 'Phuphizad'
                  : ''
            : isFemale(fromParent)
              ? isMale(toParent)
                  ? 'Mamuzad'
                  : isFemale(toParent)
                    ? 'Khalazad'
                    : ''
              : '';
        const suffix = g(to, 'bhai', 'behen', '');
        term = prefix && suffix ? `${prefix} ${suffix}` : null;
    }
    return { label, term };
}

/* ------------------------------------------------------------------ */
/*  Shortest path + possessive chain                                   */
/* ------------------------------------------------------------------ */

export function findKinPath(people: People, fromId: string, toId: string): KinPathStep[] | null {
    if (fromId === toId) return [];
    if (!get(people, fromId) || !get(people, toId)) return null;

    const prev = new Map<string, KinPathStep & { from: string }>();
    const seen = new Set<string>([fromId]);
    let frontier = [fromId];
    while (frontier.length > 0) {
        const next: string[] = [];
        for (const id of frontier) {
            const p = get(people, id);
            if (!p) continue;
            const neighbours: KinPathStep[] = [
                ...p.parentIds.map((personId) => ({ personId, step: 'parent' as const })),
                ...p.childrenIds.map((personId) => ({ personId, step: 'child' as const })),
                ...(p.spouseIds ?? []).map((personId) => ({ personId, step: 'spouse' as const })),
                ...(p.exSpouseIds ?? []).map((personId) => ({ personId, step: 'ex-spouse' as const })),
            ];
            for (const n of neighbours) {
                if (seen.has(n.personId) || !get(people, n.personId)) continue;
                seen.add(n.personId);
                prev.set(n.personId, { ...n, from: id });
                if (n.personId === toId) {
                    const path: KinPathStep[] = [];
                    let cursor = toId;
                    while (cursor !== fromId) {
                        const s = prev.get(cursor)!;
                        path.unshift({ personId: s.personId, step: s.step });
                        cursor = s.from;
                    }
                    return path;
                }
                next.push(n.personId);
            }
        }
        frontier = next;
    }
    return null;
}

/** "Father's sister's husband" — parent→child hops are folded into brother/sister. */
export function describeKinPath(people: People, fromId: string, path: KinPathStep[]): string {
    if (path.length === 0) return 'Self';
    const words: string[] = [];
    let current = fromId;
    for (let i = 0; i < path.length; i++) {
        const step = path[i];
        const person = get(people, step.personId);
        const nextStep = path[i + 1];
        if (step.step === 'parent' && nextStep?.step === 'child' && nextStep.personId !== current) {
            const sibling = get(people, nextStep.personId);
            words.push(g(sibling, 'brother', 'sister', 'sibling'));
            current = nextStep.personId;
            i++;
            continue;
        }
        switch (step.step) {
            case 'parent':
                words.push(g(person, 'father', 'mother', 'parent'));
                break;
            case 'child':
                words.push(g(person, 'son', 'daughter', 'child'));
                break;
            case 'spouse':
                words.push(g(person, 'husband', 'wife', 'spouse'));
                break;
            case 'ex-spouse':
                words.push(g(person, 'ex-husband', 'ex-wife', 'ex-spouse'));
                break;
        }
        current = step.personId;
    }
    return upperFirst(words.join("'s "));
}

/* ------------------------------------------------------------------ */
/*  Relationships through marriage                                     */
/* ------------------------------------------------------------------ */

interface MarriageMatch extends Named {
    kind: 'marriage' | 'in-law' | 'step';
    /** Rough distance, compared against the blood distance */
    steps: number;
}

function spousesOf(p?: KinPerson): string[] {
    return [...(p?.spouseIds ?? [])];
}

function viaMarriage(people: People, fromId: string, toId: string): MarriageMatch | null {
    const from = get(people, fromId);
    const to = get(people, toId);
    if (!from || !to) return null;

    if ((from.spouseIds ?? []).includes(toId)) {
        return { label: g(to, 'Husband', 'Wife', 'Spouse'), term: g(to, 'Shohar', 'Biwi', '') || null, kind: 'marriage', steps: 1 };
    }
    if ((from.exSpouseIds ?? []).includes(toId)) {
        return { label: g(to, 'Ex-husband', 'Ex-wife', 'Ex-spouse'), kind: 'marriage', term: null, steps: 1 };
    }

    const candidates: MarriageMatch[] = [];

    // TO is a blood relative of FROM's spouse
    for (const spouseId of spousesOf(from)) {
        const spouse = get(people, spouseId);
        const link = bloodLink(people, spouseId, toId);
        if (!spouse || !link) continue;
        const { up, down } = link;
        const steps = 1 + up + down;
        if (up === 1 && down === 0) {
            candidates.push({ label: g(to, 'Father-in-law', 'Mother-in-law', 'Parent-in-law'), term: g(to, 'Sasur', 'Saas', '') || null, kind: 'in-law', steps });
        } else if (up === 1 && down === 1) {
            let term = '';
            if (isFemale(spouse)) term = g(to, 'Sala', 'Sali', '');
            else if (isMale(spouse)) term = g(to, 'Devar / Jeth', 'Nand', '');
            candidates.push({ label: g(to, 'Brother-in-law', 'Sister-in-law', 'Sibling-in-law'), term: term || null, kind: 'in-law', steps });
        } else if (up === 0 && down === 1) {
            if (from.childrenIds.includes(toId)) continue;
            candidates.push({ label: g(to, 'Stepson', 'Stepdaughter', 'Stepchild'), term: g(to, 'Sautela beta', 'Sauteli beti', '') || null, kind: 'step', steps });
        } else if (up === 2 && down === 0) {
            candidates.push({ label: g(to, 'Grandfather-in-law', 'Grandmother-in-law', 'Grandparent-in-law'), term: null, kind: 'in-law', steps });
        } else {
            const named = nameBlood(people, link, spouseId, toId);
            candidates.push({
                label: `${g(spouse, 'Husband', 'Wife', 'Spouse')}'s ${lowerFirst(named.label)}`,
                term: null,
                kind: 'in-law',
                steps,
            });
        }
    }

    // TO is married to a blood relative of FROM
    for (const relativeId of spousesOf(to)) {
        if (relativeId === fromId) continue;
        const relative = get(people, relativeId);
        const link = bloodLink(people, fromId, relativeId);
        if (!relative || !link) continue;
        const { up, down } = link;
        const steps = 1 + up + down;
        if (up === 0 && down === 1) {
            candidates.push({ label: g(to, 'Son-in-law', 'Daughter-in-law', 'Child-in-law'), term: g(to, 'Damad', 'Bahu', '') || null, kind: 'in-law', steps });
        } else if (up === 1 && down === 1) {
            let term = '';
            if (isMale(relative)) term = g(to, '', 'Bhabhi', '');
            else if (isFemale(relative)) term = g(to, 'Behnoi / Jija', '', '');
            candidates.push({ label: g(to, 'Brother-in-law', 'Sister-in-law', 'Sibling-in-law'), term: term || null, kind: 'in-law', steps });
        } else if (up === 1 && down === 0) {
            if (from.parentIds.includes(toId)) continue;
            candidates.push({ label: g(to, 'Stepfather', 'Stepmother', 'Step-parent'), term: g(to, 'Sautela baap', 'Sauteli maa', '') || null, kind: 'step', steps });
        } else if (up === 2 && down === 1) {
            // Spouse of FROM's parent's sibling
            const fromParent = get(people, link.fromPath[1]);
            let term = '';
            if (isMale(fromParent)) term = isMale(relative) ? g(to, '', 'Chachi / Tai', '') : g(to, 'Phupha', '', '');
            else if (isFemale(fromParent)) term = isMale(relative) ? g(to, '', 'Mumani', '') : g(to, 'Khalu', '', '');
            candidates.push({ label: `${g(to, 'Uncle', 'Aunt', 'Uncle/aunt')} (by marriage)`, term: term || null, kind: 'in-law', steps });
        } else if (up === 0 && down === 2) {
            candidates.push({ label: g(to, 'Grandson-in-law', 'Granddaughter-in-law', 'Grandchild-in-law'), term: null, kind: 'in-law', steps });
        } else if (up === 2 && down === 0) {
            if (link.fromPath.length && bloodLink(people, fromId, toId)?.down === 0) continue;
            candidates.push({ label: `Step-${g(to, 'grandfather', 'grandmother', 'grandparent')}`, term: null, kind: 'step', steps });
        } else {
            const named = nameBlood(people, link, fromId, relativeId);
            candidates.push({
                label: `${named.label}'s ${g(to, 'husband', 'wife', 'spouse')}`,
                term: null,
                kind: 'in-law',
                steps,
            });
        }
    }

    // Both sides married in: spouse's sibling's spouse, child's parents-in-law
    for (const spouseId of spousesOf(from)) {
        const spouse = get(people, spouseId);
        for (const toSpouseId of spousesOf(to)) {
            if (toSpouseId === fromId || toSpouseId === spouseId) continue;
            const toSpouse = get(people, toSpouseId);
            const link = bloodLink(people, spouseId, toSpouseId);
            if (!link || link.up !== 1 || link.down !== 1) continue;
            let term = '';
            if (isFemale(spouse)) term = isFemale(toSpouse) ? g(to, 'Hum-zulf (Saadhu)', '', '') : g(to, '', 'Salhaj', '');
            else if (isMale(spouse)) term = isMale(toSpouse) ? g(to, '', 'Devrani / Jethani', '') : g(to, 'Nandoi', '', '');
            candidates.push({
                label: `${g(spouse, 'Husband', 'Wife', 'Spouse')}'s ${g(toSpouse, 'brother', 'sister', 'sibling')}'s ${g(to, 'husband', 'wife', 'spouse')}`,
                term: term || null,
                kind: 'in-law',
                steps: 3,
            });
        }
    }
    for (const childId of from.childrenIds) {
        for (const childSpouseId of spousesOf(get(people, childId))) {
            if (get(people, childSpouseId)?.parentIds.includes(toId)) {
                candidates.push({
                    label: `Child's ${g(to, 'father-in-law', 'mother-in-law', 'parent-in-law')}`,
                    term: g(to, 'Samdhi', 'Samdhan', '') || null,
                    kind: 'in-law',
                    steps: 3,
                });
            }
        }
    }

    if (candidates.length === 0) return null;
    candidates.sort((a, b) => a.steps - b.steps);
    return candidates[0];
}

/* ------------------------------------------------------------------ */
/*  Public entry point                                                 */
/* ------------------------------------------------------------------ */

/** FROM up to the common ancestor, then down to TO. */
function bloodPath(link: BloodLink): KinPathStep[] {
    const up = link.fromPath.slice(1).map((personId) => ({ personId, step: 'parent' as const }));
    const down = link.toPath
        .slice(0, -1)
        .reverse()
        .map((personId) => ({ personId, step: 'child' as const }));
    return [...up, ...down];
}

/** What TO is to FROM. */
export function describeKinship(people: People, fromId: string, toId: string): Kinship {
    if (fromId === toId) {
        return { label: 'Self', term: null, chain: 'Self', also: null, path: [], kind: 'self' };
    }
    const shortest = findKinPath(people, fromId, toId);
    if (!shortest) {
        return { label: '', term: null, chain: '', also: null, path: null, kind: 'none' };
    }

    const link = bloodLink(people, fromId, toId);
    const blood = link ? nameBlood(people, link, fromId, toId) : null;
    const bloodSteps = link ? link.up + link.down : Infinity;
    const marriage = viaMarriage(people, fromId, toId);
    // Ancestors and descendants: a marriage route there is just the other parent
    const directLine = Boolean(link && (link.up === 0 || link.down === 0));

    if (link && blood && (!marriage || bloodSteps <= marriage.steps)) {
        const path = bloodPath(link);
        return {
            label: blood.label,
            term: blood.term,
            chain: describeKinPath(people, fromId, path),
            also:
                marriage && !directLine && marriage.steps <= MAX_ALSO_STEPS && marriage.label !== blood.label
                    ? marriage.label
                    : null,
            path,
            kind: 'blood',
        };
    }
    const chain = describeKinPath(people, fromId, shortest);
    if (marriage) {
        return {
            label: marriage.label,
            term: marriage.term,
            chain,
            also: blood && bloodSteps <= MAX_ALSO_STEPS && blood.label !== marriage.label ? blood.label : null,
            path: shortest,
            kind: marriage.kind,
        };
    }
    return { label: 'Relative', term: null, chain, also: null, path: shortest, kind: 'extended' };
}
