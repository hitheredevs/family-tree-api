/**
 * Server-side layout engine for the family tree.
 *
 * Ported from the client-side `computeTreeLayout()` with key optimizations:
 *   - Topological sort replaces O(n²) iterative fixup (Phase 1.5)
 *   - Hamiltonian DFS capped at cluster size ≤ 8
 *   - Sweep-line O(v log v) for vertical nudge detection
 *   - Stores results in DB so frontend only fetches pre-positioned nodes
 */

import { queryAll, queryOne, execute } from '../db/connection.js';
import type { PersonRow, RelationshipRow } from '../types/index.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('layout-service');

/* ------------------------------------------------------------------ */
/*  Constants — must match frontend PersonNode dimensions              */
/* ------------------------------------------------------------------ */

const H_GAP = 320;
const V_GAP = 600;
const COUPLE_GAP = 200;
const MIN_VERT_GAP = 80;
const NODE_H = 140;
/** Horizontal gap between disconnected family components */
const COMPONENT_GAP = 1500;
/** Initial outward passes (rows placed between parents and children) */
const LAYOUT_PASSES = 2;
/** Gauss-Seidel sweeps (top→bottom, then bottom→top) after the initial passes */
const LAYOUT_SWEEPS = 10;

/* ------------------------------------------------------------------ */
/*  Internal types                                                     */
/* ------------------------------------------------------------------ */

interface LayoutPerson {
    id: string;
    gender: string;
    parentIds: string[];
    childrenIds: string[];
    spouseIds: string[];
    exSpouseIds: string[];
}

interface NodePosition {
    personId: string;
    x: number;
    y: number;
}

/* ------------------------------------------------------------------ */
/*  Data loading                                                       */
/* ------------------------------------------------------------------ */

async function loadAllPeople(): Promise<{
    people: Record<string, LayoutPerson>;
    allIds: string[];
    stored: Map<string, { x: number | null; y: number | null }>;
}> {
    // 1. Every non-deleted person — disconnected islands included, so
    //    nobody is left without layout coordinates. ORDER BY keeps the
    //    input order stable: Postgres returns rows in physical order
    //    otherwise, and every recompute's UPDATE reshuffles that order.
    const rows = await queryAll<{
        id: string;
        gender: string;
        layout_x: number | null;
        layout_y: number | null;
    }>(
        `SELECT id, gender, layout_x, layout_y FROM person
         WHERE is_deleted = false
         ORDER BY id`,
    );

    if (rows.length === 0) return { people: {}, allIds: [], stored: new Map() };

    const allIds = rows.map((r) => r.id);
    const stored = new Map(rows.map((r) => [r.id, { x: r.layout_x, y: r.layout_y }]));

    // 2. All relationships between non-deleted people
    const rels = await queryAll<RelationshipRow>(
        `SELECT r.* FROM relationship r
         INNER JOIN person ps ON ps.id = r.source_person_id AND ps.is_deleted = false
         INNER JOIN person pt ON pt.id = r.target_person_id AND pt.is_deleted = false
         ORDER BY r.source_person_id, r.relationship_type, r.target_person_id`,
    );

    // 3. Build lookup
    const genderMap = new Map(rows.map((r) => [r.id, r.gender]));
    const people: Record<string, LayoutPerson> = {};

    for (const id of allIds) {
        people[id] = {
            id,
            gender: genderMap.get(id) || 'other',
            parentIds: [],
            childrenIds: [],
            spouseIds: [],
            exSpouseIds: [],
        };
    }

    for (const r of rels) {
        const p = people[r.source_person_id];
        if (!p) continue;
        switch (r.relationship_type) {
            case 'CHILD':
                p.parentIds.push(r.target_person_id);
                break;
            case 'PARENT':
                p.childrenIds.push(r.target_person_id);
                break;
            case 'SPOUSE':
                if (r.status === 'divorced') {
                    p.exSpouseIds.push(r.target_person_id);
                } else {
                    p.spouseIds.push(r.target_person_id);
                }
                break;
        }
    }

    return { people, allIds, stored };
}

/**
 * Canonical copy of the graph: people keyed in id order, relative
 * lists de-duplicated, restricted to known people and sorted. Every
 * later step iterates these lists, so this makes the layout a pure
 * function of the data rather than of row order.
 */
function normalizePeople(
    people: Record<string, LayoutPerson>,
): Record<string, LayoutPerson> {
    const clean = (ids: string[]) =>
        [...new Set(ids)].filter((id) => people[id]).sort();
    const out: Record<string, LayoutPerson> = {};
    for (const id of Object.keys(people).sort()) {
        const p = people[id];
        out[id] = {
            id,
            gender: p.gender,
            parentIds: clean(p.parentIds),
            childrenIds: clean(p.childrenIds),
            spouseIds: clean(p.spouseIds),
            exSpouseIds: clean(p.exSpouseIds),
        };
    }
    return out;
}

/* ------------------------------------------------------------------ */
/*  Connected components + deterministic packing                       */
/* ------------------------------------------------------------------ */

function connectedComponents(
    people: Record<string, LayoutPerson>,
): string[][] {
    const unseen = new Set(Object.keys(people));
    const components: string[][] = [];

    while (unseen.size > 0) {
        const start = [...unseen].sort()[0];
        const queue = [start];
        const component: string[] = [];
        unseen.delete(start);

        while (queue.length > 0) {
            const id = queue.shift()!;
            component.push(id);
            const person = people[id];
            const neighbours = [
                ...person.parentIds,
                ...person.childrenIds,
                ...person.spouseIds,
                ...person.exSpouseIds,
            ];
            for (const neighbour of neighbours) {
                if (!unseen.has(neighbour)) continue;
                unseen.delete(neighbour);
                queue.push(neighbour);
            }
        }

        components.push(component.sort());
    }

    return components;
}

/**
 * Deterministic component root: a person with no parents (top
 * generation), ties broken by id. Keeps the layout stable no matter
 * which user triggered the recompute.
 */
function chooseComponentRoot(
    component: string[],
    people: Record<string, LayoutPerson>,
): string {
    const roots = component
        .filter((id) => people[id].parentIds.length === 0)
        .sort();
    return roots[0] ?? component[0];
}

function pickPeople(
    ids: string[],
    people: Record<string, LayoutPerson>,
): Record<string, LayoutPerson> {
    return Object.fromEntries(ids.map((id) => [id, people[id]]));
}

/**
 * Lay out every connected component and pack them side by side:
 * the largest component (the main family) sits first with its root
 * at the origin, smaller islands follow to the right.
 */
function packComponentLayouts(
    input: Record<string, LayoutPerson>,
    stored?: Map<string, { x: number | null; y: number | null }>,
): NodePosition[] {
    const people = normalizePeople(input);
    const components = connectedComponents(people);
    components.sort(
        (a, b) => b.length - a.length || a[0].localeCompare(b[0]),
    );

    const packed: NodePosition[] = [];
    let nextX = 0;

    for (let index = 0; index < components.length; index++) {
        const ids = components[index];
        const rootId = chooseComponentRoot(ids, people);
        // Stored positions are shifted per component; computeLayout puts
        // the root at x = 0, so re-base the hints on the root's old x.
        const rootX = stored?.get(rootId)?.x;
        let previousX: Map<string, number> | undefined;
        if (stored && rootX != null) {
            previousX = new Map();
            for (const id of ids) {
                const x = stored.get(id)?.x;
                if (x != null) previousX.set(id, x - rootX);
            }
        }
        const positions = computeLayout(pickPeople(ids, people), rootId, previousX);
        if (positions.length === 0) continue;

        let minX = Infinity;
        let maxX = -Infinity;
        for (const position of positions) {
            if (position.x < minX) minX = position.x;
            if (position.x > maxX) maxX = position.x;
        }

        const shiftX = index === 0 ? 0 : nextX - minX;
        nextX = maxX + shiftX + COMPONENT_GAP;

        for (const position of positions) {
            packed.push({
                personId: position.personId,
                x: position.x + shiftX,
                y: position.y,
            });
        }
    }

    return packed;
}

/* ------------------------------------------------------------------ */
/*  Generation assignment (optimized — topological sort for fixup)     */
/* ------------------------------------------------------------------ */

/**
 * Process the parent→child graph in topological order and move any
 * child that is level with or above a parent to one row below it.
 * O(n + edges). Returns true if anyone moved.
 */
function pushChildrenBelowParents(
    gen: Map<string, number>,
    people: Record<string, LayoutPerson>,
): boolean {
    const inDegree = new Map<string, number>();
    const childrenOf = new Map<string, string[]>();
    for (const id of gen.keys()) {
        inDegree.set(id, 0);
        childrenOf.set(id, []);
    }
    for (const id of gen.keys()) {
        for (const pid of people[id]?.parentIds ?? []) {
            if (!gen.has(pid)) continue;
            childrenOf.get(pid)!.push(id);
            inDegree.set(id, inDegree.get(id)! + 1);
        }
    }

    const queue: string[] = [];
    for (const [id, deg] of inDegree) if (deg === 0) queue.push(id);

    let moved = false;
    while (queue.length > 0) {
        const id = queue.shift()!;
        const g = gen.get(id)!;
        for (const cid of childrenOf.get(id)!) {
            if (gen.get(cid)! <= g) {
                gen.set(cid, g + 1);
                moved = true;
            }
            const deg = inDegree.get(cid)! - 1;
            inDegree.set(cid, deg);
            if (deg === 0) queue.push(cid);
        }
    }
    return moved;
}

/** Put every spouse / ex-spouse pair on the deeper of their two rows. */
function alignSpouses(
    gen: Map<string, number>,
    people: Record<string, LayoutPerson>,
): boolean {
    let moved = false;
    for (const id of gen.keys()) {
        for (const sid of [...people[id].spouseIds, ...people[id].exSpouseIds]) {
            const g = gen.get(id)!;
            const sg = gen.get(sid);
            if (sg === undefined || sg === g) continue;
            const deeper = Math.max(g, sg);
            gen.set(id, deeper);
            gen.set(sid, deeper);
            moved = true;
        }
    }
    return moved;
}

function assignGenerations(
    people: Record<string, LayoutPerson>,
    centerId: string,
): Map<string, number> {
    const gen = new Map<string, number>();

    // Phase 1 — parent/child BFS (no spouse hops)
    const pcQueue: string[] = [centerId];
    gen.set(centerId, 0);

    while (pcQueue.length > 0) {
        const id = pcQueue.shift()!;
        const person = people[id];
        if (!person) continue;
        const g = gen.get(id)!;

        for (const pid of person.parentIds) {
            if (!people[pid] || gen.has(pid)) continue;
            gen.set(pid, g - 1);
            pcQueue.push(pid);
        }
        for (const cid of person.childrenIds) {
            if (!people[cid] || gen.has(cid)) continue;
            gen.set(cid, g + 1);
            pcQueue.push(cid);
        }
    }

    // Phase 1.5 — children strictly below their parents
    pushChildrenBelowParents(gen, people);

    // Phase 2 — spouse assignment for people only reachable via spouse edges
    const spouseQueue: string[] = [...gen.keys()];
    while (spouseQueue.length > 0) {
        const id = spouseQueue.shift()!;
        const person = people[id];
        if (!person) continue;
        const g = gen.get(id)!;
        const allSpouses = [...person.spouseIds, ...person.exSpouseIds];

        for (const sid of allSpouses) {
            if (people[sid] && !gen.has(sid)) {
                gen.set(sid, g);
                spouseQueue.push(sid);
                // Transitively assign parents/children of this newly placed person
                const subQueue = [sid];
                while (subQueue.length > 0) {
                    const subId = subQueue.shift()!;
                    const subPerson = people[subId];
                    if (!subPerson) continue;
                    const sg = gen.get(subId)!;
                    for (const pid of subPerson.parentIds) {
                        if (!people[pid] || gen.has(pid)) continue;
                        gen.set(pid, sg - 1);
                        subQueue.push(pid);
                        spouseQueue.push(pid);
                    }
                    for (const cid of subPerson.childrenIds) {
                        if (!people[cid] || gen.has(cid)) continue;
                        gen.set(cid, sg + 1);
                        subQueue.push(cid);
                        spouseQueue.push(cid);
                    }
                }
            }
        }
    }

    // Phase 3 — spouses share a row AND children stay below parents.
    // Moving a spouse down can put them level with their own children,
    // so re-run the parent/child pass until neither step changes
    // anything. Both only ever move people down, so this settles; the
    // cap only guards against impossible data (someone married to
    // their own descendant).
    for (let pass = 0; pass < 100; pass++) {
        const spousesMoved = alignSpouses(gen, people);
        const childrenMoved = pushChildrenBelowParents(gen, people);
        if (!spousesMoved && !childrenMoved) break;
    }

    return gen;
}

/* ------------------------------------------------------------------ */
/*  Row layout — place units within a generation row                   */
/* ------------------------------------------------------------------ */

/** Places one generation row into posMap and returns its units in order. */
function layoutRow(
    ids: string[],
    y: number,
    people: Record<string, LayoutPerson>,
    posMap: Map<string, { x: number; y: number }>,
    hintMap: Map<string, { x: number; y: number }>,
): string[][] {
    const getPos = (id: string) => posMap.get(id) || hintMap.get(id);

    const avgXOf = (relIds: string[]): number | null => {
        const xs = relIds
            .map((rid) => getPos(rid))
            .filter(Boolean)
            .map((p) => p!.x);
        return xs.length > 0 ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
    };

    const avgRelX = (id: string) => {
        const p = people[id];
        return p ? avgXOf([...p.parentIds, ...p.childrenIds]) : null;
    };

    /* ---- build spouse-cluster units ---- */

    const placed = new Set<string>();
    const idsSet = new Set(ids);
    const units: string[][] = [];

    for (const id of ids) {
        if (placed.has(id)) continue;
        placed.add(id);

        const cluster = new Set<string>([id]);
        const spouseQueue = [id];
        while (spouseQueue.length > 0) {
            const curr = spouseQueue.shift()!;
            const p = people[curr];
            if (!p) continue;
            const allSpouses = [...p.spouseIds, ...p.exSpouseIds];
            for (const sid of allSpouses) {
                if (idsSet.has(sid) && !cluster.has(sid)) {
                    cluster.add(sid);
                    placed.add(sid);
                    spouseQueue.push(sid);
                }
            }
        }

        const members = [...cluster];

        if (members.length === 1) {
            units.push(members);
        } else if (members.length === 2) {
            const [a, b] = members;
            const rxA = avgRelX(a);
            const rxB = avgRelX(b);
            if (rxA !== null && rxB !== null && rxA !== rxB) {
                units.push(rxA <= rxB ? [a, b] : [b, a]);
            } else {
                if ((people[a]?.gender ?? '') <= (people[b]?.gender ?? '')) {
                    units.push([a, b]);
                } else {
                    units.push([b, a]);
                }
            }
        } else if (members.length <= 8) {
            // Hamiltonian path search — capped at 8 members
            const adjMap = new Map<string, Set<string>>();
            for (const uid of members) adjMap.set(uid, new Set());
            for (const uid of members) {
                const allSp = [...(people[uid]?.spouseIds || []), ...(people[uid]?.exSpouseIds || [])];
                for (const sid of allSp) {
                    if (cluster.has(sid)) {
                        adjMap.get(uid)!.add(sid);
                        adjMap.get(sid)!.add(uid);
                    }
                }
            }

            const chain = findChain(members, adjMap);
            if (chain) {
                const firstHintX = avgRelX(chain[0]);
                const lastHintX = avgRelX(chain[chain.length - 1]);
                if (firstHintX !== null && lastHintX !== null && firstHintX > lastHintX) {
                    chain.reverse();
                }
                units.push(chain);
            } else {
                units.push(hubAndSpoke(members, adjMap, people, avgRelX));
            }
        } else {
            // >8 members — skip Hamiltonian, go directly to hub-and-spoke
            const adjMap = new Map<string, Set<string>>();
            for (const uid of members) adjMap.set(uid, new Set());
            for (const uid of members) {
                const allSp = [...(people[uid]?.spouseIds || []), ...(people[uid]?.exSpouseIds || [])];
                for (const sid of allSp) {
                    if (cluster.has(sid)) {
                        adjMap.get(uid)!.add(sid);
                        adjMap.get(sid)!.add(uid);
                    }
                }
            }
            units.push(hubAndSpoke(members, adjMap, people, avgRelX));
        }
    }

    /* ---- group units by parent family so siblings stay together ---- */

    // A couple where both partners have parents in the tree has two
    // candidate families. Join the one with more units in this row
    // (ties → smallest key) instead of joining neither, which used to
    // float the couple away from both sets of siblings.
    const unitParentKeys = units.map((unit) => {
        const keys = new Set<string>();
        for (const uid of unit) {
            const p = people[uid];
            if (p && p.parentIds.length > 0) keys.add(p.parentIds.join(','));
        }
        return [...keys].sort();
    });
    const keyCount = new Map<string, number>();
    for (const keys of unitParentKeys) {
        for (const k of keys) keyCount.set(k, (keyCount.get(k) ?? 0) + 1);
    }
    const unitFamilyKeys: string[] = units.map((unit, i) => {
        const keys = unitParentKeys[i];
        if (keys.length === 0) return `__indep_${unit[0]}`;
        return keys.reduce((best, k) =>
            keyCount.get(k)! > keyCount.get(best)! ? k : best,
        );
    });

    /* ---- compute ideal center-X for each unit ---- */

    const idealXs = units.map((unit) => {
        const xs: number[] = [];
        for (const uid of unit) {
            const rx = avgRelX(uid);
            if (rx !== null) xs.push(rx);
        }
        return xs.length > 0 ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
    });

    // Tie-break by where the unit sat last pass, so siblings that share
    // the same ideal keep a stable left-to-right order.
    const previousXs = units.map((unit) => {
        const xs = unit.map((uid) => posMap.get(uid)?.x).filter((x): x is number => x !== undefined);
        return xs.length > 0 ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
    });

    const familyGroupMap = new Map<string, number[]>();
    for (let i = 0; i < units.length; i++) {
        const key = unitFamilyKeys[i];
        if (!familyGroupMap.has(key)) familyGroupMap.set(key, []);
        familyGroupMap.get(key)!.push(i);
    }

    const familyGroups = [...familyGroupMap.entries()].map(([_key, indices]) => {
        indices.sort((a, b) => idealXs[a] - idealXs[b] || previousXs[a] - previousXs[b]);
        const groupIdealX =
            indices.reduce((s, i) => s + idealXs[i], 0) / indices.length;
        return { indices, groupIdealX };
    });

    familyGroups.sort((a, b) => a.groupIdealX - b.groupIdealX);

    const order = familyGroups.flatMap((g) => g.indices);
    const sortedUnits = order.map((i) => units[i]);
    const sortedIdealXs = order.map((i) => idealXs[i]);

    /* ---- place units: as close to their ideal X as spacing allows ---- */
    //
    // Keeping the order fixed, choose centres that minimise the total
    // squared distance from each unit's ideal X while keeping at least
    // H_GAP between neighbours. Shifting unit i by the minimum span of
    // everything to its left turns the spacing rule into "shifted
    // centres never decrease", which pool-adjacent-violators solves
    // exactly in O(n). The old left-to-right push only ever moved
    // units right, so crowded rows drifted thousands of units away
    // from the parents/children they were aligned to.

    const unitWidths = sortedUnits.map((u) => (u.length - 1) * COUPLE_GAP);
    const minOffset: number[] = [0];
    for (let i = 1; i < sortedUnits.length; i++) {
        minOffset.push(
            minOffset[i - 1] + unitWidths[i - 1] / 2 + H_GAP + unitWidths[i] / 2,
        );
    }
    const shifted = isotonicNonDecreasing(
        sortedIdealXs.map((x, i) => x - minOffset[i]),
        sortedUnits.map((u) => u.length),
    );
    const unitCenters = shifted.map((s, i) => s + minOffset[i]);

    /* ---- assign positions ---- */

    for (let i = 0; i < sortedUnits.length; i++) {
        const unit = sortedUnits[i];
        const cx = unitCenters[i];
        const startX = cx - ((unit.length - 1) * COUPLE_GAP) / 2;

        for (let j = 0; j < unit.length; j++) {
            posMap.set(unit[j], { x: startX + j * COUPLE_GAP, y });
        }
    }

    return sortedUnits;
}

/**
 * Weighted isotonic regression (pool adjacent violators): the
 * non-decreasing sequence closest to `values` in weighted least squares.
 */
function isotonicNonDecreasing(values: number[], weights: number[]): number[] {
    const blocks: { sum: number; weight: number; start: number; end: number }[] = [];
    for (let i = 0; i < values.length; i++) {
        blocks.push({ sum: values[i] * weights[i], weight: weights[i], start: i, end: i });
        while (blocks.length > 1) {
            const last = blocks[blocks.length - 1];
            const prev = blocks[blocks.length - 2];
            if (prev.sum / prev.weight <= last.sum / last.weight) break;
            prev.sum += last.sum;
            prev.weight += last.weight;
            prev.end = last.end;
            blocks.pop();
        }
    }
    const out = new Array<number>(values.length);
    for (const b of blocks) {
        const mean = b.sum / b.weight;
        for (let i = b.start; i <= b.end; i++) out[i] = mean;
    }
    return out;
}

/* ------------------------------------------------------------------ */
/*  Hamiltonian path (DFS, starts from leaves)                         */
/* ------------------------------------------------------------------ */

function findChain(
    members: string[],
    adjMap: Map<string, Set<string>>,
): string[] | null {
    const leaves = members.filter((m) => (adjMap.get(m)?.size ?? 0) === 1);
    const starts = leaves.length > 0 ? leaves : members;

    for (const start of starts) {
        const visited = new Set<string>([start]);
        const path = [start];

        function dfs(): boolean {
            if (path.length === members.length) return true;
            const curr = path[path.length - 1];
            for (const nb of adjMap.get(curr) || []) {
                if (!visited.has(nb)) {
                    visited.add(nb);
                    path.push(nb);
                    if (dfs()) return true;
                    path.pop();
                    visited.delete(nb);
                }
            }
            return false;
        }

        if (dfs()) return path;
    }
    return null;
}

/* ------------------------------------------------------------------ */
/*  Hub-and-spoke fallback for non-chain spouse graphs                 */
/* ------------------------------------------------------------------ */

function hubAndSpoke(
    members: string[],
    adjMap: Map<string, Set<string>>,
    people: Record<string, LayoutPerson>,
    avgRelX: (id: string) => number | null,
): string[] {
    let hubId = members[0];
    let maxConn = 0;
    for (const uid of members) {
        const conn = adjMap.get(uid)?.size ?? 0;
        if (conn > maxConn) {
            maxConn = conn;
            hubId = uid;
        }
    }

    const spouses = members.filter((uid) => uid !== hubId);
    spouses.sort((a, b) => {
        const rxA = avgRelX(a);
        const rxB = avgRelX(b);
        if (rxA !== null && rxB !== null && rxA !== rxB) return rxA - rxB;
        return (people[a]?.gender ?? '').localeCompare(people[b]?.gender ?? '');
    });

    const leftCount = Math.floor(spouses.length / 2);
    const left = spouses.slice(0, leftCount);
    const right = spouses.slice(leftCount);
    return [...left, hubId, ...right];
}

/* ------------------------------------------------------------------ */
/*  Post-layout: nudge units with overlapping vertical connectors      */
/*  Uses sorted sweep approach — O(v log v)                            */
/* ------------------------------------------------------------------ */

interface VerticalLine {
    x: number;
    familyKey: string;
    memberIds: string[];
    yTop: number;
    yBot: number;
}

function nudgeOverlappingVerticals(
    people: Record<string, LayoutPerson>,
    posMap: Map<string, { x: number; y: number }>,
    positions: NodePosition[],
    units: string[][],
) {
    const familyMap = new Map<string, { parentIds: string[]; childIds: string[] }>();
    for (const person of Object.values(people)) {
        if (person.parentIds.length > 0 && posMap.has(person.id)) {
            const key = [...person.parentIds].sort().join(',');
            if (!familyMap.has(key)) {
                familyMap.set(key, { parentIds: [...person.parentIds].sort(), childIds: [] });
            }
            familyMap.get(key)!.childIds.push(person.id);
        }
    }

    const verticals: VerticalLine[] = [];

    for (const [familyKey, family] of familyMap) {
        const parentPositions = family.parentIds
            .filter((pid) => posMap.has(pid))
            .map((pid) => ({ id: pid, ...posMap.get(pid)! }));
        if (parentPositions.length === 0) continue;

        const childPositions = family.childIds
            .filter((cid) => posMap.has(cid))
            .map((cid) => ({ id: cid, ...posMap.get(cid)! }));
        if (childPositions.length === 0) continue;

        const parentBottomY = parentPositions[0].y;
        const childTopY = Math.min(...childPositions.map((c) => c.y));
        const junctionX =
            parentPositions.reduce((s, p) => s + p.x, 0) / parentPositions.length;
        const allMemberIds = [...family.parentIds, ...family.childIds].filter(
            (id) => posMap.has(id),
        );

        verticals.push({
            x: junctionX,
            familyKey,
            memberIds: allMemberIds,
            yTop: parentBottomY,
            yBot: childTopY,
        });

        for (const child of childPositions) {
            verticals.push({
                x: child.x,
                familyKey,
                memberIds: allMemberIds,
                yTop: parentBottomY,
                yBot: childTopY,
            });
        }
    }

    // Sort by X — only check adjacent pairs (sweep-line approach)
    verticals.sort((a, b) => a.x - b.x);

    const familyNudge = new Map<string, number>();

    for (let i = 0; i < verticals.length - 1; i++) {
        const a = verticals[i];
        const b = verticals[i + 1];
        if (a.familyKey === b.familyKey) continue;

        const gap = Math.abs(b.x - a.x);
        if (gap >= MIN_VERT_GAP) continue;

        const yOverlap = a.yTop < b.yBot && b.yTop < a.yBot;
        if (!yOverlap) continue;

        const needed = MIN_VERT_GAP - gap;
        const halfNudge = Math.ceil(needed / 2);

        if (a.x <= b.x) {
            familyNudge.set(a.familyKey, (familyNudge.get(a.familyKey) ?? 0) - halfNudge);
            familyNudge.set(b.familyKey, (familyNudge.get(b.familyKey) ?? 0) + halfNudge);
        } else {
            familyNudge.set(b.familyKey, (familyNudge.get(b.familyKey) ?? 0) - halfNudge);
            familyNudge.set(a.familyKey, (familyNudge.get(a.familyKey) ?? 0) + halfNudge);
        }
    }

    if (familyNudge.size === 0) return;

    const personNudge = new Map<string, number>();
    for (const [familyKey, nudge] of familyNudge) {
        if (nudge === 0) continue;
        const family = familyMap.get(familyKey);
        if (!family) continue;
        for (const cid of family.childIds) {
            const existing = personNudge.get(cid) ?? 0;
            if (Math.abs(nudge) > Math.abs(existing)) {
                personNudge.set(cid, nudge);
            }
        }
    }

    // Move whole units: nudging one spouse alone squeezed couples
    // together until their nodes overlapped.
    const unitNudge = new Map<string, number>();
    for (const unit of units) {
        let strongest = 0;
        for (const id of unit) {
            const n = personNudge.get(id) ?? 0;
            if (Math.abs(n) > Math.abs(strongest)) strongest = n;
        }
        if (strongest !== 0) for (const id of unit) unitNudge.set(id, strongest);
    }

    for (const pos of positions) {
        const nudge = unitNudge.get(pos.personId);
        if (nudge) {
            pos.x += nudge;
            const mapEntry = posMap.get(pos.personId);
            if (mapEntry) mapEntry.x += nudge;
        }
    }
}

/* ------------------------------------------------------------------ */
/*  Main layout computation                                            */
/* ------------------------------------------------------------------ */

function computeLayout(
    people: Record<string, LayoutPerson>,
    centerId: string,
    previousX?: Map<string, number>,
): NodePosition[] {
    if (!people[centerId]) return [];

    // Step 1: assign generations
    const gen = assignGenerations(people, centerId);

    // Step 2: group by generation
    const rows = new Map<number, string[]>();
    for (const [id, g] of gen) {
        if (!rows.has(g)) rows.set(g, []);
        rows.get(g)!.push(id);
    }

    // Step 3: processing order — outward from center
    const sortedGens = [...rows.keys()].sort((a, b) => {
        const da = Math.abs(a),
            db = Math.abs(b);
        return da !== db ? da - db : a - b;
    });

    // Step 4: initial passes, outward from the center, each row placed
    // between its parents and children
    let posMap = new Map<string, { x: number; y: number }>();

    for (let pass = 0; pass < LAYOUT_PASSES; pass++) {
        // Pass 0 starts from last time's positions when we have them, so
        // one edit nudges the tree instead of rebuilding it from scratch.
        const hintMap =
            pass > 0
                ? new Map(posMap)
                : new Map(
                      [...(previousX ?? new Map<string, number>())].map(
                          ([id, x]) => [id, { x, y: 0 }] as const,
                      ),
                  );
        posMap = new Map();

        for (const g of sortedGens) {
            layoutRow(rows.get(g)!, g * V_GAP, people, posMap, hintMap);
        }
    }

    // Step 5: sweep the rows top→bottom then bottom→top, updating in
    // place, so each row settles against its neighbours' latest
    // positions. Measured on the live tree (1,475 people): average
    // child-to-parents offset 29 → ~11.5 node widths.
    const topDown = [...rows.keys()].sort((a, b) => a - b);
    const bottomUp = [...topDown].reverse();
    for (let sweep = 0; sweep < LAYOUT_SWEEPS; sweep++) {
        for (const g of topDown) layoutRow(rows.get(g)!, g * V_GAP, people, posMap, posMap);
        for (const g of bottomUp) layoutRow(rows.get(g)!, g * V_GAP, people, posMap, posMap);
    }
    const units: string[][] = [];
    for (const g of topDown) {
        units.push(...layoutRow(rows.get(g)!, g * V_GAP, people, posMap, posMap));
    }

    const positions: NodePosition[] = [...posMap].map(([personId, p]) => ({
        personId,
        x: p.x,
        y: p.y,
    }));

    // Step 5.5: nudge overlapping verticals
    nudgeOverlappingVerticals(people, posMap, positions, units);

    // Step 6: shift so center is at (0, 0)
    const centerPos = posMap.get(centerId);
    if (centerPos) {
        const dx = -centerPos.x;
        const dy = -centerPos.y;
        for (const pos of positions) {
            pos.x += dx;
            pos.y += dy;
        }
    }

    return positions;
}

/* ------------------------------------------------------------------ */
/*  Public API                                                         */
/* ------------------------------------------------------------------ */

interface RecomputeResult {
    nodeCount: number;
    durationMs: number;
}

interface RecomputeOptions {
    /** Ignore stored positions and lay the tree out from scratch. */
    fresh?: boolean;
}

/** Positions closer than this to the stored ones are not rewritten. */
const MIN_MOVE = 1;
/** Warm passes after a fresh layout so it starts from a resting point. */
const FRESH_SETTLE_PASSES = 5;

async function doRecompute(options: RecomputeOptions = {}): Promise<RecomputeResult> {
    const start = Date.now();

    const { people, stored } = await loadAllPeople();

    if (Object.keys(people).length === 0) {
        log.warn('No people found for layout');
        return { nodeCount: 0, durationMs: Date.now() - start };
    }

    // Start from the stored positions so an edit only nudges nearby
    // people; a fresh run is for resets (e.g. after an algorithm change).
    let positions = packComponentLayouts(people, options.fresh ? undefined : stored);
    if (options.fresh) {
        // A from-scratch layout isn't a resting point for the warm-started
        // recomputes that follow, so the first edit after a reset would
        // still reshuffle the tree. A few warm passes settle it first
        // (measured: the next no-change recompute then moves ~0 rows).
        for (let i = 0; i < FRESH_SETTLE_PASSES; i++) {
            const settled = new Map(
                positions.map((p) => [
                    p.personId,
                    { x: Math.round(p.x * 100) / 100, y: Math.round(p.y * 100) / 100 },
                ]),
            );
            positions = packComponentLayouts(people, settled);
        }
    }

    // Write only rows that actually moved. updated_at is left alone —
    // it records edits to the person, not where the canvas draws them.
    const changed = positions
        .map((pos) => ({
            id: pos.personId,
            x: Math.round(pos.x * 100) / 100,
            y: Math.round(pos.y * 100) / 100,
        }))
        .filter(({ id, x, y }) => {
            const old = stored.get(id);
            return (
                !old || old.x == null || old.y == null ||
                Math.abs(old.x - x) >= MIN_MOVE || Math.abs(old.y - y) >= MIN_MOVE
            );
        });

    // Build a single UPDATE using unnest for efficiency
    if (changed.length > 0) {
        const ids = changed.map((c) => c.id);
        const xs = changed.map((c) => c.x);
        const ys = changed.map((c) => c.y);

        await execute(
            `UPDATE person
             SET layout_x = data.x, layout_y = data.y
             FROM (
                SELECT unnest(ARRAY[${ids.map((_, i) => `:id${i}`).join(',')}]::uuid[]) AS pid,
                       unnest(ARRAY[${xs.map((_, i) => `:x${i}`).join(',')}]::float8[]) AS x,
                       unnest(ARRAY[${ys.map((_, i) => `:y${i}`).join(',')}]::float8[]) AS y
             ) AS data
             WHERE person.id = data.pid`,
            {
                ...Object.fromEntries(ids.map((id, i) => [`id${i}`, id])),
                ...Object.fromEntries(xs.map((x, i) => [`x${i}`, x])),
                ...Object.fromEntries(ys.map((y, i) => [`y${i}`, y])),
            },
        );
    }

    const durationMs = Date.now() - start;
    log.info('Layout recomputed', {
        nodeCount: positions.length,
        moved: changed.length,
        fresh: Boolean(options.fresh),
        durationMs,
    });
    return { nodeCount: positions.length, durationMs };
}

/* Coalescing latch — concurrent writes share one recompute; if data
 * changed while a pass was running, one more pass runs before the
 * shared promise resolves. */
let _inFlight: Promise<RecomputeResult> | null = null;
let _rerunRequested = false;
let _freshRequested = false;

/**
 * Recompute layout for ALL non-deleted people (every connected
 * component, islands included) and store results in the `layout_x`,
 * `layout_y` columns of the `person` table. For the same data and
 * stored positions the result is the same, whichever person or user
 * triggered it.
 */
export async function recomputeLayout(
    _centerId?: string,
    options: RecomputeOptions = {},
): Promise<RecomputeResult> {
    if (options.fresh) _freshRequested = true;
    if (_inFlight) {
        _rerunRequested = true;
        return _inFlight;
    }

    _inFlight = (async () => {
        let result: RecomputeResult;
        do {
            _rerunRequested = false;
            const fresh = _freshRequested;
            _freshRequested = false;
            result = await doRecompute({ fresh });
        } while (_rerunRequested);
        return result;
    })().finally(() => {
        _inFlight = null;
    });

    return _inFlight;
}

/* ------------------------------------------------------------------ */
/*  Viewport query — return nodes within a bounding box                */
/* ------------------------------------------------------------------ */

export interface ViewportNode {
    id: string;
    x: number;
    y: number;
    firstName: string;
    lastName: string;
    gender: string;
    isDeceased: boolean;
}

export interface ViewportEdge {
    sourceId: string;
    targetId: string;
    type: 'PARENT' | 'CHILD' | 'SPOUSE';
    status: string;
}

export interface ViewportResult {
    nodes: ViewportNode[];
    totalNodes: number;
    totalPeople: number;
}

export async function getTreeViewport(params: {
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
    zoom: number;
}): Promise<ViewportResult> {
    const { minX, maxX, minY, maxY } = params;

    // Expand margin based on zoom to pre-fetch nodes near viewport edges
    const margin = 400 / Math.max(params.zoom, 0.05);
    const qMinX = minX - margin;
    const qMaxX = maxX + margin;
    const qMinY = minY - margin;
    const qMaxY = maxY + margin;

    // Count total laid-out nodes and total people
    const countRow = await queryOne<{ laid_out: string; total: string }>(
        `SELECT
             COUNT(*) FILTER (WHERE layout_x IS NOT NULL) AS laid_out,
             COUNT(*) AS total
         FROM person WHERE is_deleted = false`,
    );
    const totalNodes = parseInt(countRow?.laid_out || '0', 10);
    const totalPeople = parseInt(countRow?.total || '0', 10);

    // Fetch nodes within viewport
    const nodes = await queryAll<{
        id: string;
        layout_x: number;
        layout_y: number;
        first_name: string;
        last_name: string;
        gender: string;
        is_deceased: boolean;
    }>(
        `SELECT id, layout_x, layout_y, first_name, last_name, gender, is_deceased
         FROM person
         WHERE layout_x IS NOT NULL
           AND layout_y IS NOT NULL
           AND is_deleted = false
           AND layout_x BETWEEN :qMinX AND :qMaxX
           AND layout_y BETWEEN :qMinY AND :qMaxY`,
        { qMinX, qMaxX, qMinY, qMaxY },
    );

    const viewportNodes: ViewportNode[] = nodes.map((n) => ({
        id: n.id,
        x: n.layout_x,
        y: n.layout_y,
        firstName: n.first_name,
        lastName: n.last_name,
        gender: n.gender,
        isDeceased: n.is_deceased,
    }));

    return { nodes: viewportNodes, totalNodes, totalPeople };
}

/* ------------------------------------------------------------------ */
/*  Get ALL edges (loaded once on mount, not per-viewport)             */
/* ------------------------------------------------------------------ */

export async function getAllEdges(): Promise<ViewportEdge[]> {
    // The renderer only draws PARENT and SPOUSE edges (CHILD rows are
    // the mirror of PARENT rows) — skip the redundant half of the payload.
    const edges = await queryAll<RelationshipRow>(
        `SELECT r.* FROM relationship r
         JOIN person p1 ON p1.id = r.source_person_id AND p1.is_deleted = false
         JOIN person p2 ON p2.id = r.target_person_id AND p2.is_deleted = false
         WHERE r.relationship_type IN ('PARENT', 'SPOUSE')`,
    );
    return edges.map((e) => ({
        sourceId: e.source_person_id,
        targetId: e.target_person_id,
        type: e.relationship_type,
        status: e.status,
    }));
}

/* Exported for offline layout checks (scripts/tests); not part of the HTTP API. */
export { packComponentLayouts };
export type { LayoutPerson, NodePosition };
