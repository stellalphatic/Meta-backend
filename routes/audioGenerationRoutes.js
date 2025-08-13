import express from "express"
import { authenticateJWT } from "../middleware/authMiddleware.js"
import { checkAudioLimit } from "../middleware/usageLimitMiddleware.js"
import {
  generateAudio,
  getAudioHistory,
  getAudioStatus,
  deleteAudio,
} from "../controllers/audioGenerationController.js"

const router = express.Router()

// Routes
router.post("/generate", authenticateJWT, checkAudioLimit, generateAudio)
router.get("/history", authenticateJWT, getAudioHistory)
router.get("/status/:taskId", authenticateJWT, getAudioStatus)
router.delete("/:audioId", authenticateJWT, deleteAudio)

export default router
