import express from 'express';
import { authenticateJWT } from '../controllers/avatarController.js';
import { createSale, handleWebhook } from '../controllers/twoCheckoutController.js';

const router = express.Router();

// Route to create a new 2Checkout sale
// This typically follows client-side tokenization or a direct server-to-server integration.
// For simplicity, this example assumes a direct sale creation.
router.post('/create-sale', authenticateJWT, createSale);

// 2Checkout Webhook endpoint for IPN (Instant Payment Notification)
// This is crucial for receiving real-time payment status updates from 2Checkout.
router.post('/webhook', handleWebhook); // Webhooks usually don't need JWT auth as they come from 2Checkout

export default router; 
