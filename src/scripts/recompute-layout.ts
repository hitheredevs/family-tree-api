/**
 * One-shot full layout recompute (all components, islands included).
 * Usage: npm run recompute-layout            # start from stored positions
 *        npm run recompute-layout -- --fresh # ignore them, lay out from scratch
 */
import { recomputeLayout } from '../services/layout-service.js';

const fresh = process.argv.includes('--fresh');

recomputeLayout(undefined, { fresh })
    .then((result) => {
        console.log('Layout recomputed:', { ...result, fresh });
        process.exit(0);
    })
    .catch((err) => {
        console.error('Layout recompute failed:', err);
        process.exit(1);
    });
