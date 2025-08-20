import express from "express"
import { authenticateApiKey, requireEndpoint } from "../middleware/apiKeyAuth.js"
import { apiRateLimit } from "../middleware/apiRateLimit.js"
import { trackApiUsage } from "../middleware/apiUsageTracking.js"
import { generateAudio, getAudioStatus } from "../controllers/audioGenerationController.js"
import { generateVideo, getVideoStatus } from "../controllers/videoGenerationController.js"
import { createAvatar, getUserAvatars, getAvatarById } from "../controllers/avatarController.js"

const router = express.Router()

// Apply API key authentication to all routes
router.use(authenticateApiKey)

// Apply rate limiting
router.use(apiRateLimit(60000)) // 1 minute window

// Audio Generation API
router.post(
  "/audio/generate",
  requireEndpoint("audio_generation"),
  trackApiUsage("audio_generation"),
  async (req, res) => {
    try {
      // Validate request body
      const { text, voice_id, voice_settings } = req.body

      if (!text || text.trim().length === 0) {
        return res.status(400).json({
          error: "Text is required for audio generation",
        })
      }

      if (text.length > 5000) {
        return res.status(400).json({
          error: "Text must be less than 5000 characters",
        })
      }

      // Check usage limits
      const audioMinutesUsed = req.user.audio_generation_minutes_this_month || 0
      const audioMinutesLimit = req.user.audio_generation_minutes_monthly_limit || 0

      if (audioMinutesUsed >= audioMinutesLimit) {
        return res.status(429).json({
          error: "Monthly audio generation limit exceeded",
          usage: {
            used: audioMinutesUsed,
            limit: audioMinutesLimit,
          },
        })
      }

      // Call the existing audio generation function
      const result = await generateAudio(req, res)
      return result
    } catch (error) {
      console.error("Public API audio generation error:", error)
      res.status(500).json({
        error: "Internal server error during audio generation",
      })
    }
  },
)

router.get("/audio/status/:taskId", requireEndpoint("audio_generation"), getAudioStatus)

// Video Generation API
router.post(
  "/video/generate",
  requireEndpoint("video_generation"),
  trackApiUsage("video_generation"),
  async (req, res) => {
    try {
      // Validate request body
      const { text, avatar_id, voice_id, duration = 5 } = req.body

      if (!text || text.trim().length === 0) {
        return res.status(400).json({
          error: "Text is required for video generation",
        })
      }

      if (!avatar_id) {
        return res.status(400).json({
          error: "Avatar ID is required for video generation",
        })
      }

      if (duration > 60) {
        return res.status(400).json({
          error: "Video duration cannot exceed 60 seconds",
        })
      }

      // Check usage limits
      const videoMinutesUsed = req.user.video_generation_minutes_this_month || 0
      const videoMinutesLimit = req.user.video_generation_minutes_monthly_limit || 0

      if (videoMinutesUsed >= videoMinutesLimit) {
        return res.status(429).json({
          error: "Monthly video generation limit exceeded",
          usage: {
            used: videoMinutesUsed,
            limit: videoMinutesLimit,
          },
        })
      }

      // Call the existing video generation function
      const result = await generateVideo(req, res)
      return result
    } catch (error) {
      console.error("Public API video generation error:", error)
      res.status(500).json({
        error: "Internal server error during video generation",
      })
    }
  },
)

router.get("/video/status/:taskId", requireEndpoint("video_generation"), getVideoStatus)

// Avatar Management API
router.post("/avatars", requireEndpoint("avatar_creation"), trackApiUsage("avatar_creation"), async (req, res) => {
  try {
    // Validate request body
    const { name, description, image_url } = req.body

    if (!name || name.trim().length === 0) {
      return res.status(400).json({
        error: "Avatar name is required",
      })
    }

    if (!image_url) {
      return res.status(400).json({
        error: "Avatar image URL is required",
      })
    }

    // Check usage limits
    const avatarsCreated = req.user.custom_avatar_creations_this_month || 0
    const avatarsLimit = req.user.custom_avatar_creations_monthly_limit || 0

    if (avatarsCreated >= avatarsLimit) {
      return res.status(429).json({
        error: "Monthly avatar creation limit exceeded",
        usage: {
          used: avatarsCreated,
          limit: avatarsLimit,
        },
      })
    }

    // Call the existing avatar creation function
    const result = await createAvatar(req, res)
    return result
  } catch (error) {
    console.error("Public API avatar creation error:", error)
    res.status(500).json({
      error: "Internal server error during avatar creation",
    })
  }
})

router.get("/avatars", requireEndpoint("avatar_creation"), getUserAvatars)

router.get("/avatars/:id", requireEndpoint("avatar_creation"), getAvatarById)

// Usage information endpoint
router.get("/usage", async (req, res) => {
  try {
    const usage = {
      audio_generation: {
        used: req.user.audio_generation_minutes_this_month || 0,
        limit: req.user.audio_generation_minutes_monthly_limit || 0,
        unit: "minutes",
      },
      video_generation: {
        used: req.user.video_generation_minutes_this_month || 0,
        limit: req.user.video_generation_minutes_monthly_limit || 0,
        unit: "minutes",
      },
      avatar_creation: {
        used: req.user.custom_avatar_creations_this_month || 0,
        limit: req.user.custom_avatar_creations_monthly_limit || 0,
        unit: "avatars",
      },
    }

    res.json({
      usage,
      api_key: {
        name: req.apiKey.name,
        environment: req.apiKey.environment,
        allowed_endpoints: req.apiKey.allowed_endpoints,
        rate_limits: {
          per_minute: req.apiKey.rate_limit_per_minute,
          per_hour: req.apiKey.rate_limit_per_hour,
          per_day: req.apiKey.rate_limit_per_day,
        },
      },
    })
  } catch (error) {
    console.error("Usage endpoint error:", error)
    res.status(500).json({
      error: "Internal server error fetching usage data",
    })
  }
})

export default router
