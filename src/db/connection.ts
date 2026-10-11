import { Sequelize, QueryTypes, type Transaction } from 'sequelize';
import dns from 'dns/promises';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '..', '..', '.env') });

/* ------------------------------------------------------------------ */
/*  Config from environment                                            */
/* ------------------------------------------------------------------ */

const DB_HOST = process.env.DB_HOST ?? 'localhost';
const DB_PORT = Number(process.env.DB_PORT) || 5432;
const DB_NAME = process.env.DB_NAME ?? 'postgres';
const DB_USER = process.env.DB_USER ?? 'postgres';
const DB_PASS = process.env.DB_PASSWORD ?? '';

/* ------------------------------------------------------------------ */
/*  IPv6-aware DNS resolution                                          */
/*  Supabase free-tier is IPv6-only. The system's getaddrinfo may      */
/*  fail to resolve AAAA records, so we resolve manually first.        */
/* ------------------------------------------------------------------ */

async function resolveHost(host: string): Promise<string> {
    // Skip resolution for IPs or localhost
    if (host === 'localhost' || host === '127.0.0.1' || host.includes(':')) {
        return host;
    }

    try {
        const addrs6 = await dns.resolve6(host);
        if (addrs6.length > 0) return addrs6[0];
    } catch { /* fall through */ }

    try {
        const addrs4 = await dns.resolve4(host);
        if (addrs4.length > 0) return addrs4[0];
    } catch { /* fall through */ }

    return host;
}

/* ------------------------------------------------------------------ */
/*  Lazy singleton                                                     */
/* ------------------------------------------------------------------ */

let _instance: Sequelize | null = null;
let _initPromise: Promise<Sequelize> | null = null;

export function getDb(): Promise<Sequelize> {
    if (_instance) return Promise.resolve(_instance);

    if (!_initPromise) {
        _initPromise = (async () => {
            const resolved = await resolveHost(DB_HOST);
            if (resolved !== DB_HOST) {
                console.log(`   DNS: ${DB_HOST} → ${resolved}`);
            }

            _instance = new Sequelize({
                dialect: 'postgres',
                host: resolved,
                port: DB_PORT,
                database: DB_NAME,
                username: DB_USER,
                password: DB_PASS,
                logging: false,
                dialectOptions: {
                    ssl: { require: true, rejectUnauthorized: false },
                },
                pool: { max: 10, min: 2, acquire: 30000, idle: 10000 },
            });

            return _instance;
        })();
    }

    return _initPromise;
}

/* ------------------------------------------------------------------ */
/*  Query helpers — all DB access goes through these                    */
/* ------------------------------------------------------------------ */

/** Pass a transaction to run the statement inside it. */
export interface QueryOptions {
    transaction?: Transaction;
}

/** SELECT — returns array of typed rows */
export async function queryAll<T>(
    sql: string,
    replacements?: Record<string, unknown>,
    options: QueryOptions = {},
): Promise<T[]> {
    const db = await getDb();
    const results = await db.query(sql, {
        replacements,
        type: QueryTypes.SELECT,
        transaction: options.transaction,
    });
    return results as T[];
}

/** SELECT single row or null */
export async function queryOne<T>(
    sql: string,
    replacements?: Record<string, unknown>,
    options: QueryOptions = {},
): Promise<T | null> {
    const rows = await queryAll<T>(sql, replacements, options);
    return rows[0] ?? null;
}

/** INSERT / UPDATE / DELETE / DDL — no result needed */
export async function execute(
    sql: string,
    replacements?: Record<string, unknown>,
    options: QueryOptions = {},
): Promise<void> {
    const db = await getDb();
    await db.query(sql, { replacements, transaction: options.transaction });
}

/**
 * Run `fn` in one transaction: committed if it resolves, rolled back if
 * it throws. With `parent`, joins that transaction instead of opening a
 * new one, so helpers can be called both standalone and from a larger
 * all-or-nothing operation.
 */
export async function withTransaction<T>(
    fn: (t: Transaction) => Promise<T>,
    parent?: Transaction,
): Promise<T> {
    if (parent) return fn(parent);
    const db = await getDb();
    return db.transaction((t) => fn(t));
}
