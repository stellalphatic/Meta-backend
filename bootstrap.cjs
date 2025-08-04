// This is our new, reliable entry point.
// It's a CommonJS module to ensure synchronous execution.

const dotenv = require('dotenv');

// Load environment variables immediately and synchronously.
const result = dotenv.config();

if (result.error) {
    console.error('Failed to load .env file:', result.error);
    process.exit(1);
}

console.log('.env file loaded successfully.');

// Now, load and run your ES Module application.
// We use a dynamic import which is a function call,
// ensuring the .env file is loaded first.
import('./server.js').catch(err => {
    console.error('Error starting the server:', err);
});