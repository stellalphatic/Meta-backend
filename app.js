// avatar-backend/app.js

// No need for dotenv here, as it's handled by bootstrap.cjs (bootstrap.cjs handles dotenv.config())

import express from 'express';
import cors from 'cors';
import WebSocket from 'ws'; 
import http from 'http';    
import { URL } from 'url'; 

import mainRouter from './routes/index.js';
import handleTextChat from './ws/chatHandler.js';
import handleVoiceChat from './ws/voiceChatHandler.js';

const app = express();
const port = process.env.PORT || 5000;

// Get the frontend URL from the environment variables.
// This variable should be set in your Cloud Run environment.
const frontendUrl = process.env.FRONTEND_URL;

// Normalize the frontend URL by removing any trailing slash.
// This ensures that 'https://metapresence.my/' and 'https://metapresence.my' are treated the same.
const normalizedFrontendUrl = frontendUrl ? frontendUrl.replace(/\/$/, "") : '';

// Define the list of allowed origins for CORS.
// Include your production frontend URL (normalized), and local development URLs.
const allowedOrigins = [
  normalizedFrontendUrl, 
  'http://localhost:3000', // Common local development port for React/Vite
  'https://localhost:3000' // Secure version for local testing
];

// CORS configuration object for Express HTTP routes.
const corsOptions = {
  origin: function (origin, callback) {
    // Normalize the incoming request's origin for comparison.
    const normalizedOrigin = origin ? origin.replace(/\/$/, "") : origin;

    // Allow requests if the origin is in our allowed list, or if it's a same-origin request (origin is undefined/null for same-origin).
    if (allowedOrigins.includes(normalizedOrigin) || !origin) {
      callback(null, true);
    } else {
      // Log the blocked origin for debugging purposes.
      console.error(`CORS blocked for origin: ${origin}`);
      callback(new Error('Not allowed by CORS'));
    }
  },
  // Specify allowed HTTP methods.
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  // Specify allowed headers, crucial for authenticated requests.
  allowedHeaders: ['Content-Type', 'Authorization'],
};

// Middleware for Express HTTP routes.
// Apply the configured CORS middleware.
app.use(cors(corsOptions));
app.use(express.json()); // For parsing application/json bodies.
app.use(express.urlencoded({ extended: true })); // For parsing URL-encoded bodies.

// Routes
app.use('/api', mainRouter); // Use the main router to include all your API routes (e.g., /api/avatars, /api/audio/generate).

// Create HTTP server. WebSocket server will be attached to this.
const server = http.createServer(app);

// Create WebSocket server attached to the HTTP server.
// noServer: true means it won't listen on its own port, but will handle upgrade requests from the HTTP server.
const wss = new WebSocket.Server({ noServer: true });

// Handle WebSocket upgrade requests from the HTTP server.
server.on('upgrade', function upgrade(request, socket, head) {
    // Parse the requested URL to get the pathname (e.g., /chat, /voice-chat).
    const pathname = new URL(request.url, `http://${request.headers.host}`).pathname;
    
    // Get the origin of the WebSocket request.
    const origin = request.headers.origin;
    // Normalize the origin for comparison with allowed origins.
    const normalizedOrigin = origin ? origin.replace(/\/$/, "") : origin;

    // IMPORTANT: Apply a CORS-like check for WebSocket connections.
    // The Express CORS middleware only handles HTTP, not WebSocket upgrade requests.
    if (!allowedOrigins.includes(normalizedOrigin)) {
        console.warn(`WebSocket connection from unauthorized origin: ${origin}. Destroying socket.`);
        socket.destroy(); // Reject the connection if origin is not allowed.
        return; // Stop further processing for unauthorized connections.
    }
    
    console.log(`WebSocket upgrade request for path: ${pathname} from origin: ${origin}`);

    // Handle the upgrade based on the requested path.
    if (pathname === '/chat') {
        wss.handleUpgrade(request, socket, head, function done(ws) {
            wss.emit('connection', ws, request, pathname); // Emit 'connection' event for the chat WebSocket.
        });
    } else if (pathname === '/voice-chat') {
        wss.handleUpgrade(request, socket, head, function done(ws) {
            wss.emit('connection', ws, request, pathname); // Emit 'connection' event for the voice chat WebSocket.
        });
    } else if (pathname === '/video-call') {
        // Placeholder for future video call implementation.
        wss.handleUpgrade(request, socket, head, function done(ws) {
            wss.emit('connection', ws, request, pathname);
        });
        console.log('Video call WebSocket path received. Not fully implemented; closing socket.');
        socket.destroy(); // Close for now as not fully implemented.
    } else {
        // Log and destroy socket for unknown WebSocket paths.
        console.warn(`Unknown WebSocket path: ${pathname}. Destroying socket.`);
        socket.destroy();
    }
});

// WebSocket server 'connection' event handler.
wss.on('connection', function connection(ws, req, pathname) {
    console.log(`Client connected to WebSocket (Path: ${pathname})`);
    if (pathname === '/chat') {
        handleTextChat(ws, req); // Delegate to chat handler.
    } else if (pathname === '/voice-chat') {
        handleVoiceChat(ws, req); // Delegate to voice chat handler.
    } else if (pathname === '/video-call') {
        // Send an error message for unimplemented video calls.
        ws.send(JSON.stringify({ type: 'error', message: 'Video call not implemented yet.' }));
        ws.close(); // Close the connection.
    }
});

// Start the HTTP server.
server.listen(port, () => {
    console.log(`Backend server running on port ${port}`);
    // These console logs are for local development reference.
    // In Cloud Run, the actual external URLs are provided by Cloud Run itself.
    console.log(`WebSocket server running on ws://localhost:${port}/chat`);
    console.log(`WebSocket server running on ws://localhost:${port}/voice-chat`);
});