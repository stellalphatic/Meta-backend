import express from 'express';
import { authenticateJWT } from '../controllers/avatarController.js';
import { generateAudio } from '../controllers/audioGenerationController.js';

const router = express.Router();

router.post('/generate', authenticateJWT, generateAudio);

export default router; 

