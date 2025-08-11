import express from "express"
import { authenticateJWT } from "../middleware/authMiddleware.js"
import { checkVideoLimit } from "../middleware/usageLimitMiddleware.js"
import {
  generateVideo,
  getVideoHistory,
  deleteVideo,
  getVideoOptions,
} from "../controllers/videoGenerationController.js"

const router = express.Router()

// Get video generation options (no auth required)
router.get("/options", getVideoOptions)

// Generate video (requires auth and usage check)
router.post("/generate", authenticateJWT, checkVideoLimit, generateVideo)

// Get user's video history (requires auth)
router.get("/history", authenticateJWT, getVideoHistory)

// Delete a video (requires auth)
router.delete("/:videoId", authenticateJWT, deleteVideo)

export default router
