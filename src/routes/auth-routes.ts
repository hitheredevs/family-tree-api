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

// POST /api/auth/phone-otp/request (requires token)
router.post('/phone-otp/request', authMiddleware, authController.requestPhoneOtp);

// POST /api/auth/phone-otp/verify (requires token)
router.post('/phone-otp/verify', authMiddleware, authController.verifyPhoneOtp);

// POST /api/auth/forgot-password/request
router.post('/forgot-password/request', authController.requestForgotPasswordOtp);

// POST /api/auth/forgot-password/reset
router.post('/forgot-password/reset', authController.resetPasswordWithOtp);

// POST /api/auth/forgot-password/whatsapp-reset  (WhatsApp-verified identity)
router.post('/forgot-password/whatsapp-reset', authController.resetPasswordWithWhatsApp);

// GET /api/auth/me  (requires token)
router.get('/me', authMiddleware, authController.getMe);

export default router;
