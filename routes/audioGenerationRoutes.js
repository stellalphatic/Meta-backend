import express from "express"
import { authenticateJWT } from "../middleware/authMiddleware.js"
import { checkAudioLimit } from "../middleware/usageLimitMiddleware.js"
import { generateAudio, getAudioHistory, deleteAudio } from "../controllers/audioGenerationController.js"

const router = express.Router()

// Generate audio (requires auth and usage check)
router.post("/generate", authenticateJWT, checkAudioLimit, generateAudio)

// Get user's audio history (requires auth)
router.get("/history", authenticateJWT, getAudioHistory)

// Delete an audio (requires auth)
router.delete("/:audioId", authenticateJWT, deleteAudio)

export default router
