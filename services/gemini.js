// avatar-backend/services/gemini.js
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { supabaseAdmin } = require('./supabase'); // Use supabaseAdmin for database writes

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

const activeConversations = {};

async function getGeminiResponse(sessionId, userText, avatarPersonality) {
    if (!activeConversations[sessionId]) {
        activeConversations[sessionId] = {
            avatarPersonality: avatarPersonality,
            history: [
                { role: "user", parts: [{ text: `You are an AI avatar with the following personality and data : "${avatarPersonality}". You are designed to engage in real-time voice conversations. Respond concisely and naturally, always staying in character. Do not mention that you are an AI or a model. Start by acknowledging the user's input. And strictly donot overexplain any thing. Ask counter questions to user just like normal humans do..` }] },
                { role: "model", parts: [{ text: "Understood! I'm ready to chat." }] }
            ],
            startedAt: new Date()
        };
    }

    const chat = model.startChat({
        history: activeConversations[sessionId].history,
        generationConfig: {
            maxOutputTokens: 200,
        },
    });

    const result = await chat.sendMessage(userText);
    const response = await result.response;
    const text = response.text();

    activeConversations[sessionId].history.push({ role: "user", parts: [{ text: userText }] });
    activeConversations[sessionId].history.push({ role: "model", parts: [{ text: text }] });

    return text;
}

async function saveChatHistory(userId, avatarId, sessionId) {
    const conversation = activeConversations[sessionId];
    if (conversation && conversation.history.length > 2) { // Ensure actual conversation happened beyond initial setup
        try {
            const { data, error } = await supabaseAdmin
                .from('chat_history')
                .insert({
                    user_id: userId,
                    avatar_id: avatarId,
                    session_id: sessionId,
                    chat_messages: conversation.history,
                    started_at: conversation.startedAt.toISOString(),
                    ended_at: new Date().toISOString()
                });

            if (error) throw error;
            console.log(`Chat history saved for session ${sessionId}:`, data);
            delete activeConversations[sessionId]; // Clean up memory
        } catch (e) {
            console.error("Error saving chat history to Supabase:", e);
        }
    } else if (conversation) {
        console.log(`Session ${sessionId} closed with no meaningful chat history to save.`);
        delete activeConversations[sessionId]; // Still clean up if no actual chat
    }
}

module.exports = { getGeminiResponse, saveChatHistory };