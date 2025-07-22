const { getGeminiResponse, saveChatHistory } = require('../services/gemini');
const { supabaseAdmin } = require('../services/supabase');
const crypto = require('crypto');

async function handleTextChat(ws, req) {
    let userId;
    let avatarId;
    let avatarPersonalityData;
    let sessionId;

    const DEFAULT_LLM_RESPONSE = "I didn't quite catch that. Could you please repeat?";

    const urlParams = new URLSearchParams(req.url.split('?')[1]);
    avatarId = urlParams.get('avatarId');
    const token = urlParams.get('token');

    if (!avatarId || !token) {
        console.error("Missing avatarId or token in WebSocket URL for text chat.");
        ws.send(JSON.stringify({ type: 'error', message: 'Chat initialization failed: Missing avatar info or token.' }));
        ws.close();
        return;
    }

    try {
        const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(token);
        if (authError || !user) {
            console.error('WebSocket authentication failed for text chat:', authError?.message || 'Invalid token');
            ws.send(JSON.stringify({ type: 'error', message: 'Authentication failed. Please log in again.' }));
            ws.close();
            return;
        }
        userId = user.id;
        sessionId = crypto.randomUUID(); // Generate a unique session ID for Gemini

        console.log(`Text chat initiated for user: ${userId}, session: ${sessionId}, avatar: ${avatarId}`);

        const { data: avatarData, error: avatarError } = await supabaseAdmin
            .from('avatars')
            .select('personality_data, name') // Only need personality_data for text chat
            .eq('id', avatarId)
            .single();

        if (avatarError || !avatarData) {
            await ws.send(JSON.stringify({ type: 'error', message: 'Avatar not found or error loading data.' }));
            console.error("Error loading avatar data for text chat:", avatarError);
            ws.close();
            return;
        }

        avatarPersonalityData = avatarData.personality_data;
        await ws.send(JSON.stringify({ type: 'ready', message: `Text chat with ${avatarData.name} ready!` }));

    } catch (error) {
        console.error('Text chat WebSocket handler initialization error:', error);
        ws.send(JSON.stringify({ type: 'error', message: 'Failed to initialize text chat session.' }));
        ws.close();
        return;
    }

    ws.on('message', async message => {
        try {
            const parsedMessage = JSON.parse(message.toString());

            if (parsedMessage.type === 'text') { // Frontend sends 'text' directly, not 'user_text'
                const userText = parsedMessage.message; // Frontend sends 'message' key
                console.log(`User says (text chat): "${userText}"`);

                if (!userText || userText.trim().length < 2) {
                    llmResponseText = DEFAULT_LLM_RESPONSE;
                } else {
                    llmResponseText = await getGeminiResponse(sessionId, userText, avatarPersonalityData);
                }

                console.log(`LLM replies (text chat): "${llmResponseText}"`);
                await ws.send(JSON.stringify({ type: 'llm_response_text', text: llmResponseText })); // Send text response back

            } else {
                console.log('Unknown message type received for text chat:', parsedMessage.type);
                await ws.send(JSON.stringify({ type: 'error', message: 'Unknown message type.' }));
            }
        } catch (error) {
            console.error('WebSocket message processing error in text chat:', error);
            await ws.send(JSON.stringify({ type: 'error', message: 'Server error processing message.' }));
        }
    });

    ws.on('close', async () => {
        console.log('Client disconnected from text chat. Cleaning up.');
        if (userId && avatarId && sessionId) {
            await saveChatHistory(userId, avatarId, sessionId);
        }
    });

    ws.on('error', error => {
        console.error('WebSocket error on main text chat connection:', error);
    });
}

module.exports = { handleTextChat };