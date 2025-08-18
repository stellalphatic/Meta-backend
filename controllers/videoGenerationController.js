import { supabaseAdmin } from "../services/supabase.js"
import { updateVideoUsage } from "../middleware/usageLimitMiddleware.js"
import fetch from "node-fetch"
import FormData from "form-data"
import crypto from "crypto"
import WebSocket from 'ws'; // This is a placeholder, as your voice service uses websockets
import multer from "multer";

// Multer for receiving MP4 from worker
const videoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 300 * 1024 * 1024 }, // 300MB
});

// In-memory processing queue
const videoQueue = []
// let isProcessingVideo = false




// Cache for avatar details
const avatarDetailsCache = new Map()

/**
 * Generate authentication token for video service
 */
function generateVideoServiceToken() {
    const secretKey = process.env.VIDEO_SERVICE_API_KEY
    if (!secretKey) {
        throw new Error("VIDEO_SERVICE_API_KEY not configured")
    }
    return secretKey
}

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
 * Generate video from text/audio and avatar
 */
export const generateVideo = async (req, res) => {
  const { text, avatarId, quality = "standard", audioUrl, inputType } = req.body;
  const userId = req.user?.id;
  const isWithinLimit = req.isWithinLimit !== false;

  if (!userId) return res.status(401).json({ success: false, message: "Authentication required." });
  if (!avatarId) return res.status(400).json({ success: false, message: "Avatar ID is required." });
  if (inputType === "script" && (!text || !text.trim()))
    return res.status(400).json({ success: false, message: "Text is required for script-to-video generation." });
  if (inputType === "audio" && !audioUrl)
    return res.status(400).json({ success: false, message: "Audio URL is required for audio-to-video generation." });
  if (!isWithinLimit)
    return res.status(403).json({ success: false, message: "You have exceeded your monthly limit.", usageInfo: req.usageInfo });

  if (text && text.trim().length > 500)
    return res.status(400).json({ success: false, message: "Text is too long. Max 500 chars." });

  try {
    // 1) avatar details (cached)
    let avatarDetails;
    if (!avatarDetailsCache.has(avatarId)) {
      const { data, error } = await supabaseAdmin
        .from("avatars")
        .select("name, image_url, voice_url")
        .eq("id", avatarId)
        .single();
      if (error || !data) return res.status(404).json({ success: false, message: "Avatar not found." });
      avatarDetailsCache.set(avatarId, data);
    }
    avatarDetails = avatarDetailsCache.get(avatarId);
    if (inputType === "script" && !avatarDetails.voice_url)
      return res.status(400).json({ success: false, message: "Avatar is missing a voice." });

    // 2) create DB record
    const { data: videoRecord, error: insertError } = await supabaseAdmin
      .from("video_generation_history")
      .insert({
        user_id: userId,
        avatar_id: avatarId,
        prompt: text || null,
        quality,
        audio_url: audioUrl || null,
        video_url: "",
        status: "queued",
        progress: 0,
        error_message: null,
        input_type: inputType || "script",
        created_at: new Date().toISOString(),
      })
      .select()
      .single();
    if (insertError) {
      console.error("[VIDEO_GEN] record create error:", insertError);
      return res.status(500).json({ success: false, message: "Failed to create record." });
    }

    // 3) if script → call voice, upload to Supabase
    let finalAudioUrl = audioUrl || null;
    if (inputType === "script") {
      const voiceServiceBaseUrl = process.env.COQUI_XTTS_BASE_URL;
      if (!voiceServiceBaseUrl) throw new Error("Voice service not configured.");
      const voiceServiceToken = generateVoiceServiceToken();

      const audioResponse = await fetch(`${voiceServiceBaseUrl}/generate-audio`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: voiceServiceToken },
        body: JSON.stringify({
          voice_id: avatarId,
          voice_clone_url: avatarDetails.voice_url,
          text,
          language: "en",
        }),
      });

      if (!audioResponse.ok) {
        const errorText = await audioResponse.text();
        throw new Error(`Voice generation failed: ${errorText}`);
      }

      const audioBuffer = Buffer.from(await audioResponse.arrayBuffer());
      const audioFileName = `temp_audio/${userId}/${videoRecord.id}-${Date.now()}.wav`;
      const { error: audioUploadError } = await supabaseAdmin.storage
        .from("avatar-media")
        .upload(audioFileName, audioBuffer, { contentType: "audio/wav", upsert: false });
      if (audioUploadError) throw new Error(`Upload audio failed: ${audioUploadError.message}`);
      const { data: urlData } = await supabaseAdmin.storage.from("avatar-media").getPublicUrl(audioFileName);
      finalAudioUrl = urlData.publicUrl;

      await supabaseAdmin
        .from("video_generation_history")
        .update({ audio_url: finalAudioUrl, progress: 50 })
        .eq("id", videoRecord.id);
    }

    // 4) Call video-service /generate-video (it just enqueues → returns fast)
    const videoServiceUrl = process.env.VIDEO_SERVICE_URL;
    if (!videoServiceUrl) throw new Error("VIDEO_SERVICE_URL not configured");

    const formData = new FormData();
    formData.append("image_url", avatarDetails.image_url);
    formData.append("audio_url", finalAudioUrl);
    formData.append("quality", quality);

    const response = await fetch(`${videoServiceUrl}/generate-video`, {
      method: "POST",
      headers: {
        Authorization: process.env.VIDEO_SERVICE_API_KEY, // your existing auth
        ...formData.getHeaders(),
      },
      body: formData,
    });
    if (!response.ok) {
      const t = await response.text();
      throw new Error(`Video-service error: ${t}`);
    }
    const { task_id } = await response.json();
    if (!task_id) throw new Error("Video-service did not return task_id");

    // 5) store worker task id, keep status queued
    await supabaseAdmin.from("video_generation_history").update({ task_id }).eq("id", videoRecord.id);

    return res.status(200).json({
      success: true,
      message: "Video enqueued.",
      data: { taskId: videoRecord.id, status: "queued" },
    });
  } catch (error) {
    console.error("[VIDEO_GEN] error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};


export const getVideoStatus = async (req, res) => {
    const { taskId } = req.params
    const userId = req.user?.id

    if (!userId) {
        return res.status(401).json({
            success: false,
            message: "Authentication required.",
        })
    }

    try {
        const { data: video, error } = await supabaseAdmin
            .from("video_generation_history")
            .select("*")
            .eq("id", taskId)
            .eq("user_id", userId)
            .single()

        if (error || !video) {
            return res.status(404).json({
                success: false,
                message: "Video generation task not found.",
            })
        }

        res.status(200).json({
            success: true,
            data: {
                taskId: video.id,
                status: video.status,
                progress: video.progress || 0,
                video_url: video.video_url,
                error_message: video.error_message,
                created_at: video.created_at,
            },
        })
    } catch (error) {
        console.error("Error fetching video status:", error)
        res.status(500).json({
            success: false,
            message: "Failed to fetch video status.",
            error: error.message,
        })
    }
}

// ------------------------------------------------------------------------------------------------------
/**
 * Get user's video generation history
 */
export const getVideoHistory = async (req, res) => {
    const userId = req.user?.id

    if (!userId) {
        return res.status(401).json({
            success: false,
            message: "Authentication required.",
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
            .limit(50)

        if (error) throw error

        res.status(200).json({
            success: true,
            data: {
                videos: data || [],
                total: data?.length || 0,
            },
        })
    } catch (error) {
        console.error("[VIDEO_HISTORY] Error:", error)
        res.status(500).json({
            success: false,
            message: "Error fetching video history.",
            error: error.message,
        })
    }
}

// ------------------------------------------------------------------------------------------------------
/**
 * Delete generated video
 */
export const deleteVideo = async (req, res) => {
    const { videoId } = req.params
    const userId = req.user?.id

    if (!userId) {
        return res.status(401).json({
            success: false,
            message: "Authentication required.",
        })
    }

    if (!videoId) {
        return res.status(400).json({
            success: false,
            message: "Video ID is required.",
        })
    }

    try {
        // Get the video record to check ownership and get file URL
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
            })
        }

        // Delete the video file from storage if it exists
        if (video.video_url) {
            try {
                const urlParts = video.video_url.split("/avatar-media/")
                if (urlParts.length > 1) {
                    const filePath = urlParts[1]
                    await supabaseAdmin.storage.from("avatar-media").remove([filePath])
                    console.log(`[VIDEO_DELETE] Deleted video file: ${filePath}`)
                }
            } catch (storageError) {
                console.warn("[VIDEO_DELETE] Failed to delete video file from storage:", storageError)
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
            error: error.message,
        })
    }
}

// ------------------------------------------------------------------------------------------------------
/**
 * Get video generation options (avatars)
 */
export const getVideoOptions = async (req, res) => {
    const userId = req.user?.id

    if (!userId) {
        return res.status(401).json({
            success: false,
            message: "Authentication required.",
        })
    }

    try {
        // Get user's avatars and public avatars
        const { data: userAvatars, error: userError } = await supabaseAdmin
            .from("avatars")
            .select("*")
            .eq("user_id", userId)
            .order("created_at", { ascending: false })

        if (userError) throw userError

        const { data: publicAvatars, error: publicError } = await supabaseAdmin
            .from("avatars")
            .select("*")
            .eq("is_public", true)
            .neq("user_id", userId)
            .order("created_at", { ascending: false })

        if (publicError) throw publicError

        res.status(200).json({
            success: true,
            data: {
                userAvatars: userAvatars || [],
                publicAvatars: publicAvatars || [],
                qualityOptions: [
                    { value: "standard", label: "Standard (512x512)" },
                    { value: "high", label: "High (1024x1024)" },
                ],
            },
        })
    } catch (error) {
        console.error("[VIDEO_OPTIONS] Error:", error)
        res.status(500).json({
            success: false,
            message: "Error fetching video options.",
            error: error.message,
        })
    }
}

// ------------------------------------------------------------------------------------------------------
/**
 * Upload audio file for video generation
 */
export const uploadAudioForVideo = async (req, res) => {
    const userId = req.user?.id

    if (!userId) {
        return res.status(401).json({
            success: false,
            message: "Authentication required.",
        })
    }

    if (!req.file) {
        return res.status(400).json({
            success: false,
            message: "Audio file is required.",
        })
    }

    try {
        const audioFile = req.file
        const fileName = `video_audio/${userId}/${Date.now()}-${audioFile.originalname}`

        // Upload to storage
        const { data: uploadData, error: uploadError } = await supabaseAdmin.storage
            .from("avatar-media")
            .upload(fileName, audioFile.buffer, {
                contentType: audioFile.mimetype,
            })

        if (uploadError) {
            throw new Error(`Storage upload failed: ${uploadError.message}`)
        }

        const { data: urlData } = supabaseAdmin.storage.from("avatar-media").getPublicUrl(fileName)
        const audioUrl = urlData.publicUrl

        console.log(`[AUDIO_UPLOAD] Audio uploaded to: ${audioUrl}`)

        res.status(200).json({
            success: true,
            message: "Audio uploaded successfully.",
            data: {
                audioUrl: audioUrl,
                fileName: audioFile.originalname,
            },
        })
    } catch (error) {
        console.error("[AUDIO_UPLOAD] Error:", error)
        res.status(500).json({
            success: false,
            message: "Failed to upload audio.",
            error: error.message,
        })
    }
}


// handle worker -> backend callback (status + optional file)
export const handleWorkerCallback = [
  videoUpload.single("file"), // expects field name "file"
  async (req, res) => {
    try {
      const { task_id: taskId, status, error } = req.body;

      if (!taskId || !status) {
        return res.status(400).json({ success: false, message: "task_id and status required" });
      }

      // Locate the DB record (your id is your taskId)
      const { data: rec, error: findErr } = await supabaseAdmin
        .from("video_generation_history")
        .select("user_id, prompt")
        .eq("id", taskId)
        .single();

      if (findErr || !rec) {
        return res.status(404).json({ success: false, message: "Task not found" });
      }

      if (status === "processing") {
        await supabaseAdmin
          .from("video_generation_history")
          .update({ status: "processing", progress: 70 })
          .eq("id", taskId);
        return res.json({ success: true });
      }

      if (status === "failed") {
        await supabaseAdmin
          .from("video_generation_history")
          .update({
            status: "failed",
            error_message: error || "Worker failed",
            progress: 0,
            completed_at: new Date().toISOString(),
          })
          .eq("id", taskId);
        return res.json({ success: true });
      }

      if (status === "completed") {
        // Expecting MP4 file in req.file
        if (!req.file) {
          return res.status(400).json({ success: false, message: "Missing file for completed task" });
        }

        // Save to Supabase Storage
        const path = `generated_videos/${taskId}/${Date.now()}.mp4`;
        const { error: upErr } = await supabaseAdmin.storage
          .from("avatar-media")
          .upload(path, req.file.buffer, { contentType: "video/mp4", upsert: false });
        if (upErr) {
          // If upload fails, mark as failed
          await supabaseAdmin
            .from("video_generation_history")
            .update({
              status: "failed",
              error_message: `Upload failed: ${upErr.message}`,
              progress: 0,
              completed_at: new Date().toISOString(),
            })
            .eq("id", taskId);
          return res.status(500).json({ success: false, message: upErr.message });
        }

        const { data: urlData } = supabaseAdmin.storage.from("avatar-media").getPublicUrl(path);
        const videoUrl = urlData.publicUrl;

        await supabaseAdmin
          .from("video_generation_history")
          .update({
            video_url: videoUrl,
            status: "completed",
            progress: 100,
            completed_at: new Date().toISOString(),
          })
          .eq("id", taskId);

        // Update usage (rough estimate if script provided)
        const estimatedDuration = Math.max(0.5, (rec?.prompt?.length || 60) * 0.01);
        await updateVideoUsage(rec.user_id, estimatedDuration);

        return res.json({ success: true, video_url: videoUrl });
      }

      return res.status(400).json({ success: false, message: `Unknown status: ${status}` });
    } catch (e) {
      console.error("[CALLBACK] Error:", e);
      return res.status(500).json({ success: false, message: e.message });
    }
  },
];