const crypto = require('crypto');
const fetch = require('node-fetch'); // For making HTTP requests

// 2Checkout API credentials from environment variables
const SELLER_ID = process.env.TWOCHECKOUT_SELLER_ID;
const PRIVATE_KEY = process.env.TWOCHECKOUT_PRIVATE_KEY;
const SECRET_WORD = process.env.TWOCHECKOUT_SECRET_WORD; // For webhook validation
const API_BASE_URL = process.env.TWOCHECKOUT_API_BASE_URL || 'https://api.2checkout.com/rest/6.0/';

/**
 * Generates the 2Checkout HASH for API authentication.
 * @param {string} date RFC 1123 formatted date.
 * @param {number} contentLength Length of the request body.
 * @param {string} urlPath The path part of the URL (e.g., /rest/6.0/sales/).
 * @returns {string} The HMAC-256 hash.
 */
const generate2CheckoutHash = (date, contentLength, urlPath) => {
    const stringToHash = `${SELLER_ID.length}${SELLER_ID}${date.length}${date}${contentLength}${urlPath.length}${urlPath}`;
    const hmac = crypto.createHmac('sha256', PRIVATE_KEY);
    hmac.update(stringToHash);
    return hmac.digest('hex');
};

/**
 * Creates a new sale in 2Checkout.
 * This is a simplified example. In a real application, you might first get a token from the frontend
 * using 2Checkout's client-side SDK (e.g., 2Pay.js) and then pass that token here.
 * @param {object} req Express request object.
 * @param {object} res Express response object.
 */
const createSale = async (req, res) => {
    const { amount, currency, customerDetails, productDetails } = req.body; // Example payload

    if (!amount || !currency || !customerDetails || !productDetails) {
        return res.status(400).json({ message: 'Missing required sale details.' });
    }

    try {
        const urlPath = 'sales/'; // Endpoint for creating sales
        const fullUrl = `${API_BASE_URL}${urlPath}`;
        const date = new Date().toUTCString(); // RFC 1123 date format

        const requestBody = {
            SellerId: SELLER_ID,
            // Example: OrderRef can be your internal order ID
            // OrderRef: `ORDER-${Date.now()}`,
            Items: [
                {
                    Code: productDetails.code, // Your product code in 2Checkout
                    Quantity: productDetails.quantity || 1,
                    Price: amount,
                    Name: productDetails.name,
                    Description: productDetails.description,
                    // Type: 'PRODUCT' // Or 'DIGITAL' etc.
                }
            ],
            Currency: currency,
            Customer: {
                Email: customerDetails.email,
                // FirstName: customerDetails.firstName,
                // LastName: customerDetails.lastName,
                // CountryCode: customerDetails.countryCode, // e.g., 'US'
            },
            // If using client-side tokenization:
            // PaymentMethod: {
            //     RecurringEnabled: true, // if applicable
            //     PaymentMethodData: {
            //         Token: 'YOUR_CLIENT_SIDE_TOKEN',
            //         Type: 'TOKEN'
            //     }
            // }
        };

        const requestBodyString = JSON.stringify(requestBody);
        const contentLength = Buffer.byteLength(requestBodyString, 'utf8');
        const hash = generate2CheckoutHash(date, contentLength, `/${urlPath}`); // Note the leading slash for path

        console.log('[2CHECKOUT] Sending create sale request:', { fullUrl, requestBody, date, hash });

        const response = await fetch(fullUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'X-Avangate-Auth': `algorithm=HMAC-SHA256, time=${date}, hash=${hash}`
            },
            body: requestBodyString
        });

        const responseData = await response.json();

        if (!response.ok) {
            console.error('[2CHECKOUT] Error creating sale:', response.status, responseData);
            return res.status(response.status).json({
                message: 'Failed to create 2Checkout sale.',
                details: responseData.Errors || responseData
            });
        }

        console.log('[2CHECKOUT] Sale created successfully:', responseData);
        res.status(200).json({
            message: 'Sale created successfully. Awaiting payment confirmation.',
            saleDetails: responseData
        });

    } catch (err) {
        console.error('[2CHECKOUT] Server error creating sale:', err);
        res.status(500).json({ message: 'Internal server error during 2Checkout sale creation.', error: err.message });
    }
};

/**
 * Handles 2Checkout Instant Payment Notifications (IPN) webhooks.
 * This is where 2Checkout sends real-time updates about payment status.
 * You MUST validate the incoming webhook signature.
 * @param {object} req Express request object.
 * @param {object} res Express response object.
 */
const handleWebhook = async (req, res) => {
    // 2Checkout IPN data is typically sent as form-urlencoded or JSON,
    // depending on your IPN settings in the 2Checkout control panel.
    // For this example, we assume it's directly in req.body (parsed by express.json() or express.urlencoded()).
    const ipnData = req.body;
    console.log('[2CHECKOUT WEBHOOK] Received IPN:', ipnData);

    // --- 1. Validate the IPN Signature ---
    const receivedSignature = req.headers['x-twilio-signature'] || req.headers['X-Avangate-Signature']; // Check header or body for signature
    if (!receivedSignature && ipnData.HASH) {
        receivedSignature = ipnData.HASH; // Fallback if signature is in body
    }

    if (!receivedSignature) {
        console.warn('[2CHECKOUT WEBHOOK] No signature found in webhook. Aborting.');
        return res.status(400).send('Signature missing');
    }

    // Generate expected hash from IPN data and SECRET_WORD
    // The hashing algorithm for IPN is specific to 2Checkout.
    // It typically involves concatenating specific fields from the IPN data
    // in a defined order, followed by the SECRET_WORD, and then hashing.
    // Refer to 2Checkout IPN documentation for the exact hashing formula.
    // Example (simplified, verify with 2Checkout docs):
    let stringToHash = '';
    // Example: For each field in the IPN data that contributes to the hash, append its length and value.
    // This is highly dependent on the IPN version and configuration.
    // For now, let's use a placeholder.
    // stringToHash += `${ipnData.ORDERSTATUS.length}${ipnData.ORDERSTATUS}`;
    // stringToHash += `${ipnData.SALEDATE.length}${ipnData.SALEDATE}`;
    // ... add other relevant fields ...
    stringToHash = JSON.stringify(ipnData) + SECRET_WORD; // THIS IS A SIMPLIFIED PLACEHOLDER. Replace with actual IPN hashing logic.

    const expectedSignature = crypto.createHash('md5').update(stringToHash).digest('hex'); // IPN often uses MD5

    if (receivedSignature !== expectedSignature) {
        console.error('[2CHECKOUT WEBHOOK] Invalid IPN signature. Possible tampering!');
        return res.status(403).send('Invalid signature');
    }

    // --- 2. Process the IPN Data ---
    const orderStatus = ipnData.ORDERSTATUS; // e.g., 'COMPLETE', 'PENDING', 'REFUND'
    const orderRef = ipnData.ORDERREF; // Your internal order ID if passed during sale creation
    const saleId = ipnData.SALEID; // 2Checkout's unique sale ID
    const paymentAmount = ipnData.IPN_TOTALGENERAL; // Total amount paid

    console.log(`[2CHECKOUT WEBHOOK] IPN Validated. Status: ${orderStatus}, OrderRef: ${orderRef}, SaleId: ${saleId}`);

    try {
        // Here, you would update your database based on the orderStatus
        // For example:
        // if (orderStatus === 'COMPLETE') {
        //     await db.updateOrderStatus(orderRef, 'paid', saleId, paymentAmount);
        //     // Grant user access to premium features, send confirmation email, etc.
        // } else if (orderStatus === 'PENDING') {
        //     await db.updateOrderStatus(orderRef, 'pending');
        // } else if (orderStatus === 'REFUND') {
        //     await db.updateOrderStatus(orderRef, 'refunded');
        // }

        // Respond with a success message (2Checkout expects 'OK' or an empty 200 response)
        res.status(200).send('OK');
    } catch (err) {
        console.error('[2CHECKOUT WEBHOOK] Error processing IPN data:', err);
        // Respond with an error status if your internal processing fails,
        // so 2Checkout might retry the webhook.
        res.status(500).send('Internal server error processing webhook');
    }
};

module.exports = {
    createSale,
    handleWebhook
};
