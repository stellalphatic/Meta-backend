// avatar-backend/app.js (or server.js)
require('dotenv').config();
const express = require('express'); 
const cors = require('cors');
const WebSocket = require('ws');
const http = require('http');
const url = require('url'); // Import the URL module to parse paths

const { handleRealtimeVoiceChat } = require('./ws/handler');
const apiRoutes = require('./routes');
const { handleStripeWebhook } = require('./controllers/stripeController');

const app = express(); 
const PORT = process.env.PORT || 5000;

const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true }); // Important: noServer to handle upgrades manually

app.use(cors());

// --- Stripe Webhook Endpoint (MUST be before express.json()) ---
// app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), handleStripeWebhook);

// --- Apply global JSON body parser for most API routes ---
app.use(express.json());

// --- API Routes ---
app.use('/api', apiRoutes);

// --- WebSocket Connection Handling ---
// wss.on('connection', (ws, req) => {
//     console.log('Client connected to WebSocket for real-time chat');
//     handleRealtimeVoiceChat(ws, req);
// });


// --- WebSocket Upgrade Handling ---
server.on('upgrade', function upgrade(request, socket, head) {
    const pathname = url.parse(request.url).pathname;

    if (pathname === '/ws/chat' || pathname === '/chat') { // Handle both /ws/chat and /chat for flexibility
        wss.handleUpgrade(request, socket, head, function done(ws) {
            console.log('Client connected to WebSocket for real-time chat (Path: /chat)');
            handleRealtimeVoiceChat(ws, request); // Pass the original request to the handler
        });
    } else if (pathname === '/ws/audio-call' || pathname === '/audio-call') {
        wss.handleUpgrade(request, socket, head, function done(ws) {
            console.log('Client connected to WebSocket for audio call (Path: /audio-call)');
            // For now, let handleRealtimeVoiceChat handle this too,
            // but in a real app, you'd have a specific audio call handler here.
            handleRealtimeVoiceChat(ws, request); // Can reuse for now, but will need adaptation
        });
    } else if (pathname === '/ws/video-call' || pathname === '/video-call') {
        wss.handleUpgrade(request, socket, head, function done(ws) {
            console.log('Client connected to WebSocket for video call (Path: /video-call)');
            // Dedicated video call handler here
            handleRealtimeVoiceChat(ws, request); // Can reuse for now, but will need adaptation
        });
    } else {
        socket.destroy(); // Reject unknown WebSocket connections
    }
});


// Start the server (listen on the HTTP server, which also handles WebSockets)
server.listen(PORT, () => {
    console.log(`Backend server running on port ${PORT}`);
    console.log(`WebSocket server running on ws://localhost:${PORT}/ws`);
});