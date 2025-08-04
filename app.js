// avatar-backend/app.js
import express from 'express';
import cors from 'cors';
import WebSocket from 'ws'; 
import http from 'http'; 

import mainRouter from './routes/index.js';
import  handleTextChat  from './ws/chatHandler.js';
import  handleVoiceChat  from './ws/voiceChatHandler.js';

const app = express();
const port = process.env.PORT || 5000;

// Get the frontend URL from the environment variables
const frontendUrl = process.env.FRONTEND_URL;
const allowedOrigins = [
  frontendUrl, 
  'http://localhost:3000', // Your local development frontend URL (replace with correct port if different)
  'https://localhost:3000' // Secure version for local testing
];

// CORS configuration object
const corsOptions = {
  origin: function (origin, callback) {
    // Check if the request origin is in our allowed list
    if (allowedOrigins.indexOf(origin) !== -1 || !origin) {
      // The !origin check allows requests from same origin and tools like Postman
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
};

// Middleware
app.use(cors(corsOptions));
app.use(express.json()); // For parsing application/json
app.use(express.urlencoded({ extended: true })); // For parsing application/x-www-form-urlencoded (common for webhooks)

// Routes
app.use('/api', mainRouter); // Use the main router to include all your API routes

// Create HTTP server
const server = http.createServer(app);

// Create WebSocket server attached to the HTTP server
const wss = new WebSocket.Server({ noServer: true });

// Handle WebSocket upgrade requests
server.on('upgrade', function upgrade(request, socket, head) {
    const pathname = new URL(request.url, `http://${request.headers.host}`).pathname;
    const origin = request.headers.origin;

    // Apply CORS check to WebSocket connections as well
    if (allowedOrigins.indexOf(origin) === -1) {
        console.warn(`WebSocket connection from unauthorized origin: ${origin}`);
        socket.destroy();
        return;
    }
    
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
        wss.handleUpgrade(request, socket, head, function done(ws) {
            wss.emit('connection', ws, request, pathname);
        });
        console.log('Video call WebSocket path received. Not fully implemented; closing socket.');
        socket.destroy();
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
        ws.send(JSON.stringify({ type: 'error', message: 'Video call not implemented yet.' }));
        ws.close();
    }
});

server.listen(port, () => {
    console.log(`Backend server running on port ${port}`);
    // These logs are for local dev, the actual URL is the Cloud Run URL
    console.log(`WebSocket server running on ws://localhost:${port}/chat`);
    console.log(`WebSocket server running on ws://localhost:${port}/voice-chat`);
});