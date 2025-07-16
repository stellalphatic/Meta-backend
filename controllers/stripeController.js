// avatar-backend/controllers/stripeController.js
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { supabaseAdmin } = require('../services/supabase');
const { getGeminiResponse } = require('../services/gemini'); // Assuming this might be used for chat

// Function to update user's profile with subscription info
async function updateCustomerSubscription(userId, subscriptionStatus, stripeCustomerId = null) {
    const updateData = {
        current_plan: subscriptionStatus,
        updated_at: new Date().toISOString()
    };
    if (stripeCustomerId) {
        updateData.stripe_customer_id = stripeCustomerId;
    }

    const { error } = await supabaseAdmin // Use supabaseAdmin for profile updates
        .from('profiles')
        .update(updateData)
        .eq('id', userId);

    if (error) {
        console.error('Error updating user profile with subscription:', error);
        throw error;
    }
    console.log(`User ${userId} subscription updated to ${subscriptionStatus}`);
}

const createCheckoutSession = async (req, res) => {
    const userId = req.user.id;
    const { priceId, planName } = req.body;

    if (!priceId || !planName) {
        return res.status(400).json({ message: 'Price ID and plan name are required.' });
    }

    try {
        let customerId;
        const { data: profile, error: profileError } = await supabaseAdmin // Use supabaseAdmin
            .from('profiles')
            .select('stripe_customer_id')
            .eq('id', userId)
            .single();

        if (profileError && profileError.code !== 'PGRST116') {
            throw profileError;
        }

        if (profile?.stripe_customer_id) {
            customerId = profile.stripe_customer_id;
        } else {
            const customer = await stripe.customers.create({
                email: req.user.email,
                metadata: {
                    supabase_user_id: userId,
                },
            });
            customerId = customer.id;

            await supabaseAdmin // Use supabaseAdmin
                .from('profiles')
                .upsert({ id: userId, stripe_customer_id: customerId }, { onConflict: 'id' });
        }

        const session = await stripe.checkout.sessions.create({
            customer: customerId,
            line_items: [{
                price: priceId,
                quantity: 1,
            }],
            mode: 'subscription',
            success_url: `${process.env.FRONTEND_URL}/dashboard?checkout=success&plan=${planName}`,
            cancel_url: `${process.env.FRONTEND_URL}/dashboard?checkout=cancel`,
            metadata: {
                supabase_user_id: userId,
                plan_name: planName
            }
        });

        res.json({ sessionId: session.id, url: session.url });
    } catch (error) {
        console.error('Error creating Stripe checkout session:', error);
        res.status(500).json({ message: 'Failed to create checkout session', error: error.message });
    }
};

const handleStripeWebhook = async (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;

    try {
        event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
        console.error(`Webhook Error: ${err.message}`);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    switch (event.type) {
        case 'checkout.session.completed':
            const checkoutSession = event.data.object;
            const userId = checkoutSession.metadata.supabase_user_id;
            // const subscriptionId = checkoutSession.subscription; // Not used directly in update
            const customerId = checkoutSession.customer;
            const planName = checkoutSession.metadata.plan_name;

            if (userId && planName) {
                await updateCustomerSubscription(userId, planName, customerId);
            }
            break;
        case 'customer.subscription.updated':
            const subscriptionUpdated = event.data.object;
            const userIdFromSubscriptionUpdate = subscriptionUpdated.metadata.supabase_user_id;
            const status = subscriptionUpdated.status;
            const currentPriceId = subscriptionUpdated.items.data[0].price.id;

            if (userIdFromSubscriptionUpdate) {
                let subscriptionStatus = 'Free Plan';
                // Note: Ensure your environment variables for Stripe Price IDs are correctly named
                // and accessible, e.g., process.env.STRIPE_PRICE_ID_CREATOR_MONTHLY
                if (status === 'active') {
                    if (currentPriceId === process.env.STRIPE_PRICE_ID_CREATOR_MONTHLY || currentPriceId === process.env.STRIPE_PRICE_ID_CREATOR_YEARLY) {
                        subscriptionStatus = 'Creator';
                    } else if (currentPriceId === process.env.STRIPE_PRICE_ID_TEAM_MONTHLY || currentPriceId === process.env.STRIPE_PRICE_ID_TEAM_YEARLY) {
                        subscriptionStatus = 'Team';
                    } else if (currentPriceId === process.env.STRIPE_PRICE_ID_ENTERPRISE) {
                        subscriptionStatus = 'Enterprise';
                    } else if (currentPriceId === process.env.STRIPE_PRICE_ID_PRO) { // Assuming 'prod_SflnLtnpn5neoY' is for 'Pro'
                        subscriptionStatus = 'Pro';
                    }
                } else if (['canceled', 'unpaid', 'past_due'].includes(status)) {
                    subscriptionStatus = 'Free Plan';
                }
                await updateCustomerSubscription(userIdFromSubscriptionUpdate, subscriptionStatus);
            }
            break;
        case 'customer.subscription.deleted':
            const subscriptionDeleted = event.data.object;
            const userIdFromSubscriptionDelete = subscriptionDeleted.metadata.supabase_user_id;
            if (userIdFromSubscriptionDelete) {
                await updateCustomerSubscription(userIdFromSubscriptionDelete, 'Free Plan');
            }
            break;
        default:
            console.log(`Unhandled event type ${event.type}`);
    }

    res.json({ received: true });
};

// Endpoint for text-based chat (if not using WS for all chats)
const chatWithGemini = async (req, res) => {
    try {
        const userId = req.user.id;
        const { message, avatarId, personality } = req.body;

        if (!message || !avatarId || !personality) {
            return res.status(400).json({ message: 'Message, avatarId, and personality are required.' });
        }

        const pseudoSessionId = `${userId}-${avatarId}-text-chat`;

        const geminiResponse = await getGeminiResponse(pseudoSessionId, message, personality);

        res.json({ response: geminiResponse });

    } catch (err) {
        console.error('Server error during Gemini text chat:', err);
        res.status(500).json({ message: 'Internal server error during chat.' });
    }
};


module.exports = {
    createCheckoutSession,
    handleStripeWebhook,
    chatWithGemini,
    updateCustomerSubscription // Export if needed elsewhere, though usually internal to controller
};