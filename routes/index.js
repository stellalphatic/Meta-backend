const express = require('express');
const avatarRoutes = require('./avatarRoutes');
const audioGenerationRoutes = require('./audioGenerationRoutes'); 
const twoCheckoutRoutes = require('./twoCheckoutRoutes'); 

const router = express.Router();

router.use('/avatars', avatarRoutes);
router.use('/audio', audioGenerationRoutes); 
router.use('/2checkout', twoCheckoutRoutes); 

module.exports = router;
