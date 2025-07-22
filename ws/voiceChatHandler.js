const WebSocket = require('ws');
const { getGeminiResponse, saveChatHistory } = require('../services/gemini');
const { supabaseAdmin } = require('../services/supabase');
const crypto = require('crypto');

async function handleVoiceChat(ws, req) {
    let userId;
    let avatarId;
    let avatarPersonalityData;
    let voiceServiceWs = null;
    let isSpeaking = false; // Tracks if avatar is currently speaking
    let sessionId;

    const DEFAULT_LLM_RESPONSE = "I didn't quite catch that. Could you please repeat?";

    const urlParams = new URLSearchParams(req.url.split('?')[1]);
    avatarId = urlParams.get('avatarId');
    const token = urlParams.get('token');

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
        sessionId = crypto.randomUUID(); // Generate a unique session ID for Gemini

        console.log(`Real-time voice chat initiated for user: ${userId}, session: ${sessionId}, avatar: ${avatarId}`);

        const { data: avatarData, error: avatarError } = await supabaseAdmin
            .from('avatars')
            .select('personality_data, name, voice_url')
            .eq('id', avatarId)
            .single();

        if (avatarError || !avatarData) {
            await ws.send(JSON.stringify({ type: 'error', message: 'Avatar not found or error loading data.' }));
            console.error("Error loading avatar data for voice chat:", avatarError);
            ws.close();
            return;
        }

        avatarPersonalityData = avatarData.personality_data;
        const voiceCloneUrl = avatarData.voice_url; // Corrected typo here

        if (!voiceCloneUrl) {
            await ws.send(JSON.stringify({ type: 'error', message: 'Avatar has no voice sample URL configured for voice chat.' }));
            ws.close();
            return;
        }

        // --- Python Voice Service Connection ---
        const voiceServiceSecretKey = process.env.VOICE_SERVICE_SECRET_KEY;
        if (!voiceServiceSecretKey) {
            console.error("VOICE_SERVICE_SECRET_KEY environment variable is not set. Voice service connection will fail or be insecure.");
            ws.send(JSON.stringify({ type: 'error', message: 'Server configuration error: Voice service key missing.' }));
            ws.close();
            return;
        }

        const timestamp = Math.floor(Date.now() / 1000);
        const stringToSign = `${timestamp}`;
        const signature = crypto.createHmac('sha256', voiceServiceSecretKey)
                                .update(stringToSign)
                                .digest('hex');

        const payload = `${signature}.${timestamp}`;
        const encodedPayload = Buffer.from(payload).toString('base64url');
        const voiceServiceAuthToken = `VOICE_CLONE_AUTH-${encodedPayload}`;

        const voiceServiceWsUrl = `${process.env.VOICE_SERVICE_WS_URL}?token=${voiceServiceAuthToken}`;
        voiceServiceWs = new WebSocket(voiceServiceWsUrl);

        voiceServiceWs.onopen = async () => {
            console.log('Connected to Python Voice Service WS for voice chat');
            await voiceServiceWs.send(JSON.stringify({
                type: 'init',
                userId: userId,
                avatarId: avatarId,
                voice_clone_url: voiceCloneUrl
            }));
        };

        voiceServiceWs.onmessage = async (event) => {
            if (typeof event.data === 'string') {
                const pythonMessage = JSON.parse(event.data);
                switch (pythonMessage.type) {
                    case 'ready':
                        await ws.send(JSON.stringify({ type: 'ready', message: `Voice chat with ${avatarData.name} ready!` }));
                        break;
                    case 'error':
                        await ws.send(JSON.stringify({ type: 'error', message: `Voice service error: ${pythonMessage.message}` }));
                        break;
                    case 'speech_start':
                        isSpeaking = true;
                        await ws.send(JSON.stringify({ type: 'speech_start' })); // Notify frontend avatar is speaking
                        break;
                    case 'speech_end':
                        isSpeaking = false;
                        await ws.send(JSON.stringify({ type: 'speech_end' })); // Notify frontend avatar stopped speaking
                        break;
                    case 'transcribed_text': // If Python service sends transcribed text
                        console.log('Received transcribed text from Python:', pythonMessage.text);
                        // Process the transcribed text with Gemini
                        if (pythonMessage.text && pythonMessage.text.trim().length > 1) {
                            const llmResponseText = await getGeminiResponse(sessionId, pythonMessage.text, avatarPersonalityData);
                            console.log(`LLM replies (voice chat, from STT): "${llmResponseText}"`);
                            await ws.send(JSON.stringify({ type: 'llm_response_text', text: llmResponseText }));
                            await voiceServiceWs.send(JSON.stringify({ type: 'text_to_speak', text: llmResponseText }));
                        } else {
                            console.log("No meaningful transcription received from Python.");
                            const llmResponseText = DEFAULT_LLM_RESPONSE;
                            await ws.send(JSON.stringify({ type: 'llm_response_text', text: llmResponseText }));
                            await voiceServiceWs.send(JSON.stringify({ type: 'text_to_speak', text: llmResponseText }));
                        }
                        break;
                    default:
                        console.log('Unknown Python WS message type for voice chat:', pythonMessage);
                }
            } else if (event.data instanceof Buffer || event.data instanceof ArrayBuffer) { // Handle ArrayBuffer for browser compatibility
                // This is the audio chunk from Python TTS
                await ws.send(event.data); // Forward binary audio directly to frontend
            }
        };

        voiceServiceWs.onclose = (event) => {
            console.log('Python Voice Service WS closed for voice chat.', event.code, event.reason);
            isSpeaking = false;
            ws.send(JSON.stringify({ type: 'system', message: 'Voice service disconnected.' }));
        };

        voiceServiceWs.onerror = (err) => {
            console.error('Python Voice Service WS error for voice chat:', err);
            isSpeaking = false;
            ws.send(JSON.stringify({ type: 'error', message: 'Voice service connection failed. Please try again.' }));
        };

    } catch (error) {
        console.error('Voice chat WebSocket handler initialization error:', error);
        ws.send(JSON.stringify({ type: 'error', message: 'Failed to initialize voice chat session.' }));
        ws.close();
        return;
    }

    ws.on('message', async message => {
        try {
            // Check if the message is a string (JSON) or binary (audio)
            if (typeof message === 'string') {
                const parsedMessage = JSON.parse(message.toString());

                if (parsedMessage.type === 'user_text') {
                    // This path is for when frontend performs client-side STT
                    const userText = parsedMessage.text;
                    console.log(`User says (voice chat, STT output from frontend): "${userText}"`);

                    if (!userId || !avatarId || !voiceServiceWs || voiceServiceWs.readyState !== WebSocket.OPEN) {
                        await ws.send(JSON.stringify({ type: 'error', message: 'Voice chat not fully initialized or voice service not connected. Please reconnect.' }));
                        return;
                    }

                    let llmResponseText;
                    if (!userText || userText.trim().length < 2) {
                        llmResponseText = DEFAULT_LLM_RESPONSE;
                    } else {
                        llmResponseText = await getGeminiResponse(sessionId, userText, avatarPersonalityData);
                    }

                    console.log(`LLM replies (voice chat): "${llmResponseText}"`);
                    await ws.send(JSON.stringify({ type: 'llm_response_text', text: llmResponseText })); // Send text to frontend for display

                    // Send LLM response text to Python for TTS
                    if (voiceServiceWs.readyState === WebSocket.OPEN) {
                         await voiceServiceWs.send(JSON.stringify({ type: 'text_to_speak', text: llmResponseText }));
                    } else {
                        console.error("Voice service WebSocket not open, cannot send text for TTS.");
                    }


                } else if (parsedMessage.type === 'stop_speaking') {
                    if (voiceServiceWs && voiceServiceWs.readyState === WebSocket.OPEN) {
                        console.log('Received stop_speaking command from frontend. Forwarding to Python.');
                        voiceServiceWs.send(JSON.stringify({ type: 'stop_speaking' }));
                    }
                    isSpeaking = false;
                    await ws.send(JSON.stringify({ type: 'speech_end' })); // Ensure frontend knows speech ended
                } else {
                    console.log('Unknown message type received for voice chat (string):', parsedMessage.type);
                    await ws.send(JSON.stringify({ type: 'error', message: 'Unknown message type.' }));
                }
            } else if (message instanceof Buffer || message instanceof ArrayBuffer) {
                // This path is for when frontend sends raw audio chunks for server-side STT
                if (voiceServiceWs && voiceServiceWs.readyState === WebSocket.OPEN) {
                    voiceServiceWs.send(message); // Forward the raw binary audio to Python for STT
                } else {
                    console.warn('Received audio chunk but Python voice service is not open.');
                }
            }
        } catch (error) {
            console.error('WebSocket message processing error in voice chat:', error);
            await ws.send(JSON.stringify({ type: 'error', message: 'Server error processing message.' }));
        }
    });

    ws.on('close', async () => {
        console.log('Client disconnected from real-time voice chat. Cleaning up.');
        if (userId && avatarId && sessionId) {
            await saveChatHistory(userId, avatarId, sessionId);
        }
        if (voiceServiceWs) {
            voiceServiceWs.close();
        }
    });

    ws.on('error', error => {
        console.error('WebSocket error on main voice chat connection:', error);
        if (voiceServiceWs) {
            voiceServiceWs.close();
        }
    });
}

module.exports = { handleVoiceChat };