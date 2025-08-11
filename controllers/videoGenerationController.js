import { supabaseAdmin } from "../services/supabase.js"
import { updateVideoUsage } from "../middleware/usageLimitMiddleware.js"
import fetch from "node-fetch"
import crypto from "crypto"

// Cache for avatar details
const avatarDetailsCache = new Map()

/**
 * Generate authentication token for voice service
 */
function generateVoiceServiceToken() {
  const secretKey = process.env.VOICE_SERVICE_SECRET_KEY
  if (!secretKey) {
    throw new Error("VOICE_SERVICE_SECRET_KEY not configured")
  }

  const timestamp = Math.floor(Date.now() / 1000)
  const stringToSign = `${timestamp}`
  const signature = crypto.createHmac("sha256", secretKey).update(stringToSign).digest("hex")
  const payload = `${signature}.${timestamp}`
  const encodedPayload = Buffer.from(payload).toString("base64url")

  return `VOICE_CLONE_AUTH-${encodedPayload}`
}

/**
 * Generate video using hybrid approach
 */
export const generateVideo = async (req, res) => {
  const { avatarId, text, quality = "high" } = req.body
  const userId = req.user?.id
  const isWithinLimit = req.isWithinLimit !== false

  console.log(`[VIDEO_GEN] Request from user ${userId} for avatar ${avatarId}`)

  if (!avatarId || !text || !text.trim()) {
    return res.status(400).json({
      success: false,
      message: "Missing avatarId or text for video generation.",
      code: "MISSING_PARAMETERS",
    })
  }

  if (!["high", "fast"].includes(quality)) {
    return res.status(400).json({
      success: false,
      message: "Quality must be either 'high' or 'fast'.",
      code: "INVALID_QUALITY",
    })
  }

  if (!userId) {
    return res.status(401).json({
      success: false,
      message: "Authentication required.",
      code: "AUTH_REQUIRED",
    })
  }

  if (!isWithinLimit) {
    return res.status(403).json({
      success: false,
      message: "You have exceeded your monthly video generation minute limit.",
      code: "USAGE_LIMIT_EXCEEDED",
      usageInfo: req.usageInfo,
    })
  }

  let generatedVideoRecord = null

  try {
    // 1. Fetch avatar details
    let avatarDetails
    if (!avatarDetailsCache.has(avatarId)) {
      const { data, error } = await supabaseAdmin
        .from("avatars")
        .select("name, image_url, voice_url")
        .eq("id", avatarId)
        .single()

      if (error || !data) {
        console.error(`[VIDEO_GEN] Error fetching avatar details for ${avatarId}:`, error)
        return res.status(404).json({
          success: false,
          message: "Avatar not found or accessible.",
          code: "AVATAR_NOT_FOUND",
        })
      }

      avatarDetailsCache.set(avatarId, data)
    }

    avatarDetails = avatarDetailsCache.get(avatarId)
    const { image_url: imageUrl, voice_url: voiceUrl } = avatarDetails

    if (!imageUrl || !voiceUrl) {
      console.error(`[VIDEO_GEN] Avatar ${avatarId} is missing required image or voice data.`)
      return res.status(400).json({
        success: false,
        message: "Avatar is not fully configured for video generation.",
        code: "AVATAR_INCOMPLETE",
      })
    }

    // 2. Generate Audio from Text
    console.log(`[VIDEO_GEN] Generating audio from text (quality: ${quality})...`)
    const voiceServiceBaseUrl = process.env.COQUI_XTTS_BASE_URL

    if (!voiceServiceBaseUrl) {
      return res.status(500).json({
        success: false,
        message: "Voice service not configured.",
        code: "SERVICE_NOT_CONFIGURED",
      })
    }

    // Generate proper authentication token for voice service
    const voiceServiceToken = generateVoiceServiceToken()
    console.log(`[VIDEO_GEN] Generated voice service token: ${voiceServiceToken.substring(0, 20)}...`)

    const audioResponse = await fetch(`${voiceServiceBaseUrl}/generate-audio`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: voiceServiceToken,
      },
      body: JSON.stringify({
        voice_id: avatarId,
        voice_clone_url: voiceUrl,
        text: text,
        language: "en",
      }),
    })

    if (!audioResponse.ok) {
      const errorText = await audioResponse.text()
      console.error("[VIDEO_GEN] Voice service error:", audioResponse.status, errorText)
      return res.status(audioResponse.status).json({
        success: false,
        message: `Failed to generate audio: ${errorText}`,
        code: "AUDIO_GENERATION_FAILED",
      })
    }

    console.log(`[VIDEO_GEN] Audio generation successful`)
    const audioBuffer = await audioResponse.arrayBuffer()

    // Upload audio to temporary storage
    const audioFileName = `temp_audio/${userId}/${avatarId}-${Date.now()}.wav`
    const { data: audioUploadData, error: audioUploadError } = await supabaseAdmin.storage
      .from("avatar-media")
      .upload(audioFileName, audioBuffer, {
        contentType: "audio/wav",
        upsert: false,
      })

    if (audioUploadError) {
      console.error("[VIDEO_GEN] Error uploading audio:", audioUploadError)
      return res.status(500).json({
        success: false,
        message: "Failed to process generated audio.",
        code: "AUDIO_UPLOAD_FAILED",
      })
    }

    const { data: audioUrlData } = supabaseAdmin.storage.from("avatar-media").getPublicUrl(audioFileName)
    const audioUrl = audioUrlData.publicUrl
    console.log(`[VIDEO_GEN] Audio uploaded to: ${audioUrl}`)

    // 3. Generate Video using appropriate model
    console.log(`[VIDEO_GEN] Generating video (quality: ${quality})...`)
    const videoGenBaseUrl = process.env.VIDEO_SERVICE_URL

    if (!videoGenBaseUrl) {
      return res.status(500).json({
        success: false,
        message: "Video generation service not configured.",
        code: "SERVICE_NOT_CONFIGURED",
      })
    }

    // Create FormData for video service
    const formData = new URLSearchParams()
    formData.append("image_url", imageUrl)
    formData.append("audio_url", audioUrl)
    formData.append("quality", quality)

    const videoResponse = await fetch(`${videoGenBaseUrl}/generate-video`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Bearer ${process.env.VIDEO_SERVICE_API_KEY || "default-key"}`,
      },
      body: formData,
    })

    if (!videoResponse.ok) {
      const errorText = await videoResponse.text()
      console.error("[VIDEO_GEN] Video service error:", videoResponse.status, errorText)
      return res.status(videoResponse.status).json({
        success: false,
        message: `Failed to generate video: ${errorText}`,
        code: "VIDEO_GENERATION_FAILED",
      })
    }

    const videoResult = await videoResponse.json()
    const taskId = videoResult.task_id
    console.log(`[VIDEO_GEN] Video generation started with task ID: ${taskId}`)

    // 4. Save initial record to database (with proper error handling)
    const estimatedDuration = req.usageInfo?.estimatedDuration || Math.max(text.length * 0.001, 0.5)

    try {
      const { data, error: insertError } = await supabaseAdmin
        .from("video_generation_history")
        .insert({
          user_id: userId,
          avatar_id: avatarId,
          duration_minutes: estimatedDuration,
          prompt: text,
          video_url: null, // Explicitly set to null
          task_id: taskId,
          quality: quality,
          status: "processing",
          error_message: null,
          completed_at: null,
        })
        .select()
        .single()

      if (insertError) {
        console.error("[VIDEO_GEN] Error saving video metadata:", insertError)
        throw new Error(`Database error: ${insertError.message}`)
      }

      generatedVideoRecord = data
      console.log(`[VIDEO_GEN] Video record saved with ID: ${generatedVideoRecord.id}`)
    } catch (dbError) {
      console.error("[VIDEO_GEN] Database operation failed:", dbError)
      return res.status(500).json({
        success: false,
        message: "Failed to save video generation record.",
        code: "DATABASE_ERROR",
        error: dbError.message,
      })
    }

    // 5. Start background polling for completion
    _pollVideoCompletion(taskId, generatedVideoRecord.id, quality, audioFileName, userId, estimatedDuration)

    res.status(200).json({
      success: true,
      message: `Video generation started successfully using ${quality} quality!`,
      data: {
        taskId: taskId,
        videoId: generatedVideoRecord.id,
        quality: quality,
        estimatedTime: quality === "high" ? "2-5 minutes" : "30-60 seconds",
        usageInfo: req.usageInfo,
      },
    })
  } catch (err) {
    console.error("[VIDEO_GEN] Server error:", err)

    // If we have a record, mark it as failed
    if (generatedVideoRecord) {
      try {
        await supabaseAdmin
          .from("video_generation_history")
          .update({
            status: "failed",
            error_message: err.message,
            completed_at: new Date().toISOString(),
          })
          .eq("id", generatedVideoRecord.id)
      } catch (updateError) {
        console.error("[VIDEO_GEN] Failed to update error status:", updateError)
      }
    }

    res.status(500).json({
      success: false,
      message: "Internal server error during video generation.",
      code: "INTERNAL_ERROR",
      error: err.message,
    })
  }
}

/**
 * Background function to poll video completion - FIXED VERSION
 */
async function _pollVideoCompletion(taskId, videoRecordId, quality, audioFileName, userId, estimatedDuration) {
  const maxAttempts = quality === "high" ? 120 : 60
  const pollInterval = quality === "high" ? 5000 : 3000
  const videoGenBaseUrl = process.env.VIDEO_SERVICE_URL

  console.log(`[VIDEO_GEN] Starting background polling for task ${taskId}`)

  let attempts = 0
  let videoUrl = null

  while (attempts < maxAttempts && !videoUrl) {
    await new Promise((resolve) => setTimeout(resolve, pollInterval))

    try {
      const statusResponse = await fetch(`${videoGenBaseUrl}/video-status/${taskId}`, {
        headers: {
          Authorization: `Bearer ${process.env.VIDEO_SERVICE_API_KEY || "default-key"}`,
        },
        timeout: 30000, // 30 second timeout
      })

      if (statusResponse.ok) {
        const contentType = statusResponse.headers.get("content-type")

        if (contentType && contentType.includes("video/mp4")) {
          // Video is ready - download it
          console.log(`[VIDEO_GEN] Video ready for task ${taskId}, downloading...`)
          const videoBuffer = await statusResponse.arrayBuffer()

          if (videoBuffer.byteLength === 0) {
            console.error(`[VIDEO_GEN] Downloaded video is empty for task ${taskId}`)
            attempts++
            continue
          }

          // Upload to permanent storage
          const videoFileName = `generated_videos/${videoRecordId}/${quality}-${Date.now()}.mp4`
          const { data: videoUploadData, error: videoUploadError } = await supabaseAdmin.storage
            .from("avatar-media")
            .upload(videoFileName, videoBuffer, {
              contentType: "video/mp4",
              upsert: false,
            })

          if (videoUploadError) {
            console.error(`[VIDEO_GEN] Failed to upload video: ${videoUploadError.message}`)
            throw new Error(`Failed to store generated video: ${videoUploadError.message}`)
          }

          const { data: videoUrlData } = supabaseAdmin.storage.from("avatar-media").getPublicUrl(videoFileName)
          videoUrl = videoUrlData.publicUrl

          // Update database record
          const { error: updateError } = await supabaseAdmin
            .from("video_generation_history")
            .update({
              video_url: videoUrl,
              status: "completed",
              completed_at: new Date().toISOString(),
            })
            .eq("id", videoRecordId)

          if (updateError) {
            console.error(`[VIDEO_GEN] Failed to update database: ${updateError.message}`)
            throw new Error(`Failed to update video record: ${updateError.message}`)
          }

          // Update user's usage in profiles table
          await updateVideoUsage(userId, estimatedDuration)

          console.log(`[VIDEO_GEN] Video generation completed for task ${taskId}`)
          console.log(`[VIDEO_GEN] Video URL: ${videoUrl}`)
          break
        } else {
          // Check status response
          try {
            const statusResult = await statusResponse.json()
            console.log(
              `[VIDEO_GEN] Task ${taskId} status: ${statusResult.status || "processing"} (attempt ${attempts + 1})`,
            )

            if (statusResult.status === "failed") {
              throw new Error(`Video generation failed: ${statusResult.error || "Unknown error"}`)
            }
          } catch (jsonError) {
            // If we can't parse JSON, assume it's still processing
            console.log(`[VIDEO_GEN] Task ${taskId} still processing (attempt ${attempts + 1})`)
          }
        }
      } else if (statusResponse.status === 404) {
        console.log(`[VIDEO_GEN] Task ${taskId} not found (attempt ${attempts + 1})`)
        // Continue polling for a bit in case it's a temporary issue
      } else {
        console.log(
          `[VIDEO_GEN] Status check failed for task ${taskId}: ${statusResponse.status} (attempt ${attempts + 1})`,
        )
      }
    } catch (pollError) {
      console.error(`[VIDEO_GEN] Error polling (attempt ${attempts + 1}):`, pollError.message)

      if (attempts >= maxAttempts - 1) {
        // Mark as failed in database
        await supabaseAdmin
          .from("video_generation_history")
          .update({
            status: "failed",
            error_message: pollError.message,
            completed_at: new Date().toISOString(),
          })
          .eq("id", videoRecordId)
      }
    }

    attempts++
  }

  // Cleanup temporary audio
  try {
    await supabaseAdmin.storage.from("avatar-media").remove([audioFileName])
    console.log(`[VIDEO_GEN] Cleaned up temp audio: ${audioFileName}`)
  } catch (cleanupError) {
    console.warn("[VIDEO_GEN] Failed to cleanup temp audio:", cleanupError)
  }

  if (!videoUrl && attempts >= maxAttempts) {
    console.error(`[VIDEO_GEN] Video generation timed out for task ${taskId}`)
    await supabaseAdmin
      .from("video_generation_history")
      .update({
        status: "failed",
        error_message: "Video generation timed out",
        completed_at: new Date().toISOString(),
      })
      .eq("id", videoRecordId)
  }
}

/**
 * Get user's video generation history
 */
export const getVideoHistory = async (req, res) => {
  const userId = req.user?.id

  if (!userId) {
    return res.status(401).json({
      success: false,
      message: "Authentication required.",
      code: "AUTH_REQUIRED",
    })
  }

  try {
    const { data, error } = await supabaseAdmin
      .from("video_generation_history")
      .select(`
        *,
        avatars (
          name,
          image_url
        )
      `)
      .eq("user_id", userId)
      .order("created_at", { ascending: false })

    if (error) throw error

    res.status(200).json({
      success: true,
      data: {
        videos: data || [],
        total: data?.length || 0,
      },
    })
  } catch (err) {
    console.error("[VIDEO_HISTORY] Error:", err)
    res.status(500).json({
      success: false,
      message: "Error fetching video history.",
      code: "VIDEO_HISTORY_ERROR",
      error: err.message,
    })
  }
}

/**
 * Delete a video generation record
 */
export const deleteVideo = async (req, res) => {
  const { videoId } = req.params
  const userId = req.user?.id

  if (!userId) {
    return res.status(401).json({
      success: false,
      message: "Authentication required.",
      code: "AUTH_REQUIRED",
    })
  }

  if (!videoId) {
    return res.status(400).json({
      success: false,
      message: "Video ID is required.",
      code: "MISSING_VIDEO_ID",
    })
  }

  try {
    // First, get the video record to check ownership and get file URLs
    const { data: video, error: fetchError } = await supabaseAdmin
      .from("video_generation_history")
      .select("*")
      .eq("id", videoId)
      .eq("user_id", userId)
      .single()

    if (fetchError || !video) {
      return res.status(404).json({
        success: false,
        message: "Video not found or you don't have permission to delete it.",
        code: "VIDEO_NOT_FOUND",
      })
    }

    // Delete the video file from storage if it exists
    if (video.video_url) {
      try {
        // Extract file path from URL
        const urlParts = video.video_url.split("/avatar-media/")
        if (urlParts.length > 1) {
          const filePath = urlParts[1]
          await supabaseAdmin.storage.from("avatar-media").remove([filePath])
          console.log(`[VIDEO_DELETE] Deleted video file: ${filePath}`)
        }
      } catch (storageError) {
        console.warn("[VIDEO_DELETE] Failed to delete video file from storage:", storageError)
        // Continue with database deletion even if file deletion fails
      }
    }

    // Delete the database record
    const { error: deleteError } = await supabaseAdmin
      .from("video_generation_history")
      .delete()
      .eq("id", videoId)
      .eq("user_id", userId)

    if (deleteError) {
      throw deleteError
    }

    console.log(`[VIDEO_DELETE] Successfully deleted video ${videoId} for user ${userId}`)

    res.status(200).json({
      success: true,
      message: "Video deleted successfully.",
    })
  } catch (error) {
    console.error("[VIDEO_DELETE] Error:", error)
    res.status(500).json({
      success: false,
      message: "Error deleting video.",
      code: "VIDEO_DELETE_ERROR",
      error: error.message,
    })
  }
}

/**
 * Get available video generation options
 */
export const getVideoOptions = async (req, res) => {
  try {
    const options = {
      qualities: [
        {
          name: "high",
          description: "High quality using SadTalker (slower, better quality)",
          estimatedTime: "2-5 minutes",
          features: ["High quality", "Natural expressions", "Head movements"],
        },
        {
          name: "fast",
          description: "Fast generation using Wav2Lip (faster, good quality)",
          estimatedTime: "30-60 seconds",
          features: ["Fast generation", "Good lip sync", "Lower resource usage"],
        },
      ],
      supportedLanguages: ["en", "hi", "es", "fr", "de"],
      maxTextLength: 1000,
    }

    res.status(200).json({
      success: true,
      data: options,
    })
  } catch (err) {
    console.error("[VIDEO_OPTIONS] Error:", err)
    res.status(500).json({
      success: false,
      message: "Error fetching video options.",
      code: "VIDEO_OPTIONS_ERROR",
      error: err.message,
    })
  }
}
