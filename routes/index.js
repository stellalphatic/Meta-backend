import express from 'express';
import avatarRoutes from './avatarRoutes.js'; 
import audioGenerationRoutes from './audioGenerationRoutes.js'; 
import twoCheckoutRoutes from './twoCheckoutRoutes.js'; 

const router = express.Router();

router.use('/avatars', avatarRoutes);
router.use('/audio', audioGenerationRoutes);
router.use('/2checkout', twoCheckoutRoutes);

export default router; 
