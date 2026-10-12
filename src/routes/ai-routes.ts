import { Router } from 'express';
import { authMiddleware } from '../middleware/auth-middleware.js';
import * as aiController from '../controllers/ai-controller.js';

const router = Router();

router.use(authMiddleware);

// GET /api/ai/status — whether the assistant is configured
router.get('/status', aiController.status);

// Saved chats of the signed-in user
router.get('/sessions', aiController.listSessions);
router.post('/sessions', aiController.createSession);
router.get('/sessions/:id', aiController.getSession);
router.patch('/sessions/:id', aiController.updateSession);
router.delete('/sessions/:id', aiController.deleteSession);

// POST /api/ai/sessions/:id/messages — ask (streams the answer; id may be "new")
router.post('/sessions/:id/messages', aiController.sendMessage);

// POST /api/ai/chat — old stateless endpoint, kept for cached app versions
router.post('/chat', aiController.chat);

export default router;
