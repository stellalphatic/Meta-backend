import { supabaseAdmin } from "../services/supabase.js"
import { updateVideoUsage } from "../middleware/usageLimitMiddleware.js"
import fetch from "node-fetch"
import FormData from "form-data"
import crypto from "crypto"
import WebSocket from 'ws'; // This is a placeholder, as your voice service uses websockets


// In-memory processing queue
const videoQueue = []
// let isProcessingVideo = false


// Concurrency control
const MAX_CONCURRENT_JOBS = parseInt(process.env.MAX_CONCURRENT_JOBS || "1", 10); // Set to 2 or 3 for L4 GPU
let activeJobs = 0;

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
    const { text, avatarId, quality = "standard", audioUrl, inputType } = req.body
    const userId = req.user?.id
    const isWithinLimit = req.isWithinLimit !== false

    console.log(`[VIDEO_GEN] Request from user ${userId} for avatar ${avatarId}, inputType: ${inputType}`)

    // Validation
    if (inputType === "script" && (!text || !text.trim())) {
        return res.status(400).json({
            success: false,
            message: "Text is required for script-to-video generation.",
        })
    }

    if (inputType === "audio" && !audioUrl) {
        return res.status(400).json({
            success: false,
            message: "Audio URL is required for audio-to-video generation.",
        })
    }

    if (!avatarId) {
        return res.status(400).json({
            success: false,
            message: "Avatar ID is required.",
        })
    }

    if (!userId) {
        return res.status(401).json({
            success: false,
            message: "Authentication required.",
        })
    }

    if (!isWithinLimit) {
        return res.status(403).json({
            success: false,
            message: "You have exceeded your monthly video generation limit.",
            usageInfo: req.usageInfo,
        })
    }

    // Check text length
    if (text && text.trim().length > 500) {
        return res.status(400).json({
            success: false,
            message: "Text is too long. Maximum 500 characters allowed.",
        })
    }

    try {
        // Get avatar details from cache or DB
        let avatarDetails
        if (!avatarDetailsCache.has(avatarId)) {
            const { data, error } = await supabaseAdmin
                .from("avatars")
                .select("name, image_url, voice_url")
                .eq("id", avatarId)
                .single()
            if (error || !data) {
                return res.status(404).json({
                    success: false,
                    message: "Avatar not found or accessible.",
                })
            }
            avatarDetailsCache.set(avatarId, data)
        }
        avatarDetails = avatarDetailsCache.get(avatarId)

        if (inputType === "script" && !avatarDetails.voice_url) {
            return res.status(400).json({
                success: false,
                message: "Avatar is missing a voice for script-to-video generation.",
            })
        }

        console.log(`[VIDEO_GEN] Avatar found: ${avatarDetails.name}, image_url: ${avatarDetails.image_url}`)

        // Create record in video_generation_history table
        const { data: videoRecord, error: insertError } = await supabaseAdmin
            .from("video_generation_history")
            .insert({
                user_id: userId,
                avatar_id: avatarId,
                prompt: text || null,
                quality: quality,
                audio_url: audioUrl || null,
                video_url: "",
                status: "queued",
                progress: 0,
                error_message: null,
                input_type: inputType || "script",
                created_at: new Date().toISOString(),
            })
            .select()
            .single()

        if (insertError) {
            console.error("[VIDEO_GEN] Error creating record:", insertError)
            return res.status(500).json({
                success: false,
                message: "Failed to create video generation record.",
                error: insertError.message,
            })
        }

        console.log(`[VIDEO_GEN] Video record created with ID: ${videoRecord.id}`)

        // Add to processing queue
        videoQueue.push({
            id: videoRecord.id,
            userId,
            avatarId,
            avatar: avatarDetails,
            text: text || null,
            quality,
            audioUrl,
            inputType,
        })

        // Start processing if not already running
        // if (!isProcessingVideo) {
        //     processVideoQueue().catch((error) => {
        //         console.error("[VIDEO_GEN] Queue processing error:", error)
        //     })
        // }
        processVideoQueue();

        res.status(200).json({
            success: true,
            message: "Video generation started successfully.",
            data: {
                taskId: videoRecord.id,
                status: "queued",
                estimatedTime: "2-5 minutes",
            },
        })
    } catch (error) {
        console.error("[VIDEO_GEN] Error in generateVideo:", error)
        res.status(500).json({
            success: false,
            message: "Failed to start video generation.",
            error: error.message,
        })
    }
}

// ------------------------------------------------------------------------------------------------------
/**
 * Process the video generation queue
 */
async function processVideoQueue() {
    // if (isProcessingVideo || videoQueue.length === 0) {
    //     return
    // }

    // isProcessingVideo = true
    console.log(`[VIDEO_GEN] Processing queue with ${videoQueue.length} tasks`)

    while (videoQueue.length > 0 && activeJobs < MAX_CONCURRENT_JOBS) {
        const task = videoQueue.shift()
        console.log(`[VIDEO_GEN] Starting async processing for task ${task.id}`)
             activeJobs++;

        // Update status to processing BEFORE starting the async job
        supabaseAdmin
            .from("video_generation_history")
            .update({
                status: "processing",
                progress: 20,
            })
            .eq("id", task.id)
            .then(() => {
                console.log(`[VIDEO_GEN] Task ${task.id} status updated: processing (20%)`);
                // Start the job asynchronously
                processVideoGeneration(task)
                    .catch(async (error) => {
                        console.error(`[VIDEO_GEN] Task ${task.id} failed:`, error);
                        // Update record with error
                        await supabaseAdmin
                            .from("video_generation_history")
                            .update({
                                status: "failed",
                                error_message: error.message,
                                progress: 0,
                            })
                            .eq("id", task.id);
                        console.log(`[VIDEO_GEN] Task ${task.id} status updated: failed (0%)`);
                    })
                    .finally(() => {
                        activeJobs--;
                        processVideoQueue();
                    });
            })
            .catch((error) => {
                // If updating to processing fails, mark as failed and continue
                console.error(`[VIDEO_GEN] Failed Task ${task.id}:`, error);
                supabaseAdmin
                    .from("video_generation_history")
                    .update({
                        status: "failed",
                        error_message: error.message,
                        progress: 0,
                    })
                    .eq("id", task.id);
                activeJobs--;
                processVideoQueue();
            });
    }

    // isProcessingVideo = false
    console.log(`[VIDEO_GEN] Queue processing completed`)
}

// ------------------------------------------------------------------------------------------------------
/**
 * Process individual video generation task
 */
async function processVideoGeneration(task) {
    console.log(`[VIDEO_GEN] Generating video for task ${task.id}`)

    const videoServiceUrl = process.env.VIDEO_SERVICE_URL
    if (!videoServiceUrl) {
        throw new Error("Video service URL not configured")
    }

    let finalAudioUrl = task.audioUrl
    let cleanupAudioFile = false

    // Step 1: If input is a script, generate audio first
    if (task.inputType === "script" && task.text) {
        console.log(`[VIDEO_GEN] Input type is 'script'. Generating audio from text...`)
        
        const voiceServiceBaseUrl = process.env.COQUI_XTTS_BASE_URL
        if (!voiceServiceBaseUrl) {
            throw new Error("Voice service not configured.")
        }

        try {
            const voiceServiceToken = generateVoiceServiceToken()
            const audioResponse = await fetch(`${voiceServiceBaseUrl}/generate-audio`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: voiceServiceToken,
                },
                body: JSON.stringify({
                    voice_id: task.avatarId,
                    voice_clone_url: task.avatar.voice_url,
                    text: task.text,
                    language: "en", 
                }),
            });

            if (!audioResponse.ok) {
                const errorText = await audioResponse.text()
                throw new Error(`Failed to generate audio from voice service: ${errorText}`)
            }

            const audioBuffer = await audioResponse.arrayBuffer()

            const audioFileName = `temp_audio/${task.userId}/${task.id}-${Date.now()}.wav`
            const { data: audioUploadData, error: audioUploadError } = await supabaseAdmin.storage
                .from("avatar-media")
                .upload(audioFileName, audioBuffer, {
                    contentType: "audio/wav",
                    upsert: false,
                });

            if (audioUploadError) {
                throw new Error(`Failed to upload generated audio: ${audioUploadError.message}`);
            }

            const { data: urlData } = supabaseAdmin.storage.from("avatar-media").getPublicUrl(audioFileName);
            finalAudioUrl = urlData.publicUrl;
            task.tempAudioFileName = audioFileName;
            cleanupAudioFile = true;

            console.log(`[VIDEO_GEN] Audio generated and uploaded successfully: ${finalAudioUrl}`);

        } catch (error) {
            console.error(`[VIDEO_GEN] Error during audio generation for task ${task.id}:`, error);
            throw new Error(`Audio generation failed: ${error.message}`);
        }
    }

    if (!finalAudioUrl) {
        throw new Error("Missing audio URL for video generation.");
    }
    
    // Update progress after audio generation
    await supabaseAdmin
        .from("video_generation_history")
        .update({ progress: 50, audio_url: finalAudioUrl })
        .eq("id", task.id);

    console.log(`[VIDEO_GEN] Calling video service at ${videoServiceUrl}/generate-video`)

    // Step 2: Call the video service with the final audio URL
    const formData = new FormData()
    formData.append("image_url", task.avatar.image_url)
    formData.append("audio_url", finalAudioUrl)
    formData.append("quality", task.quality)

    const videoServiceToken = generateVideoServiceToken()
    const response = await fetch(`${videoServiceUrl}/generate-video`, {
        method: "POST",
        headers: {
            Authorization: videoServiceToken,
            ...formData.getHeaders(),
        },
        body: formData,
    })

    if (!response.ok) {
        const errorText = await response.text()
        console.error(`[VIDEO_GEN] Video service error: ${response.status}: ${errorText}`)
        throw new Error(`Video service error: ${errorText}`)
    }

    const result = await response.json()
    if (!result.task_id) {
        throw new Error("Video service did not return a task ID")
    }

    const videoServiceTaskId = result.task_id
    console.log(`[VIDEO_GEN] Video service task ID: ${videoServiceTaskId}`)

    // Update the DB record with the video service task ID
    await supabaseAdmin
        .from("video_generation_history")
        .update({ task_id: videoServiceTaskId, progress: 70 })
        .eq("id", task.id)
        
    // Step 3: Poll for completion
    await _pollVideoCompletion(videoServiceTaskId, task.id, task.quality, task.text, task.userId)

    // Step 4: Cleanup temporary audio file if it was generated
    if (cleanupAudioFile && task.tempAudioFileName) {
        try {
            await supabaseAdmin.storage.from("avatar-media").remove([task.tempAudioFileName]);
            console.log(`[VIDEO_GEN] Cleaned up temp audio: ${task.tempAudioFileName}`);
        } catch (cleanupError) {
            console.warn("[VIDEO_GEN] Failed to cleanup temp audio:", cleanupError);
        }
    }
}
// ------------------------------------------------------------------------------------------------------
/**
 * Background function to poll video completion
 */
async function _pollVideoCompletion(taskId, videoRecordId, quality, prompt, userId) {
    const maxAttempts = quality === "high" ? 240 : 120
    const pollInterval = quality === "high" ? 5000 : 3000
    const videoGenBaseUrl = process.env.VIDEO_SERVICE_URL

    console.log(`[VIDEO_GEN] Starting background polling for task ${taskId}`)

    let attempts = 0
    let videoCompleted = false
    let videoUrl = null

    while (attempts < maxAttempts && !videoCompleted) {
        await new Promise((resolve) => setTimeout(resolve, pollInterval))
        attempts++

        try {
            const statusResponse = await fetch(`${videoGenBaseUrl}/video-status/${taskId}`, {
                headers: {
                    Authorization: generateVideoServiceToken(),
                },
            })

            if (statusResponse.ok) {
                const contentType = statusResponse.headers.get("content-type")

                if (contentType && contentType.includes("video/mp4")) {
                    console.log(`[VIDEO_GEN] Video ready for task ${taskId}, downloading...`)
                    const videoBuffer = await statusResponse.arrayBuffer()
                    
                    if (videoBuffer.byteLength === 0) {
                        console.error(`[VIDEO_GEN] Downloaded video is empty for task ${taskId}`)
                        continue
                    }

                    const videoFileName = `generated_videos/${videoRecordId}/${quality}-${Date.now()}.mp4`
                    const { error: videoUploadError } = await supabaseAdmin.storage
                        .from("avatar-media")
                        .upload(videoFileName, videoBuffer, { contentType: "video/mp4", upsert: false })

                    if (videoUploadError) {
                        throw new Error(`Failed to store generated video: ${videoUploadError.message}`)
                    }

                    const { data: videoUrlData } = supabaseAdmin.storage.from("avatar-media").getPublicUrl(videoFileName)
                    videoUrl = videoUrlData.publicUrl

                    await supabaseAdmin
                        .from("video_generation_history")
                        .update({ video_url: videoUrl, status: "completed", completed_at: new Date().toISOString(), progress: 100 })
                        .eq("id", videoRecordId)

                    const estimatedDuration = Math.max(0.5, (prompt?.length || 60) * 0.01)
                    await updateVideoUsage(userId, estimatedDuration)

                    console.log(`[VIDEO_GEN] Video generation completed for task ${taskId}`)
                    console.log(`[VIDEO_GEN] Video URL: ${videoUrl}`)
                    videoCompleted = true
                } else {
                    const statusResult = await statusResponse.json()
                    console.log(`[VIDEO_GEN] Task ${taskId} status: ${statusResult.status || "processing"} (attempt ${attempts})`)
                    if (statusResult.status === "failed") {
                        throw new Error(`Video generation failed: ${statusResult.error || "Unknown error"}`)
                    }
                }
            } else if (statusResponse.status === 404) {
                console.log(`[VIDEO_GEN] Task ${taskId} not found (attempt ${attempts})`)
            } else {
                console.log(`[VIDEO_GEN] Status check failed for task ${taskId}: ${statusResponse.status} (attempt ${attempts})`)
            }
        } catch (pollError) {
            console.error(`[VIDEO_GEN] Error polling (attempt ${attempts}):`, pollError.message)
            if (attempts >= maxAttempts) {
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
    }

    if (!videoCompleted) {
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

// ------------------------------------------------------------------------------------------------------

/**
 * Get video generation status
 */
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