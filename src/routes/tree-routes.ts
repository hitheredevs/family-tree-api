import { Router } from 'express';
import { authMiddleware } from '../middleware/auth-middleware.js';
import * as treeController from '../controllers/tree-controller.js';

const router = Router();

// All tree routes require authentication
router.use(authMiddleware);

// GET /api/tree/edges                  — all edges (loaded once on mount)
router.get('/edges', treeController.getAllEdges);

// GET /api/tree/:personId              — get subtree centered on person
router.get('/:personId', treeController.getSubtree);

// GET /api/tree/:personId/layout       — slim subtree for tree rendering
router.get('/:personId/layout', treeController.getSubtreeLayout);

// GET /api/tree/:personId/ancestors    — get recursive ancestors
router.get('/:personId/ancestors', treeController.getAncestors);

// GET /api/tree/:personId/descendants  — get recursive descendants
router.get('/:personId/descendants', treeController.getDescendants);

// POST /api/tree/:personId/recompute-layout — recompute layout positions
router.post('/:personId/recompute-layout', treeController.recomputeLayout);

// GET /api/tree/viewport               — spatial viewport query
router.get('/', treeController.getTreeViewport);

export default router;
