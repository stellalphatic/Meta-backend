import express from "express"
import cors from "cors"
import { createServer } from "http"
import { WebSocketServer } from "ws"
import dotenv from "dotenv"
import path from "path"
import { fileURLToPath } from "url"

// Import routes
import indexRoutes from "./routes/index.js"
import avatarRoutes from "./routes/avatarRoutes.js"
import conversationRoutes from "./routes/conversationRoutes.js"
import usageRoutes from "./routes/usageRoutes.js"
import videoGenerationRoutes from "./routes/videoGenerationRoutes.js"
import audioGenerationRoutes from "./routes/audioGenerationRoutes.js"

// Import WebSocket handlers
import handleVoiceChat from "./ws/voiceChatHandler.js"
import handleVideoChat from "./ws/videoChatHandler.js"

// Load environment variables
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

dotenv.config({ path: path.join(__dirname, "../.env") })

const app = express()
const server = createServer(app)
const wss = new WebSocketServer({ server })

const PORT = process.env.PORT || 5000
const frontendUrl = process.env.FRONTEND_URL;
const normalizedFrontendUrl = frontendUrl ? frontendUrl.replace(/\/$/, "") : "";

const FRONTEND_URL = normalizedFrontendUrl || "http://localhost:5173"

// Middleware
app.use(express.json({ limit: "50mb" }))
app.use(express.urlencoded({ extended: true, limit: "50mb" }))

// CORS configuration
app.use(
  cors({
    origin: [FRONTEND_URL, "http://localhost:3000", "http://localhost:5173"],
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With"],
  }),
)

// Request logging middleware
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`)
  next()
})


// Routes 
app.use("/", indexRoutes)
// app.use("/api/avatars", avatarRoutes)
// app.use("/api/conversations", conversationRoutes)
// app.use("/api/usage", usageRoutes)
// app.use("/api/video-generation", videoGenerationRoutes)
// app.use("/api/audio-generation", audioGenerationRoutes)

// Health check endpoint
app.get("/health", (req, res) => {
  res.json({
    status: "healthy",
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || "development",
    services: {
      voice_service: process.env.VOICE_SERVICE_WS_URL ? "configured" : "missing",
      video_service: process.env.VIDEO_SERVICE_WS_URL ? "configured" : "missing",
      gemini: process.env.GEMINI_API_KEY ? "configured" : "missing",
    },
  })
})

// WebSocket connection handling
wss.on("connection", (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`)
  const pathname = url.pathname

  console.log(`🔌 WebSocket connection attempt to: ${pathname}`)

  if (pathname === "/voice-chat") {
    console.log("🎤 Handling voice chat WebSocket connection")
    handleVoiceChat(ws, req)
  } else if (pathname === "/video-chat") {
    console.log("🎥 Handling video chat WebSocket connection")
    handleVideoChat(ws, req)
  } else {
    console.log(`❌ Unknown WebSocket path: ${pathname}`)
    ws.close(1000, "Unknown path")
  }
})

// Error handling middleware
app.use((err, req, res, next) => {
  console.error("❌ Server error:", err)
  res.status(500).json({
    success: false,
    message: "Internal server error",
    error: process.env.NODE_ENV === "development" ? err.message : "Something went wrong",
  })
})

// 404 handler
app.use("*", (req, res) => {
  console.log(`❌ Route not found: ${req.method} ${req.originalUrl}`)
  res.status(404).json({
    success: false,
    message: "Route not found",
    path: req.originalUrl,
  })
})

// Start server
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`)
  console.log(`🌐 CORS enabled for: ${FRONTEND_URL}`)
  console.log(`🔌 WebSocket server ready`)
  console.log(`📊 Environment: ${process.env.NODE_ENV || "development"}`)
  console.log(`🎤 Voice service: ${process.env.VOICE_SERVICE_WS_URL || "not configured"}`)
  console.log(`🎥 Video service: ${process.env.VIDEO_SERVICE_URL || "not configured"}`)
})

// Graceful shutdown
process.on("SIGTERM", () => {
  console.log("🛑 SIGTERM received, shutting down gracefully")
  server.close(() => {
    console.log("✅ Server closed")
    process.exit(0)
  })
})

process.on("SIGINT", () => {
  console.log("🛑 SIGINT received, shutting down gracefully")
  server.close(() => {
    console.log("✅ Server closed")
    process.exit(0)
  })
})

export default app
