// avatar-backend/ws/handler.js
import WebSocket from 'ws';
import { getGeminiResponse, saveChatHistory } from '../services/gemini.js';
import { supabaseAdmin } from '../services/supabase.js'; // Use supabaseAdmin for avatar data fetch
import crypto from 'crypto';

async function handleRealtimeVoiceChat(ws, req) {
    let userId;
    let avatarId;
    let avatarPersonalityData;
    let voiceServiceWs = null;
    let isSpeaking = false;
    let sessionId;

    const DEFAULT_LLM_RESPONSE = "I didn't quite catch that. Could you please repeat?";

    const urlParams = new URLSearchParams(req.url.split('?')[1]);
    // sessionId = urlParams.get('sessionId');
    avatarId = urlParams.get('avatarId');
    const token = urlParams.get('token');

    if ( !avatarId || !token) {
        console.error("Missing sessionId, avatarId, or token in WebSocket URL.");
        ws.send(JSON.stringify({ type: 'error', message: 'Chat initialization failed: Missing session or avatar info.' }));
        ws.close();
        return;
    }

    try {
        // Authenticate with the supabase client directly for user data from token
        const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(token); // Still use supabase (not admin) for auth.getUser
        if (authError || !user) {
            console.error('WebSocket authentication failed:', authError?.message || 'Invalid token');
            ws.send(JSON.stringify({ type: 'error', message: 'Authentication failed. Please log in again.' }));
            ws.close();
            return;
        }
        userId = user.id;
        sessionId = crypto.randomUUID(); // Generate a unique session ID for Gemini

        console.log(`Real-time chat initiated for user: ${userId}, session: ${sessionId}, avatar: ${avatarId}`);

        const { data: avatarData, error: avatarError } = await supabaseAdmin // Use supabaseAdmin for fetching avatar
            .from('avatars')
            .select('personality_data, name, voice_url')
            .eq('id', avatarId)
            .single();

        if (avatarError || !avatarData) {
            await ws.send(JSON.stringify({ type: 'error', message: 'Avatar not found or error loading data.' }));
            console.error("Error loading avatar data:", avatarError);
            ws.close();
            return;
        }

        avatarPersonalityData = avatarData.personality_data;
        const voiceCloneUrl = avatarData.voice_url;

        if (!voiceCloaneUrl) {
            await ws.send(JSON.stringify({ type: 'error', message: 'Avatar has no voice sample URL configured.' }));
            ws.close();
            return;
        }

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
            console.log('Connected to Python Voice Service WS');
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
                        await ws.send(JSON.stringify({ type: 'ready', message: `Chat with ${avatarData.name} ready!` }));
                        break;
                    case 'error':
                        await ws.send(JSON.stringify({ type: 'error', message: `Voice service error: ${pythonMessage.message}` }));
                        break;
                    case 'speech_start':
                        isSpeaking = true;
                        await ws.send(JSON.stringify({ type: 'speech_start' }));
                        break;
                    case 'speech_end':
                        isSpeaking = false;
                        await ws.send(JSON.stringify({ type: 'speech_end' }));
                        break;
                    default:
                        console.log('Unknown Python WS message type:', pythonMessage);
                }
            } else if (event.data instanceof Buffer) {
                await ws.send(event.data);
            }
        };

        voiceServiceWs.onclose = () => {
            console.log('Python Voice Service WS closed.');
            isSpeaking = false;
            ws.send(JSON.stringify({ type: 'system', message: 'Voice service disconnected.' }));
        };

        voiceServiceWs.onerror = (err) => {
            console.error('Python Voice Service WS error:', err);
            isSpeaking = false;
            ws.send(JSON.stringify({ type: 'error', message: 'Voice service connection failed. Please try again.' }));
        };

    } catch (error) {
        console.error('WebSocket handler initialization error:', error);
        ws.send(JSON.stringify({ type: 'error', message: 'Failed to initialize chat session.' }));
        ws.close();
        return;
    }

    ws.on('message', async message => {
        try {
            const parsedMessage = JSON.parse(message.toString());

            if (parsedMessage.type === 'user_text') {
                const userText = parsedMessage.text;
                console.log(`User says: "${userText}"`);

                if (!userId || !avatarId || !voiceServiceWs || voiceServiceWs.readyState !== WebSocket.OPEN) {
                    await ws.send(JSON.stringify({ type: 'error', message: 'Chat not fully initialized or voice service not connected. Please reconnect.' }));
                    return;
                }

                let llmResponseText;
                if (!userText || userText.trim().length < 2) {
                    llmResponseText = DEFAULT_LLM_RESPONSE;
                } else {
                    llmResponseText = await getGeminiResponse(sessionId, userText, avatarPersonalityData);
                }

                console.log(`LLM replies: "${llmResponseText}"`);
                await ws.send(JSON.stringify({ type: 'llm_response_text', text: llmResponseText }));

                await voiceServiceWs.send(JSON.stringify({ type: 'text_to_speak', text: llmResponseText }));

            } else if (parsedMessage.type === 'stop_speaking') {
                if (voiceServiceWs && voiceServiceWs.readyState === WebSocket.OPEN) {
                    console.log('Received stop_speaking command from frontend. Forwarding to Python.');
                    voiceServiceWs.send(JSON.stringify({ type: 'stop_speaking' }));
                }
                isSpeaking = false;
                await ws.send(JSON.stringify({ type: 'speech_end' }));
            }
        } catch (error) {
            console.error('WebSocket message processing error:', error);
            await ws.send(JSON.stringify({ type: 'error', message: 'Server error processing message.' }));
        }
    });

    ws.on('close', async () => {
        console.log('Client disconnected from real-time chat. Cleaning up.');
        if (userId && avatarId && sessionId) {
            await saveChatHistory(userId, avatarId, sessionId);
        }
        if (voiceServiceWs) {
            voiceServiceWs.close();
        }
    });

    ws.on('error', error => {
        console.error('WebSocket error on main connection:', error);
        if (voiceServiceWs) {
            voiceServiceWs.close();
        }
    });
}

export default handleRealtimeVoiceChat ;