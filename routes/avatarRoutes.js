import express from "express"
import { authenticateJWT, rateLimit } from "../middleware/authMiddleware.js"
import {
  getUserAvatars,
  getAvatarById,
  createAvatar,
  updateAvatar,
  deleteAvatar,
} from "../controllers/avatarController.js"

const router = express.Router()

// Apply authentication to all routes
router.use(authenticateJWT)

// Apply rate limiting
router.use(rateLimit(50, 15 * 60 * 1000)) // 50 requests per 15 minutes

// Routes
router.get("/", getUserAvatars)
router.get("/:id", getAvatarById)
router.post("/", createAvatar)
router.put("/:id", updateAvatar)
router.delete("/:id", deleteAvatar)

export default router
