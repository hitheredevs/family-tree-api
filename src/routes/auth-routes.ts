import { Router } from 'express';
import * as authController from '../controllers/auth-controller.js';
import { authMiddleware } from '../middleware/auth-middleware.js';

const router = Router();

// POST /api/auth/login
router.post('/login', authController.login);

// POST /api/auth/logout
router.post('/logout', authController.logout);

// PUT /api/auth/change-password (requires token)
router.put('/change-password', authMiddleware, authController.changePassword);

// GET /api/auth/password-link?token=...  — validate public password link
router.get('/password-link', authController.getPasswordLinkDetails);

// POST /api/auth/password-link/consume   — consume public password link
router.post('/password-link/consume', authController.consumePasswordLink);

// GET /api/auth/me  (requires token)
router.get('/me', authMiddleware, authController.getMe);

export default router;
