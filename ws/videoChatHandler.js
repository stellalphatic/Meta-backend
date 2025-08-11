import WebSocket from "ws"
import { getGeminiResponse, getAvatarPersonalityFromDB } from "../services/gemini.js"
import { supabaseAdmin } from "../services/supabase.js"
import { updateConversationUsage } from "../middleware/usageLimitMiddleware.js"
import { authenticateWebSocket } from "../middleware/authMiddleware.js"
import crypto from "crypto"
import fetch from "node-fetch"
import dotenv from "dotenv"
dotenv.config()

// Helper function to safely parse incoming WebSocket messages
function parseIncomingMessage(message) {
  let messageString
  if (typeof message === "string") {
    messageString = message
  } else if (message instanceof Buffer || message instanceof ArrayBuffer) {
    try {
      messageString = Buffer.from(message).toString("utf8")
    } catch (e) {
      console.error("Error converting binary message to UTF-8 string:", e)
      return null
    }
  } else {
    console.warn("Received unsupported WebSocket message type:", typeof message)
    return null
  }

  try {
    const parsed = JSON.parse(messageString)
    return parsed
  } catch (e) {
    return null // Not valid JSON, return null (it might be raw audio or plain text)
  }
}

async function handleVideoChat(ws, req) {
  let userId
  let avatarId
  let avatarDetails
  let voiceServiceWs = null
  let videoServiceWs = null
  let isSpeaking = false
  let sessionId
  let language = "en"
  let conversationId = null
  let conversationStartTime = null
  let isFullyConnected = false
  let connectionTimeout = null
  const chatMessages = []

  const DEFAULT_LLM_RESPONSE = "I'm having a little trouble with my connection. Could you please repeat that?"

  const urlParams = new URLSearchParams(req.url.split("?")[1])
  avatarId = urlParams.get("avatarId")
  const token = urlParams.get("token")
  let voiceCloneUrl = urlParams.get("voiceUrl")
  language = urlParams.get("language") || "en"

  if (!avatarId || !token) {
    console.error("Missing avatarId or token in WebSocket URL for video chat.")
    ws.send(
      JSON.stringify({ type: "error", message: "Video chat initialization failed: Missing avatar info or token." }),
    )
    ws.close()
    return
  }

  try {
    const user = await authenticateWebSocket(token)
    userId = user.id
    sessionId = crypto.randomUUID()
    conversationStartTime = new Date()

    console.log(
      `🎥 Real-time video chat initiated for user: ${userId}, session: ${sessionId}, avatar: ${avatarId}, language: ${language}`,
    )

    // Send connecting status to frontend
    ws.send(JSON.stringify({ type: "connecting", message: "Connecting to video and voice services..." }))

    // Check conversation limits
    const { data: profile } = await supabaseAdmin
      .from("profiles")
      .select("conversation_minutes_monthly_limit, conversation_minutes_this_month")
      .eq("id", userId)
      .single()

    if (profile) {
      const remainingMinutes =
        (profile.conversation_minutes_monthly_limit || 0) - (profile.conversation_minutes_this_month || 0)
      if (remainingMinutes <= 0) {
        ws.send(
          JSON.stringify({
            type: "error",
            message: "You have exceeded your monthly conversation limit. Please upgrade your plan to continue.",
          }),
        )
        ws.close()
        return
      }
    }

    // Create conversation record
    const { data: conversationData, error: conversationError } = await supabaseAdmin
      .from("conversations")
      .insert({
        user_id: userId,
        avatar_id: avatarId,
        name: `Video Chat ${new Date().toLocaleDateString()}`,
        conversation_language: language,
        audio_only: false,
        status: "active",
      })
      .select()
      .single()

    if (conversationError) {
      console.error("Error creating conversation record:", conversationError)
      ws.send(
        JSON.stringify({
          type: "error",
          message: "Failed to create conversation record. Please try again.",
        }),
      )
      ws.close()
      return
    } else {
      conversationId = conversationData.id
    }

    // Fetch avatar data
    console.log(`[DB] Fetching avatar personality data for ${avatarId} from database.`)
    avatarDetails = await getAvatarPersonalityFromDB(avatarId)
    if (!avatarDetails) {
      console.error("Error loading avatar data for video chat or avatar not found.")
      await ws.send(JSON.stringify({ type: "error", message: "Avatar not found or error loading data." }))

      if (conversationId) {
        await supabaseAdmin.from("conversations").update({ status: "failed" }).eq("id", conversationId)
      }

      ws.close()
      return
    }

    console.log(`[DB] Avatar data fetched successfully for ${avatarDetails.name} (ID: ${avatarId})`)
    console.log(`[DB] Voice URL: ${avatarDetails.voice_url ? "Present" : "Missing"}`)

    // If voiceCloneUrl was NOT provided in the URL, use the one from Supabase
    if (!voiceCloneUrl) {
      console.warn("voiceUrl not found in WebSocket URL. Using voice_url from Supabase.")
      voiceCloneUrl = avatarDetails.voice_url
    }

    if (!voiceCloneUrl) {
      console.error("Avatar has no voice sample URL configured for video chat (after checking URL and DB).")
      await ws.send(
        JSON.stringify({
          type: "error",
          message: `Avatar "${avatarDetails.name}" doesn't have a voice sample configured. Please add a voice sample to this avatar first, or choose a different avatar with voice capabilities.`,
        }),
      )

      if (conversationId) {
        await supabaseAdmin.from("conversations").update({ status: "failed" }).eq("id", conversationId)
      }

      ws.close()
      return
    }

    // Set connection timeout
    connectionTimeout = setTimeout(() => {
      if (!isFullyConnected) {
        console.error("Video chat services connection timeout")
        ws.send(JSON.stringify({ type: "error", message: "Connection timeout. Please try again." }))
        ws.close()
      }
    }, 30000) // 30 second timeout for video

    // Step 1: Initialize video service for real-time streaming
    const videoServiceUrl = process.env.VIDEO_SERVICE_URL
    if (videoServiceUrl) {
      try {
        console.log("🎬 Initializing video service for real-time streaming...")

        // Start video streaming session
        const initResponse = await fetch(`${videoServiceUrl}/init-stream`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            avatar_id: avatarId,
            image_url: avatarDetails.image_url,
            session_id: sessionId,
          }),
        })

        if (initResponse.ok) {
          console.log("✅ Video streaming session initialized")

          // Connect to video service WebSocket for real-time frames
          const videoServiceWsUrl = process.env.VIDEO_SERVICE_WS_URL
          if (videoServiceWsUrl) {
            const videoWsUrl = `${videoServiceWsUrl}/stream/${sessionId}`
            console.log(`🎬 Connecting to video WebSocket: ${videoWsUrl}`)

            videoServiceWs = new WebSocket(videoWsUrl)
            videoServiceWs.binaryType = "arraybuffer"

            videoServiceWs.onopen = () => {
              console.log("✅ Connected to Video Service WebSocket")
              // Start idle animation
              videoServiceWs.send(
                JSON.stringify({
                  type: "start_idle_animation",
                  avatar_id: avatarId,
                }),
              )
            }

            videoServiceWs.onmessage = (event) => {
              // Forward video frames to frontend
              if (event.data instanceof ArrayBuffer && ws.readyState === WebSocket.OPEN) {
                ws.send(event.data)
              } else if (typeof event.data === "string") {
                const data = JSON.parse(event.data)
                if (data.type === "frame_ready") {
                  console.log("📹 Video frame ready")
                } else if (data.type === "error") {
                  console.error("❌ Video service error:", data.message)
                }
              }
            }

            videoServiceWs.onclose = (event) => {
              console.log("🔌 Video Service WebSocket closed:", event.code, event.reason)
            }

            videoServiceWs.onerror = (error) => {
              console.error("❌ Video Service WebSocket error:", error)
            }
          }
        } else {
          console.error("❌ Failed to initialize video streaming session")
        }
      } catch (error) {
        console.error("Error initializing video service:", error)
      }
    }

    // Step 2: Connect to Voice Service
    const voiceServiceSecretKey = process.env.VOICE_SERVICE_SECRET_KEY
    if (!voiceServiceSecretKey) {
      console.error("VOICE_SERVICE_SECRET_KEY environment variable is not set.")
      ws.send(JSON.stringify({ type: "error", message: "Server configuration error: Voice service key missing." }))

      if (conversationId) {
        await supabaseAdmin.from("conversations").update({ status: "failed" }).eq("id", conversationId)
      }

      ws.close()
      return
    }

    // Generate the custom auth token for the Python service
    const timestamp = Math.floor(Date.now() / 1000)
    const stringToSign = `${timestamp}`
    const signature = crypto.createHmac("sha256", voiceServiceSecretKey).update(stringToSign).digest("hex")
    const payload = `${signature}.${timestamp}`
    const encodedPayload = Buffer.from(payload).toString("base64url")
    const voiceServiceAuthToken = `VOICE_CLONE_AUTH-${encodedPayload}`

    const voiceServiceWsUrl = process.env.VOICE_SERVICE_WS_URL
    voiceServiceWs = new WebSocket(voiceServiceWsUrl, {
      headers: {
        Authorization: voiceServiceAuthToken,
      },
    })

    voiceServiceWs.onopen = async () => {
      console.log("✅ Connected to Python Voice Service WS for video chat")
      await voiceServiceWs.send(
        JSON.stringify({
          type: "init",
          userId: userId,
          avatarId: avatarId,
          voice_clone_url: voiceCloneUrl,
          language: language,
        }),
      )
    }

    voiceServiceWs.onmessage = async (event) => {
      const pythonMessage = parseIncomingMessage(event.data)
      if (pythonMessage) {
        if (pythonMessage.type === "ready") {
          console.log("✅ Python TTS is ready for video chat.")
          isFullyConnected = true

          if (connectionTimeout) {
            clearTimeout(connectionTimeout)
            connectionTimeout = null
          }

          await ws.send(
            JSON.stringify({
              type: "ready",
              message: `Video chat with ${avatarDetails.name} ready!`,
              avatar: {
                name: avatarDetails.name,
                image_url: avatarDetails.image_url,
              },
              features: {
                voice: true,
                video: !!videoServiceWs,
                lip_sync: true,
              },
            }),
          )
        } else if (pythonMessage.type === "error") {
          await ws.send(JSON.stringify({ type: "error", message: `Voice service error: ${pythonMessage.message}` }))

          if (conversationId) {
            await supabaseAdmin.from("conversations").update({ status: "failed" }).eq("id", conversationId)
          }
        } else if (pythonMessage.type === "speech_start") {
          isSpeaking = true
          await ws.send(JSON.stringify({ type: "speech_start" }))

          // Notify video service that speech started
          if (videoServiceWs && videoServiceWs.readyState === WebSocket.OPEN) {
            videoServiceWs.send(JSON.stringify({ type: "speech_start" }))
          }
        } else if (pythonMessage.type === "speech_end") {
          isSpeaking = false
          await ws.send(JSON.stringify({ type: "speech_end" }))

          // Notify video service that speech ended
          if (videoServiceWs && videoServiceWs.readyState === WebSocket.OPEN) {
            videoServiceWs.send(JSON.stringify({ type: "speech_end" }))
          }
        }
      } else if (event.data instanceof Buffer || event.data instanceof ArrayBuffer) {
        // Raw audio from Python service
        // Send audio to video service for lip-sync
        if (videoServiceWs && videoServiceWs.readyState === WebSocket.OPEN) {
          videoServiceWs.send(event.data) // Send to video service for lip-sync
        }

        // Also send audio to frontend for playback
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(event.data)
        }
      }
    }

    voiceServiceWs.onclose = (event) => {
      console.log("🔌 Python Voice Service WS closed for video chat.", event.code, event.reason)
      isSpeaking = false
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "system", message: "Voice service disconnected." }))
        ws.close(1001, "Python voice service disconnected")
      }
    }

    voiceServiceWs.onerror = (err) => {
      console.error("❌ Python Voice Service WS error for video chat:", err)
      isSpeaking = false
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "error", message: "Voice service connection failed. Please try again." }))
        ws.close(1011, "Voice service error")
      }
    }
  } catch (error) {
    console.error("Video chat WebSocket handler initialization error:", error)
    ws.send(JSON.stringify({ type: "error", message: "Failed to initialize video chat session." }))

    if (conversationId) {
      await supabaseAdmin.from("conversations").update({ status: "failed" }).eq("id", conversationId)
    }

    ws.close()
    return
  }

  ws.on("message", async (message) => {
    try {
      const parsedMessage = parseIncomingMessage(message)
      if (parsedMessage && parsedMessage.type === "user_text") {
        const userText = parsedMessage.text
        console.log(`[VIDEO_CHAT] User says: "${userText}"`)

        // Only process if fully connected
        if (!isFullyConnected) {
          console.log("[VIDEO_CHAT] Not fully connected yet, ignoring user input")
          return
        }

        // Store user message
        chatMessages.push({ role: "user", parts: [{ text: userText }] })

        if (!userId || !avatarId || !voiceServiceWs || voiceServiceWs.readyState !== WebSocket.OPEN) {
          console.error("[VIDEO_CHAT] Prerequisites not met to send to LLM. Aborting.")
          await ws.send(
            JSON.stringify({
              type: "error",
              message: "Video chat not fully initialized or voice service not connected. Please reconnect.",
            }),
          )
          return
        }

        // Call Gemini for LLM response
        let llmResponseText
        if (!userText || userText.trim().length < 2) {
          llmResponseText = DEFAULT_LLM_RESPONSE
        } else {
          llmResponseText = await getGeminiResponse(sessionId, userText, avatarId, language)
        }

        console.log(`[VIDEO_CHAT] LLM replies: "${llmResponseText}"`)

        // Store assistant message
        chatMessages.push({ role: "model", parts: [{ text: llmResponseText }] })

        await ws.send(JSON.stringify({ type: "llm_response_text", text: llmResponseText }))

        if (voiceServiceWs.readyState === WebSocket.OPEN) {
          console.log("[VIDEO_CHAT] Sending LLM response to Python Voice Service for TTS.")
          await voiceServiceWs.send(JSON.stringify({ type: "text_to_speak", text: llmResponseText }))
        } else {
          console.error("Voice service WebSocket not open, cannot send text for TTS after LLM response.")
        }
      } else if (parsedMessage && parsedMessage.type === "stop_speaking") {
        if (voiceServiceWs && voiceServiceWs.readyState === WebSocket.OPEN) {
          console.log("🛑 Received stop_speaking command from frontend. Forwarding to Python.")
          voiceServiceWs.send(JSON.stringify({ type: "stop_speaking" }))
        }

        // Also stop video service
        if (videoServiceWs && videoServiceWs.readyState === WebSocket.OPEN) {
          videoServiceWs.send(JSON.stringify({ type: "stop_speaking" }))
        }

        isSpeaking = false
        await ws.send(JSON.stringify({ type: "speech_end" }))
      }
    } catch (error) {
      console.error("[VIDEO_CHAT] WebSocket message processing error in main handler:", error)
      await ws.send(JSON.stringify({ type: "error", message: "Server error processing message." }))
    }
  })

  ws.on("close", async () => {
    console.log("[VIDEO_CHAT] Client disconnected. Cleaning up.")

    // Clear timeout if still active
    if (connectionTimeout) {
      clearTimeout(connectionTimeout)
      connectionTimeout = null
    }

    // Calculate conversation duration
    const conversationEndTime = new Date()
    const durationMinutes = (conversationEndTime - conversationStartTime) / (1000 * 60)

    try {
      // Update conversation record
      if (conversationId) {
        // Generate summary using Gemini
        let summary = ""
        if (chatMessages.length > 0) {
          try {
            const conversationText = chatMessages
              .map((msg) => `${msg.role === "user" ? "User" : "Assistant"}: ${msg.parts[0].text}`)
              .join("\n")

            const summaryPrompt = `Please provide a brief summary of this conversation in 1-2 sentences:\n\n${conversationText}`
            summary = await getGeminiResponse(`summary-${sessionId}`, summaryPrompt, avatarId, "en")
          } catch (summaryError) {
            console.error("Error generating summary:", summaryError)
            summary = "Video conversation completed successfully."
          }
        }

        await supabaseAdmin
          .from("conversations")
          .update({
            status: "ended",
            updated_at: conversationEndTime.toISOString(),
          })
          .eq("id", conversationId)

        // Save chat history
        if (chatMessages.length > 0) {
          await supabaseAdmin.from("chat_history").insert({
            user_id: userId,
            avatar_id: avatarId,
            session_id: sessionId,
            conversation_id: conversationId,
            chat_messages: chatMessages,
            started_at: conversationStartTime.toISOString(),
            ended_at: conversationEndTime.toISOString(),
            summary: summary,
          })
        }
      }

      // Update usage
      if (durationMinutes > 0) {
        await updateConversationUsage(userId, durationMinutes)
        console.log(`Updated conversation usage for user ${userId}: +${durationMinutes} minutes`)
      }
    } catch (error) {
      console.error("Error saving conversation data:", error)
    }

    // Clean up video service session
    const videoServiceUrl = process.env.VIDEO_SERVICE_URL
    if (videoServiceUrl) {
      try {
        await fetch(`${videoServiceUrl}/end-stream`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            session_id: sessionId,
          }),
        })
        console.log("✅ Video streaming session ended")
      } catch (error) {
        console.error("Error ending video session:", error)
      }
    }

    if (voiceServiceWs && voiceServiceWs.readyState === WebSocket.OPEN) {
      console.log("[VIDEO_CHAT] Closing Python Voice Service WS because client disconnected.")
      voiceServiceWs.close()
    }

    if (videoServiceWs && videoServiceWs.readyState === WebSocket.OPEN) {
      console.log("[VIDEO_CHAT] Closing Video Service WS because client disconnected.")
      videoServiceWs.close()
    }
  })

  ws.on("error", (error) => {
    console.error("❌ WebSocket error on main video chat connection:", error)

    // Clear timeout if still active
    if (connectionTimeout) {
      clearTimeout(connectionTimeout)
      connectionTimeout = null
    }

    if (voiceServiceWs && voiceServiceWs.readyState === WebSocket.OPEN) {
      console.log("[VIDEO_CHAT] Closing Python Voice Service WS due to client error.")
      voiceServiceWs.close()
    }
    if (videoServiceWs && videoServiceWs.readyState === WebSocket.OPEN) {
      console.log("[VIDEO_CHAT] Closing Video Service WS due to client error.")
      videoServiceWs.close()
    }
  })
}

export default handleVideoChat
