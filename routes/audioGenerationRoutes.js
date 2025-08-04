const express = require('express');
const { authenticateJWT } = require('../controllers/avatarController'); // Assuming authenticateJWT is in avatarController
const { generateAudio } = require('../controllers/audioGenerationController');

const router = express.Router();

// Route for generating audio from text using a selected voice
router.post('/generate', authenticateJWT, generateAudio);

module.exports = router;
