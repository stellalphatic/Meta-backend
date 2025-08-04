// avatar-backend/ws/voiceChatHandler.js (Multilingual Support)

const WebSocket = require('ws');
const { getGeminiResponse, saveChatHistory } = require('../services/gemini');
const { supabaseAdmin } = require('../services/supabase');
const crypto = require('crypto');

// Helper function to safely parse incoming WebSocket messages
function parseIncomingMessage(message) {
    let messageString;
    if (typeof message === 'string') {
        messageString = message;
    } else if (message instanceof Buffer || message instanceof ArrayBuffer) {
        try {
            messageString = Buffer.from(message).toString('utf8');
        } catch (e) {
            console.error("Error converting binary message to UTF-8 string:", e);
            return null;
        }
    } else {
        console.warn("Received unsupported WebSocket message type:", typeof message);
        return null;
    }

    try {
        const parsed = JSON.parse(messageString);
        return parsed;
    } catch (e) {
        return null; // Not valid JSON, return null (it might be raw audio or plain text)
    }
}

async function handleVoiceChat(ws, req) {
    let userId;
    let avatarId;
    let avatarPersonalityData;
    let voiceServiceWs = null;
    let isSpeaking = false;
    let sessionId;
    let avatarName;
    let language = 'en'; // NEW: Default language

    const DEFAULT_LLM_RESPONSE = "I'm having a little trouble with my connection. Could you please repeat that?";

    const urlParams = new URLSearchParams(req.url.split('?')[1]);
    avatarId = urlParams.get('avatarId');
    const token = urlParams.get('token'); // Supabase JWT token
    let voiceCloneUrl = urlParams.get('voiceUrl');
    language = urlParams.get('language') || 'en'; // NEW: Get language from URL, default to 'en'

    if (!avatarId || !token) {
        console.error("Missing avatarId or token in WebSocket URL for voice chat.");
        ws.send(JSON.stringify({ type: 'error', message: 'Voice chat initialization failed: Missing avatar info or token.' }));
        ws.close();
        return;
    }

    try {
        const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(token);
        if (authError || !user) {
            console.error('WebSocket authentication failed for voice chat:', authError?.message || 'Invalid token');
            ws.send(JSON.stringify({ type: 'error', message: 'Authentication failed. Please log in again.' }));
            ws.close();
            return;
        }
        userId = user.id;
        sessionId = crypto.randomUUID();

        console.log(`Real-time voice chat initiated for user: ${userId}, session: ${sessionId}, avatar: ${avatarId}, language: ${language}`); // NEW: Log language

        // Fetch avatar data to get personality_data and name, regardless of voiceUrl source
        const { data: avatarDataFromDB, error: avatarError } = await supabaseAdmin
            .from('avatars')
            .select('personality_data, name, voice_url')
            .eq('id', avatarId)
            .single();

        if (avatarError || !avatarDataFromDB) {
            console.error("Error loading avatar data for voice chat:", avatarError);
            await ws.send(JSON.stringify({ type: 'error', message: 'Avatar not found or error loading data.' }));
            ws.close();
            return;
        }
        
        avatarPersonalityData = avatarDataFromDB.personality_data;
        avatarName = avatarDataFromDB.name;
        
        // If voiceCloneUrl was NOT provided in the URL, use the one from Supabase
        if (!voiceCloneUrl) {
            console.warn('voiceUrl not found in WebSocket URL. Using voice_url from Supabase.');
            voiceCloneUrl = avatarDataFromDB.voice_url;
        }

        if (!voiceCloneUrl) {
            console.error('Avatar has no voice sample URL configured for voice chat (after checking URL and DB).');
            await ws.send(JSON.stringify({ type: 'error', message: 'Avatar has no voice sample URL configured for voice chat.' }));
            ws.close();
            return;
        }

        const voiceServiceSecretKey = process.env.VOICE_SERVICE_SECRET_KEY;
        if (!voiceServiceSecretKey) {
            console.error("VOICE_SERVICE_SECRET_KEY environment variable is not set.");
            ws.send(JSON.stringify({ type: 'error', message: 'Server configuration error: Voice service key missing.' }));
            ws.close();
            return;
        }

        // Generate the custom auth token for the Python service
        const timestamp = Math.floor(Date.now() / 1000);
        const stringToSign = `${timestamp}`;
        const signature = crypto.createHmac('sha256', voiceServiceSecretKey).update(stringToSign).digest('hex');
        const payload = `${signature}.${timestamp}`;
        const encodedPayload = Buffer.from(payload).toString('base64url');
        const voiceServiceAuthToken = `VOICE_CLONE_AUTH-${encodedPayload}`;

        const voiceServiceWsUrl = process.env.VOICE_SERVICE_WS_URL;
        voiceServiceWs = new WebSocket(voiceServiceWsUrl, {
            headers: {
                'Authorization': voiceServiceAuthToken,
            },
        });

        voiceServiceWs.onopen = async () => {
            console.log("Connected to Python Voice Service WS for voice chat");
            await voiceServiceWs.send(JSON.stringify({
                type: 'init',
                userId: userId,
                avatarId: avatarId,
                voice_clone_url: voiceCloneUrl,
                language: language, // NEW: Pass language to Python service
            }));
        };

        voiceServiceWs.onmessage = async (event) => {
            const pythonMessage = parseIncomingMessage(event.data);

            if (pythonMessage) {
                if (pythonMessage.type === 'ready') {
                    console.log('Python TTS is ready. Sending ready signal to frontend...');
                    await ws.send(JSON.stringify({ type: 'ready', message: `Voice chat with ${avatarName} ready!` }));
                } else if (pythonMessage.type === 'error') {
                    await ws.send(JSON.stringify({ type: 'error', message: `Voice service error: ${pythonMessage.message}` }));
                } else if (pythonMessage.type === 'speech_start') {
                    isSpeaking = true;
                    await ws.send(JSON.stringify({ type: 'speech_start' }));
                } else if (pythonMessage.type === 'speech_end') {
                    isSpeaking = false;
                    await ws.send(JSON.stringify({ type: 'speech_end' }));
                } else {
                    console.log('Unknown Python WS JSON message type:', pythonMessage);
                }
            } else if (event.data instanceof Buffer || event.data instanceof ArrayBuffer) {
                // This is raw audio from Python service, forward to frontend
                await ws.send(event.data);
            } else {
                console.warn('Unhandled message type from Python service:', typeof event.data, event.data);
            }
        };

        voiceServiceWs.onclose = (event) => {
            console.log('Python Voice Service WS closed for voice chat.', event.code, event.reason);
            isSpeaking = false;
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'system', message: 'Voice service disconnected.' }));
                ws.close(1001, 'Python voice service disconnected');
            }
        };

        voiceServiceWs.onerror = (err) => {
            console.error('Python Voice Service WS error for voice chat:', err);
            isSpeaking = false;
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'error', message: 'Voice service connection failed. Please try again.' }));
                ws.close(1011, 'Voice service error');
            }
        };

    } catch (error) {
        console.error('Voice chat WebSocket handler initialization error:', error);
        ws.send(JSON.stringify({ type: 'error', message: 'Failed to initialize voice chat session.' }));
        ws.close();
        return;
    }

    ws.on('message', async (message) => {
        try {
            const parsedMessage = parseIncomingMessage(message);

            if (parsedMessage && parsedMessage.type === 'user_text') {
                const userText = parsedMessage.text;
                console.log(`[VOICE_CHAT] User says: "${userText}"`);

                if (!userId || !avatarId || !voiceServiceWs || voiceServiceWs.readyState !== WebSocket.OPEN) {
                    console.error('[VOICE_CHAT] Prerequisites not met to send to LLM. Aborting.');
                    await ws.send(JSON.stringify({ type: 'error', message: 'Voice chat not fully initialized or voice service not connected. Please reconnect.' }));
                    return;
                }

                // Call Gemini for LLM response, passing the selected language
                let llmResponseText;
                if (!userText || userText.trim().length < 2) {
                    llmResponseText = DEFAULT_LLM_RESPONSE;
                } else {
                    llmResponseText = await getGeminiResponse(sessionId, userText, avatarPersonalityData, language); // NEW: Pass language
                }

                console.log(`[VOICE_CHAT] LLM replies: "${llmResponseText}"`);
                await ws.send(JSON.stringify({ type: 'llm_response_text', text: llmResponseText }));

                if (voiceServiceWs.readyState === WebSocket.OPEN) {
                    console.log('[VOICE_CHAT] Sending LLM response to Python Voice Service for TTS.');
                    await voiceServiceWs.send(JSON.stringify({ type: 'text_to_speak', text: llmResponseText }));
                } else {
                    console.error('Voice service WebSocket not open, cannot send text for TTS after LLM response.');
                }
            } else if (parsedMessage && parsedMessage.type === 'stop_speaking') {
                if (voiceServiceWs && voiceServiceWs.readyState === WebSocket.OPEN) {
                    console.log('Received stop_speaking command from frontend. Forwarding to Python.');
                    voiceServiceWs.send(JSON.stringify({ type: 'stop_speaking' }));
                }
                isSpeaking = false;
                await ws.send(JSON.stringify({ type: 'speech_end' }));
            } else {
                console.log('DEBUG: UNHANDLED message type or content after parsing attempt:', typeof message, parsedMessage);
                await ws.send(JSON.stringify({ type: 'error', message: 'Unknown or unhandled message type.' }));
            }
        } catch (error) {
            console.error('[VOICE_CHAT] WebSocket message processing error in main handler:', error);
            console.error('[VOICE_CHAT] Raw message that caused error (attempted as UTF-8):', message ? Buffer.from(message).toString('utf8') : 'N/A');
            await ws.send(JSON.stringify({ type: 'error', message: 'Server error processing message.' }));
        }
    });

    ws.on('close', async () => {
        console.log('[VOICE_CHAT] Client disconnected. Cleaning up.');
        if (userId && avatarId && sessionId) {
            await saveChatHistory(userId, avatarId, sessionId);
        }
        if (voiceServiceWs && voiceServiceWs.readyState === WebSocket.OPEN) {
            console.log('[VOICE_CHAT] Closing Python Voice Service WS because client disconnected.');
            voiceServiceWs.close();
        }
    });

    ws.on('error', (error) => {
        console.error('WebSocket error on main voice chat connection:', error);
        if (voiceServiceWs && voiceServiceWs.readyState === WebSocket.OPEN) {
            console.log('[VOICE_CHAT] Closing Python Voice Service WS due to client error.');
            voiceServiceWs.close();
        }
    });
}

module.exports = { handleVoiceChat };
