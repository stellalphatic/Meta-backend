// avatar-backend/routes/index.js
const express = require('express');
const avatarRoutes = require('./avatarRoutes');
const stripeRoutes = require('./stripeRoutes');

const router = express.Router();

router.use('/avatars', avatarRoutes);
router.use('/stripe', stripeRoutes); // Prefix for Stripe related routes

module.exports = router;