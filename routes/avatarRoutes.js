// avatar-backend/routes/avatarRoutes.js
const express = require('express');
const { authenticateJWT, getAvatars, createAvatar } = require('../controllers/avatarController');

const router = express.Router();

router.get('/', authenticateJWT, getAvatars);
router.post('/', authenticateJWT, createAvatar);

module.exports = router;