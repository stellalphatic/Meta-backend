import WebSocket from "ws"
import { getGeminiResponse, getAvatarPersonalityFromDB } from "../services/gemini.js"
import { supabaseAdmin } from "../services/supabase.js"
import { updateConversationUsage } from "../middleware/usageLimitMiddleware.js"
import { authenticateWebSocket } from "../middleware/authMiddleware.js"
import crypto from "crypto"
import fetch from "node-fetch"
import dotenv from "dotenv"

dotenv.config()

const videoServiceUrl = process.env.VIDEO_SERVICE_URL || "http://localhost:8000"
const videoServiceApiKey = process.env.VIDEO_SERVICE_API_KEY
const videoServiceWsUrl = process.env.VIDEO_SERVICE_WS_URL || "ws://localhost:8000"
const voiceServiceWsUrl = process.env.VOICE_SERVICE_WS_URL
const voiceServiceSecretKey = process.env.VOICE_SERVICE_SECRET_KEY

// Helper to safely parse incoming messages
function parseIncomingMessage(message) {
  if (typeof message === "string") {
    try {
      return JSON.parse(message)
    } catch (e) {
      return null
    }
  }
  return null
}

async function handleVideoChat(ws, req) {
  let userId, avatarId, avatarDetails, voiceServiceWs, videoServiceWs, sessionId, language
  let isFullyConnected = false
  let connectionTimeout = null
  let conversationStartTime = null
  const chatMessages = []

  const urlParams = new URLSearchParams(req.url.split("?")[1])
  avatarId = urlParams.get("avatarId")
  const token = urlParams.get("token")
  language = urlParams.get("language") || "en"

  if (!avatarId || !token) {
    ws.send(JSON.stringify({ type: "error", message: "Initialization failed: Missing avatar info or token." }))
    ws.close()
    return
  }

  try {
    const user = await authenticateWebSocket(token)
    userId = user.id
    sessionId = crypto.randomUUID()
    conversationStartTime = new Date()

    console.log(`🎥 Video chat initiated for user: ${userId}, session: ${sessionId}, avatar: ${avatarId}`)
    ws.send(JSON.stringify({ type: "connecting", message: "Initializing services..." }))

    avatarDetails = await getAvatarPersonalityFromDB(avatarId)
    if (!avatarDetails || !avatarDetails.image_url || !avatarDetails.voice_url) {
      const missing = !avatarDetails ? "Avatar not found" : !avatarDetails.image_url ? "image" : "voice"
      throw new Error(`Avatar configuration incomplete. Missing ${missing}.`)
    }

    connectionTimeout = setTimeout(() => {
      if (!isFullyConnected) {
        console.error("Connection timeout: One or more services failed to connect in time.")
        ws.send(JSON.stringify({ type: "error", message: "Connection to avatar services timed out. Please try again." }))
        ws.close()
      }
    }, 20000)

    let isVideoReady = false
    let isVoiceReady = false

    const checkFullConnection = () => {
      if (isVideoReady && isVoiceReady && !isFullyConnected) {
        isFullyConnected = true
        clearTimeout(connectionTimeout)
        ws.send(
          JSON.stringify({
            type: "ready",
            message: `Video chat with ${avatarDetails.name} is ready!`,
          }),
        )
        console.log("✅ Video chat fully connected and ready.")
      }
    }

    // 1. Initialize and Connect to Video Service
    ws.send(JSON.stringify({ type: "connecting", message: "Preparing video stream..." }))
    try {
      const initResponse = await fetch(`${videoServiceUrl}/init-stream`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${videoServiceApiKey}`,
        },
        body: JSON.stringify({ session_id: sessionId, image_url: avatarDetails.image_url }),
      })

      if (!initResponse.ok) throw new Error(`Video service init failed: ${await initResponse.text()}`)

      const videoWsUrl = `${videoServiceWsUrl}/stream/${sessionId}`
      videoServiceWs = new WebSocket(videoWsUrl)
      videoServiceWs.binaryType = "arraybuffer"

      videoServiceWs.onopen = () => {
        console.log("✅ Connected to Video Service WebSocket.")
        isVideoReady = true
        checkFullConnection()
      }
      videoServiceWs.onmessage = (event) => {
        // This is a video frame. Prepend a '2' and forward it to the frontend.
        if (ws.readyState === WebSocket.OPEN) {
          const videoHeader = Buffer.from([0x02]) // 0x02 for Video Frame
          const videoFrame = Buffer.from(event.data)
          const messageToSend = Buffer.concat([videoHeader, videoFrame])
          ws.send(messageToSend)
        }
      }
      videoServiceWs.onerror = (error) => console.error("❌ Video Service WebSocket error:", error.message)
      videoServiceWs.onclose = () => {
        console.log("🔌 Video Service WebSocket closed.")
        if (isFullyConnected) ws.close(1011, "Video service disconnected.")
      }
    } catch (error) {
      throw new Error(`Failed to connect to Video Service: ${error.message}`)
    }

    // 2. Initialize and Connect to Voice Service
    ws.send(JSON.stringify({ type: "connecting", message: "Preparing voice stream..." }))
    try {
      const timestamp = Math.floor(Date.now() / 1000)
      const signature = crypto.createHmac("sha256", voiceServiceSecretKey).update(`${timestamp}`).digest("hex")
      const voiceServiceAuthToken = `VOICE_CLONE_AUTH-${Buffer.from(`${signature}.${timestamp}`).toString("base64url")}`

      voiceServiceWs = new WebSocket(voiceServiceWsUrl, { headers: { Authorization: voiceServiceAuthToken } })

      voiceServiceWs.onopen = () => {
        console.log("✅ Connected to Voice Service WebSocket.")
        voiceServiceWs.send(
          JSON.stringify({
            type: "init",
            userId: userId,
            avatarId: avatarId,
            voice_clone_url: avatarDetails.voice_url,
            language: language,
          }),
        )
      }

      voiceServiceWs.onmessage = (event) => {
        const msg = parseIncomingMessage(event.data)
        if (msg) {
          if (msg.type === "ready") {
            console.log("✅ Voice service is ready.")
            isVoiceReady = true
            checkFullConnection()
          } else {
            ws.send(JSON.stringify(msg))
          }
        } else {
          // This is a raw audio chunk (Buffer/ArrayBuffer)
          const audioData = event.data

          // 1. Send audio to the frontend for playback (WITH a header)
          if (ws.readyState === WebSocket.OPEN) {
            const audioHeader = Buffer.from([0x01]) // 0x01 for Audio Chunk
            const audioChunk = Buffer.from(audioData)
            const messageToSend = Buffer.concat([audioHeader, audioChunk])
            ws.send(messageToSend)
          }

          // 2. Send the SAME RAW audio to the video service for lip-sync (NO header)
          if (videoServiceWs && videoServiceWs.readyState === WebSocket.OPEN) {
            videoServiceWs.send(audioData)
          }
        }
      }
      voiceServiceWs.onerror = (error) => console.error("❌ Voice Service WebSocket error:", error.message)
      voiceServiceWs.onclose = () => {
        console.log("🔌 Voice Service WebSocket closed.")
        if (isFullyConnected) ws.close(1011, "Voice service disconnected.")
      }
    } catch (error) {
      throw new Error(`Failed to connect to Voice Service: ${error.message}`)
    }
  } catch (error) {
    console.error("Video chat handler initialization error:", error)
    ws.send(JSON.stringify({ type: "error", message: error.message || "Failed to initialize video chat session." }))
    ws.close()
    return
  }

  ws.on("message", async (message) => {
    if (!isFullyConnected) return

    const parsedMessage = parseIncomingMessage(message)
    if (parsedMessage && parsedMessage.type === "user_text") {
      const userText = parsedMessage.text
      console.log(`[VIDEO_CHAT] User says: "${userText}"`)
      chatMessages.push({ role: "user", parts: [{ text: userText }] })

      try {
        const llmResponseText = await getGeminiResponse(sessionId, userText, avatarId, language)
        console.log(`[VIDEO_CHAT] LLM replies: "${llmResponseText}"`)
        chatMessages.push({ role: "model", parts: [{ text: llmResponseText }] })

        ws.send(JSON.stringify({ type: "llm_response_text", text: llmResponseText }))

        if (voiceServiceWs && voiceServiceWs.readyState === WebSocket.OPEN) {
          voiceServiceWs.send(JSON.stringify({ type: "text_to_speak", text: llmResponseText }))
        }
      } catch (e) {
        console.error("Error getting LLM response or sending to voice service:", e)
        ws.send(JSON.stringify({ type: "error", message: "There was an issue processing my response." }))
      }
    }
  })

  ws.on("close", async () => {
    console.log("[VIDEO_CHAT] Client disconnected. Cleaning up all services.")
    clearTimeout(connectionTimeout)

    if (voiceServiceWs) voiceServiceWs.close()
    if (videoServiceWs) videoServiceWs.close()

    try {
      await fetch(`${videoServiceUrl}/end-stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${videoServiceApiKey}` },
        body: JSON.stringify({ session_id: sessionId }),
      })
      console.log("✅ Video streaming session ended successfully.")
    } catch (error) {
      console.error("Error ending video stream session:", error.message)
    }

    const durationMinutes = (new Date() - conversationStartTime) / (1000 * 60)
    if (durationMinutes > 0.1) {
      await updateConversationUsage(userId, durationMinutes)
    }
  })

  ws.on("error", (error) => {
    console.error("Main WebSocket connection error:", error)
    ws.close()
  })
}

export default handleVideoChat