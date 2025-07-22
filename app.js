// avatar-backend/app.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const WebSocket = require('ws');
const http = require('http');

const mainRouter = require('./routes/index'); // Import your main router
const { handleTextChat } = require('./ws/chatHandler');
const { handleVoiceChat } = require('./ws/voiceChatHandler');

const app = express();
const port = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());

// Routes
app.use('/api', mainRouter); // Use the main router to include all your API routes

// Create HTTP server
const server = http.createServer(app);

// Create WebSocket server attached to the HTTP server
const wss = new WebSocket.Server({ noServer: true });

// Handle WebSocket upgrade requests
server.on('upgrade', function upgrade(request, socket, head) {
    const pathname = new URL(request.url, `http://${request.headers.host}`).pathname;
    console.log(`WebSocket upgrade request for path: ${pathname}`);

    if (pathname === '/chat') {
        wss.handleUpgrade(request, socket, head, function done(ws) {
            wss.emit('connection', ws, request, pathname);
        });
    } else if (pathname === '/voice-chat') {
        wss.handleUpgrade(request, socket, head, function done(ws) {
            wss.emit('connection', ws, request, pathname);
        });
    } else if (pathname === '/video-call') {
        // Handle video call WebSocket here (placeholder for future implementation)
        wss.handleUpgrade(request, socket, head, function done(ws) {
            wss.emit('connection', ws, request, pathname);
        });
        console.log('Video call WebSocket path received, but not fully implemented.');
        socket.destroy(); // Close for now as not fully implemented
    } else {
        console.warn(`Unknown WebSocket path: ${pathname}. Destroying socket.`);
        socket.destroy();
    }
});

wss.on('connection', function connection(ws, req, pathname) {
    console.log(`Client connected to WebSocket (Path: ${pathname})`);
    if (pathname === '/chat') {
        handleTextChat(ws, req);
    } else if (pathname === '/voice-chat') {
        handleVoiceChat(ws, req);
    } else if (pathname === '/video-call') {
        // handleVideoCall(ws, req); // Future video call handler
        ws.send(JSON.stringify({ type: 'error', message: 'Video call not implemented yet.' }));
        ws.close();
    }
});

// Start the server
server.listen(port, () => {
    console.log(`Backend server running on port ${port}`);
    console.log(`WebSocket server running on ws://localhost:${port}/chat`);
    console.log(`WebSocket server running on ws://localhost:${port}/voice-chat`);
});