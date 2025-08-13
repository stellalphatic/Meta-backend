import express from "express"
import multer from "multer"
import { authenticateJWT } from "../middleware/authMiddleware.js"
import { checkVideoLimit } from "../middleware/usageLimitMiddleware.js"
import {
  generateVideo,
  uploadAudioForVideo,
  getVideoHistory,
  getVideoStatus,
  getVideoOptions,
  deleteVideo,
} from "../controllers/videoGenerationController.js"

const router = express.Router()

// Configure multer for audio file uploads
const storage = multer.memoryStorage()
const upload = multer({
  storage: storage,
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB limit
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = ["audio/wav", "audio/mp3", "audio/mpeg", "audio/m4a", "audio/ogg"]
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true)
    } else {
      cb(new Error("Invalid file type. Only audio files are allowed."))
    }
  },
})

// Routes
router.get("/options", getVideoOptions)
router.post("/generate", authenticateJWT, checkVideoLimit, generateVideo)
router.post("/upload-audio", authenticateJWT, upload.single("audio"), uploadAudioForVideo)
router.get("/history", authenticateJWT, getVideoHistory)
router.get("/status/:taskId", authenticateJWT, getVideoStatus)
router.delete("/:videoId", authenticateJWT, deleteVideo)

export default router
