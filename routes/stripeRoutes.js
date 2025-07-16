// avatar-backend/routes/stripeRoutes.js
const express = require('express');
const { authenticateJWT } = require('../controllers/avatarController'); // Re-use auth middleware
const { createCheckoutSession, chatWithGemini } = require('../controllers/stripeController'); // Removed handleStripeWebhook

const router = express.Router();

// Stripe checkout session endpoint (protected)
router.post('/create-checkout-session', authenticateJWT, createCheckoutSession);

// Text-based chat endpoint (protected)
router.post('/gemini-chat', authenticateJWT, chatWithGemini);

// router.post('/webhook', express.raw({ type: 'application/json' }), handleStripeWebhook); // <--- REMOVE THIS LINE

module.exports = router;