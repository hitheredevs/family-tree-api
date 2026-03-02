import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

import express from 'express';
import cors from 'cors';
import { getDb } from './db/connection.js';
import apiRoutes from './routes/index.js';
import { errorHandler } from './middleware/error-handler.js';

const app = express();
const PORT = Number(process.env.PORT) || 3001;

/* ------------------------------------------------------------------ */
/*  Middleware                                                         */
/* ------------------------------------------------------------------ */

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

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
        const db = await getDb();
        await db.authenticate();
        console.log('✅  Database connection established');

        app.listen(PORT, () => {
            console.log(`🚀  Server running on http://localhost:${PORT}`);
            console.log(`   Health:  http://localhost:${PORT}/health`);
            console.log(`   API:     http://localhost:${PORT}/api`);
        });
    } catch (err) {
        console.error('❌  Failed to start server:', err);
        process.exit(1);
    }
}

start();
