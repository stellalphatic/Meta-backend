// avatar-backend/routes/avatarRoutes.js
const express = require('express');
const { authenticateJWT, getAvatars, createAvatar, updateAvatar, deleteAvatar } = require('../controllers/avatarController');

const router = express.Router();

router.get('/', authenticateJWT, getAvatars);
router.post('/', authenticateJWT, createAvatar);

router.put('/:id', authenticateJWT, updateAvatar);
router.delete('/:id', authenticateJWT, deleteAvatar);

module.exports = router;