import express from "express"
import { authenticateJWT } from "../middleware/authMiddleware.js"
import {
  getUserUsageStats,
  updateConversationUsageAPI,
  updateAvatarCreationUsageAPI,
} from "../middleware/usageLimitMiddleware.js"

const router = express.Router()

// Get user usage statistics
router.get("/stats", authenticateJWT, getUserUsageStats)

// Update conversation usage
router.post("/update-conversation", authenticateJWT, updateConversationUsageAPI)

// Update avatar creation usage
router.post("/update-avatar-creation", authenticateJWT, updateAvatarCreationUsageAPI)

export default router
