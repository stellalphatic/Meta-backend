import express from "express"
import { authenticateJWT} from "../middleware/authMiddleware.js"
import {
  createApiKey,
  getUserApiKeys,
  deleteApiKey,
  toggleApiKeyStatus,
  getApiUsageStats,
} from "../controllers/apiController.js"

const router = express.Router()

// All API management routes require authentication
router.use(authenticateJWT)

// API Key management routes
router.post("/keys", createApiKey)
router.get("/keys", getUserApiKeys)
router.delete("/keys/:keyId", deleteApiKey)
router.patch("/keys/:keyId/toggle", toggleApiKeyStatus)

// Usage statistics
router.get("/usage", getApiUsageStats)

export default router
