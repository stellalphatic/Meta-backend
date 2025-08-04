// services/gemini.js
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { supabaseAdmin } = require('./supabase'); // Assuming supabaseAdmin is configured for direct DB access

// Access your API key as an environment variable (ensure it's set in your .env or Cloud Run config)
const API_KEY = process.env.GEMINI_API_KEY;
const MODEL_NAME = "gemini-2.0-flash"; // Or "gemini-1.5-flash-latest" for newer models if available and configured
const MAX_HISTORY_LENGTH = 10; // Keep last 10 messages for context

const genAI = new GoogleGenerativeAI(API_KEY);

// In-memory store for chat sessions. In a production environment, use a persistent store like Redis or Firestore.
const chatSessions = new Map();

async function getGeminiResponse(sessionId, userText, avatarPersonalityData, language = 'en') {
    let chatHistory = chatSessions.get(sessionId);

    if (!chatHistory) {
        console.log(`[GEMINI] Initializing new chat session for ${sessionId}.`);
        chatHistory = [];
        chatSessions.set(sessionId, chatHistory);
    }

    console.log('[GEMINI] Pushing user text to history.');
    chatHistory.push({ role: "user", parts: [{ text: userText }] });

    // Keep chat history within limits
    if (chatHistory.length > MAX_HISTORY_LENGTH) {
        // Remove older messages, keeping the most recent ones for context
        chatHistory = chatHistory.slice(chatHistory.length - MAX_HISTORY_LENGTH);
    }

    const model = genAI.getGenerativeModel({ model: MODEL_NAME });

    // Construct the system instruction based on avatar personality and desired language
    let systemInstruction = `You are an AI assistant embodying the following personality: ${avatarPersonalityData}.`;
    
    // NEW: More specific language instruction based on user's preference for Hindi
    if (language === 'hi') {
        systemInstruction += ` Respond in Hindi, but use a natural, conversational, and slightly informal tone. Avoid overly formal or Sanskritized Hindi. You can use common Hinglish terms if appropriate for the conversation, but primarily stick to Hindi.`;
    } else if (language && language !== 'en') {
        systemInstruction += ` Respond only in ${getLanguageName(language)}.`;
    } else {
        systemInstruction += ` Respond in English.`;
    }
    systemInstruction += ` Keep responses concise and natural for a voice conversation.`;


    console.log('[GEMINI] Sending message to Gemini API... with system instruction:', systemInstruction); // Log the instruction
    try {
        const result = await model.generateContent({
            contents: chatHistory,
            systemInstruction: { parts: [{ text: systemInstruction }] }, // Use systemInstruction
        });

        const response = result.response;
        const geminiText = response.text();
        console.log('[GEMINI] Received result from Gemini API.');
        console.log(`[GEMINI] Gemini response for session ${sessionId}: ${geminiText}`);

        // Add Gemini's response to history
        chatHistory.push({ role: "model", parts: [{ text: geminiText }] });

        return geminiText;

    } catch (error) {
        console.error('[GEMINI] Error calling Gemini API:', error);
        // Provide a fallback response
        return "I'm sorry, I'm having trouble connecting right now. Could you please try again in a moment?";
    }
}

async function saveChatHistory(userId, avatarId, sessionId) {
    const history = chatSessions.get(sessionId);
    if (history && history.length > 0) {
        try {
            const { data, error } = await supabaseAdmin
                .from('chat_histories')
                .insert([
                    {
                        user_id: userId,
                        avatar_id: avatarId,
                        session_id: sessionId,
                        history: history,
                        timestamp: new Date().toISOString()
                    }
                ]);

            if (error) throw error;
            console.log(`[DB] Chat history saved for session ${sessionId}.`);
            chatSessions.delete(sessionId); // Clear from memory after saving
        } catch (error) {
            console.error(`[DB] Error saving chat history for session ${sessionId}:`, error);
        }
    }
}

// Helper to get full language name for prompt
function getLanguageName(code) {
    const languages = {
        'en': 'English',
        'hi': 'Hindi',
        'es': 'Spanish',
        'fr': 'French',
        'de': 'German',
        'it': 'Italian',
        'ja': 'Japanese',
        'ko': 'Korean',
        'pt': 'Portuguese',
        'ru': 'Russian',
        'zh-cn': 'Chinese (Simplified)',
        // Add more as needed
    };
    return languages[code] || code;
}


module.exports = { getGeminiResponse, saveChatHistory };
