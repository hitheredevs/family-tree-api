import { Router } from 'express';
import { authMiddleware, adminOnly } from '../middleware/auth-middleware.js';
import * as personController from '../controllers/person-controller.js';

const router = Router();

// All person routes require authentication
router.use(authMiddleware);

// GET    /api/persons          — list all people
router.get('/', personController.list);

// GET    /api/persons/:id      — get single person
router.get('/:id', personController.getById);

// POST   /api/persons          — create person (admin only)
router.post('/', adminOnly, personController.create);

// POST   /api/persons/with-relations — create person + link relatives in one shot (admin only)
router.post('/with-relations', adminOnly, personController.createWithRelations);

// PUT    /api/persons/:id      — update person (permission-checked in controller)
router.put('/:id', personController.update);

// DELETE /api/persons/:id      — soft-delete (admin only)
router.delete('/:id', adminOnly, personController.remove);

// POST /api/persons/:id/merge  { keepId } — move :id's links onto keepId, retire :id
router.post('/:id/merge', adminOnly, personController.merge);

export default router;
