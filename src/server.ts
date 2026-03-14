import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import { getDb } from './db/connection.js';
import apiRoutes from './routes/index.js';
import { errorHandler } from './middleware/error-handler.js';
import { createLogger } from './utils/logger.js';

const log = createLogger('server');

const app = express();
const PORT = Number(process.env.PORT) || 3001;

/* ------------------------------------------------------------------ */
/*  Middleware                                                         */
/* ------------------------------------------------------------------ */

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

// HTTP request logging
app.use(morgan('combined'));

// Log every incoming request with key details
app.use((req, _res, next) => {
    log.info(`→ ${req.method} ${req.originalUrl}`, {
        ip: req.ip,
        userAgent: req.get('User-Agent'),
        contentLength: req.get('Content-Length'),
        authorization: req.headers.authorization ? 'Bearer ***' : undefined,
    });
    next();
});

/* ------------------------------------------------------------------ */
/*  Routes                                                             */
/* ------------------------------------------------------------------ */

// Health check
app.get('/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// All API routes under /api
app.use('/api', apiRoutes);

/* ------------------------------------------------------------------ */
/*  Error handler (must be last)                                       */
/* ------------------------------------------------------------------ */

app.use(errorHandler);

/* ------------------------------------------------------------------ */
/*  Start                                                              */
/* ------------------------------------------------------------------ */

async function start() {
    try {
        log.info('Starting server...', { port: PORT, nodeEnv: process.env.NODE_ENV });

        const db = await getDb();
        await db.authenticate();
        log.info('Database connection established');

        app.listen(PORT, () => {
            log.info(`Server running on http://localhost:${PORT}`, {
                health: `http://localhost:${PORT}/health`,
                api: `http://localhost:${PORT}/api`,
            });
        });
    } catch (err) {
        log.error('Failed to start server', {
            error: err instanceof Error ? err.message : String(err),
            stack: err instanceof Error ? err.stack : undefined,
        });
        process.exit(1);
    }
}

start();
