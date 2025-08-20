import express from "express"
import conversationRoutes from "./conversationRoutes.js"
import usageRoutes from "./usageRoutes.js"
import videoGenerationRoutes from "./videoGenerationRoutes.js"
import audioGenerationRoutes from "./audioGenerationRoutes.js"
import apiRoutes from "./apiRoutes.js"
import publicApiRoutes from "./publicApiRoutes.js"

const router = express.Router()

// Health check
router.get("/health", (req, res) => {
  res.json({
    status: "healthy",
    timestamp: new Date().toISOString(),
    services: {
      voice_service: !!process.env.VOICE_SERVICE_WS_URL,
      video_service: !!process.env.VIDEO_SERVICE_URL,
      database: !!process.env.SUPABASE_URL,
    },
  })
})

// API routes
router.use("/api/conversations", conversationRoutes)
router.use("/api/usage", usageRoutes)
router.use("/api/video-generation", videoGenerationRoutes)
router.use("/api/audio-generation", audioGenerationRoutes)

router.use("/api", apiRoutes)
router.use("/public-api/v1", publicApiRoutes)

// Root endpoint
router.get("/", (req, res) => {
  res.json({
    message: "Avatar Video Generation API",
    version: "1.0.0",
    endpoints: {
      conversations: "/api/conversations",
      usage: "/api/usage",
      videoGeneration: "/api/video-generation",
      audioGeneration: "/api/audio-generation",
    },
  })
})

export default router
