import { Router } from 'express';
import { authMiddleware, adminOnly } from '../middleware/auth-middleware.js';
import * as adminController from '../controllers/admin-controller.js';

const router = Router();

// All admin routes require authentication + admin role
router.use(authMiddleware, adminOnly);

// POST /api/admin/users        — create a user for a person
router.post('/users', adminController.createUser);

// GET  /api/admin/users        — list all users
router.get('/users', adminController.listUsers);

// POST /api/admin/persons/:personId/password-link  — generate setup/reset link
router.post('/persons/:personId/password-link', adminController.generatePasswordLink);

export default router;
