// avatar-backend/routes/avatarRoutes.js
import express from 'express';
import { authenticateJWT, getAvatars, createAvatar, updateAvatar, deleteAvatar } from '../controllers/avatarController.js';

const router = express.Router();

router.get('/', authenticateJWT, getAvatars);
router.post('/', authenticateJWT, createAvatar);

router.put('/:id', authenticateJWT, updateAvatar);
router.delete('/:id', authenticateJWT, deleteAvatar);

export default router; 
