import { GoogleGenerativeAI } from "@google/generative-ai"
import { supabaseAdmin } from "../services/supabase.js"

const API_KEY = process.env.GEMINI_API_KEY
const MODEL_NAME = "gemini-2.0-flash"
const MAX_HISTORY_LENGTH = 10

const genAI = new GoogleGenerativeAI(API_KEY)

// In-memory store for chat sessions. In a production environment, use a persistent store like Redis or Firestore.
const chatSessions = new Map()

// In-memory cache for avatar personality data.
// Key: avatarId, Value: { system_prompt, persona_role, conversational_context }
const avatarPersonalityCache = new Map()

/**
 * Fetches avatar personality data from Supabase and caches it.
 * @param {string} avatarId The ID of the avatar.
 * @returns {Promise<object|null>} The avatar's personality data or null if not found/error.
 */
export async function getAvatarPersonalityFromDB(avatarId) {
  // Changed to named export
  if (avatarPersonalityCache.has(avatarId)) {
    console.log(`[CACHE] Avatar personality data for ${avatarId} found in cache.`)
    return avatarPersonalityCache.get(avatarId)
  }

  console.log(`[DB] Fetching avatar personality data for ${avatarId} from database.`)
  try {
    const { data, error } = await supabaseAdmin
      .from("avatars")
      .select("system_prompt, persona_role, conversational_context, name, voice_url, image_url, video_url") // Added voice_url and other fields
      .eq("id", avatarId)
      .single()

    if (error) {
      console.error(`[DB] Error fetching avatar personality for ${avatarId}:`, error)
      return null
    }

    if (data) {
      console.log(`[DB] Avatar data fetched successfully for ${data.name} (ID: ${avatarId})`)
      console.log(`[DB] Voice URL: ${data.voice_url ? "Present" : "Missing"}`)
      avatarPersonalityCache.set(avatarId, data)
      return data
    }

    return null
  } catch (err) {
    console.error(`[DB] Unexpected error fetching avatar personality for ${avatarId}:`, err)
    return null
  }
}

/**
 * Gets a Gemini response based on user text and avatar personality.
 * @param {string} sessionId Unique session ID for chat history.
 * @param {string} userText The user's input text.
 * @param {string} avatarId The ID of the avatar for personality context.
 * @param {string} language The desired response language (e.g., 'en', 'hi').
 * @returns {Promise<string>} The generated Gemini text response.
 */
export async function getGeminiResponse(sessionId, userText, avatarId, language = "en") {
  // Changed to named export
  let chatHistory = chatSessions.get(sessionId)
  if (!chatHistory) {
    console.log(`[GEMINI] Initializing new chat session for ${sessionId}.`)
    chatHistory = []
    chatSessions.set(sessionId, chatHistory)
  }

  // Fetch avatar personality data using the cache
  const avatarPersonality = await getAvatarPersonalityFromDB(avatarId)
  if (!avatarPersonality) {
    console.error(`[GEMINI] Could not retrieve avatar personality data for avatar ID: ${avatarId}.`)
    return "I'm sorry, I can't access my personality right now. Could you please try again later?"
  }

  console.log("[GEMINI] Pushing user text to history.")
  chatHistory.push({ role: "user", parts: [{ text: userText }] })

  // Keep chat history within limits
  if (chatHistory.length > MAX_HISTORY_LENGTH) {
    // Remove older messages, keeping the most recent ones for context
    chatHistory = chatHistory.slice(chatHistory.length - MAX_HISTORY_LENGTH)
  }

  const model = genAI.getGenerativeModel({ model: MODEL_NAME })

  // Construct the system instruction using the new avatar fields
  let systemInstruction = `You are an Avatar named ${avatarPersonality.name || "AI Assistant"}.`
  if (avatarPersonality.persona_role) {
    systemInstruction += ` Your role is: ${avatarPersonality.persona_role}.`
  }
  if (avatarPersonality.system_prompt) {
    systemInstruction += ` Your core personality and instructions are: "${avatarPersonality.system_prompt}".`
  }
  if (avatarPersonality.conversational_context) {
    systemInstruction += ` Keep the following context in mind for the conversation and donot give comprehensive responsive just keep them short and to the point: "${avatarPersonality.conversational_context}".`
  }

  // Language instruction
  if (language === "hi") {
    systemInstruction += ` Respond in Hindi, but use a natural, conversational, and slightly informal tone. Avoid overly formal or Sanskritized Hindi. You can use common Hinglish terms if appropriate for the conversation, but primarily stick to Hindi.`
  } else if (language && language !== "en") {
    systemInstruction += ` Respond only in ${getLanguageName(language)}.`
  } else {
    systemInstruction += ` Respond in English.`
  }

  systemInstruction += ` Keep responses concise and natural for a voice conversation.`

  console.log("[GEMINI] Sending message to Gemini API... with system instruction:", systemInstruction)

  try {
    const result = await model.generateContent({
      contents: chatHistory,
      systemInstruction: { parts: [{ text: systemInstruction }] },
    })

    const response = result.response
    const geminiText = response.text()

    console.log("[GEMINI] Received result from Gemini API.")
    console.log(`[GEMINI] Generated response for avatar ${avatarPersonality.name}: ${geminiText}`)

    // Add Gemini's response to history
    chatHistory.push({ role: "model", parts: [{ text: geminiText }] })

    return geminiText
  } catch (error) {
    console.error("[GEMINI] Error calling Gemini API:", error)
    // Provide a fallback response
    return "I'm sorry, I'm having trouble connecting right now. Could you please try again in a moment?"
  }
}

export async function saveChatHistory(userId, avatarId, sessionId) {
  // Changed to named export
  const history = chatSessions.get(sessionId)
  if (history && history.length > 0) {
    try {
      const { data, error } = await supabaseAdmin.from("chat_histories").insert([
        {
          user_id: userId,
          avatar_id: avatarId,
          session_id: sessionId,
          history: history,
          timestamp: new Date().toISOString(),
        },
      ])

      if (error) throw error
      console.log(`[DB] Chat history saved for session ${sessionId}.`)
      chatSessions.delete(sessionId) // Clear from memory after saving
    } catch (error) {
      console.error(`[DB] Error saving chat history for session ${sessionId}:`, error)
    }
  }
}

// Helper to get full language name for prompt
function getLanguageName(code) {
  const languages = {
    en: "English",
    hi: "Hindi",
    es: "Spanish",
    fr: "French",
    de: "German",
    it: "Italian",
    ja: "Japanese",
    ko: "Korean",
    pt: "Portuguese",
    ru: "Russian",
    "zh-cn": "Chinese (Simplified)",
    // Add more as needed
  }
  return languages[code] || code
}
