const express = require('express');
const { authenticateJWT } = require('../controllers/avatarController'); // Assuming authenticateJWT is in avatarController
const { createSale, handleWebhook } = require('../controllers/twoCheckoutController');

const router = express.Router();

// Route to create a new 2Checkout sale
// This typically follows client-side tokenization or a direct server-to-server integration.
// For simplicity, this example assumes a direct sale creation.
router.post('/create-sale', authenticateJWT, createSale);

// 2Checkout Webhook endpoint for IPN (Instant Payment Notification)
// This is crucial for receiving real-time payment status updates from 2Checkout.
router.post('/webhook', handleWebhook); // Webhooks usually don't need JWT auth as they come from 2Checkout

module.exports = router;
