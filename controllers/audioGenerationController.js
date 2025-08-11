import { supabaseAdmin } from "../services/supabase.js"
import fetch from "node-fetch"
import crypto from "crypto"

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
 * Generate audio using voice cloning service
 */
export const generateAudio = async (req, res) => {
  const { voiceId, text, language = "en" } = req.body
  const userId = req.user?.id

  console.log(`[AUDIO_GEN] Request from user ${userId} for voice ${voiceId}`)

  if (!voiceId || !text || !text.trim()) {
    return res.status(400).json({
      success: false,
      message: "Missing voiceId or text for audio generation.",
      code: "MISSING_PARAMETERS",
    })
  }

  if (!userId) {
    return res.status(401).json({
      success: false,
      message: "Authentication required.",
      code: "AUTH_REQUIRED",
    })
  }

  // Check if user is within audio generation limits
  if (req.isWithinAudioLimit === false) {
    return res.status(403).json({
      success: false,
      message: "You have exceeded your monthly audio generation limit.",
      code: "USAGE_LIMIT_EXCEEDED",
      usageInfo: req.audioUsageInfo,
    })
  }

  let generatedAudioRecord = null

  try {
    // 1. Fetch voice details
    const { data: voiceData, error: voiceError } = await supabaseAdmin
      .from("voices")
      .select("name, audio_url")
      .eq("id", voiceId)
      .single()

    if (voiceError || !voiceData) {
      console.error(`[AUDIO_GEN] Error fetching voice details for ${voiceId}:`, voiceError)
      return res.status(404).json({
        success: false,
        message: "Voice not found or accessible.",
        code: "VOICE_NOT_FOUND",
      })
    }

    const { audio_url: voiceCloneUrl } = voiceData

    if (!voiceCloneUrl) {
      console.error(`[AUDIO_GEN] Voice ${voiceId} is missing audio URL.`)
      return res.status(400).json({
        success: false,
        message: "Voice is not properly configured for audio generation.",
        code: "VOICE_INCOMPLETE",
      })
    }

    // 2. Create initial record in database
    try {
      const { data, error: insertError } = await supabaseAdmin
        .from("generated_audios")
        .insert({
          user_id: userId,
          voice_id: voiceId,
          text_input: text,
          language: language,
          audio_url: "", // Will be updated when generation completes
          status: "generating",
          error_message: null,
          created_at: new Date().toISOString(),
          timestamp: new Date().toISOString(),
        })
        .select()
        .single()

      if (insertError) {
        console.error("[AUDIO_GEN] Error saving audio metadata:", insertError)
        throw new Error(`Database error: ${insertError.message}`)
      }

      generatedAudioRecord = data
      console.log(`[AUDIO_GEN] Audio record saved with ID: ${generatedAudioRecord.id}`)
    } catch (dbError) {
      console.error("[AUDIO_GEN] Database operation failed:", dbError)
      return res.status(500).json({
        success: false,
        message: "Failed to save audio generation record.",
        code: "DATABASE_ERROR",
        error: dbError.message,
      })
    }

    // 3. Generate Audio from Text
    console.log(`[AUDIO_GEN] Generating audio from text...`)
    const voiceServiceBaseUrl = process.env.COQUI_XTTS_BASE_URL

    if (!voiceServiceBaseUrl) {
      await supabaseAdmin
        .from("generated_audios")
        .update({
          status: "failed",
          error_message: "Voice service not configured",
        })
        .eq("id", generatedAudioRecord.id)

      return res.status(500).json({
        success: false,
        message: "Voice service not configured.",
        code: "SERVICE_NOT_CONFIGURED",
      })
    }

    // Generate proper authentication token for voice service
    const voiceServiceToken = generateVoiceServiceToken()
    console.log(`[AUDIO_GEN] Generated voice service token: ${voiceServiceToken.substring(0, 20)}...`)

    const audioResponse = await fetch(`${voiceServiceBaseUrl}/generate-audio`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: voiceServiceToken,
      },
      body: JSON.stringify({
        voice_id: voiceId,
        voice_clone_url: voiceCloneUrl,
        text: text,
        language: language,
      }),
    })

    if (!audioResponse.ok) {
      const errorText = await audioResponse.text()
      console.error("[AUDIO_GEN] Voice service error:", audioResponse.status, errorText)

      await supabaseAdmin
        .from("generated_audios")
        .update({
          status: "failed",
          error_message: `Voice service error: ${errorText}`,
        })
        .eq("id", generatedAudioRecord.id)

      return res.status(audioResponse.status).json({
        success: false,
        message: `Failed to generate audio: ${errorText}`,
        code: "AUDIO_GENERATION_FAILED",
      })
    }

    console.log(`[AUDIO_GEN] Audio generation successful`)
    const audioBlob = await audioResponse.blob()

    // Upload audio to storage
    const audioFileName = `generated_audios/${userId}/${generatedAudioRecord.id}-${Date.now()}.wav`
    const { data: audioUploadData, error: audioUploadError } = await supabaseAdmin.storage
      .from("avatar-media")
      .upload(audioFileName, audioBlob, {
        contentType: "audio/wav",
        upsert: false,
      })

    if (audioUploadError) {
      console.error("[AUDIO_GEN] Error uploading audio:", audioUploadError)

      await supabaseAdmin
        .from("generated_audios")
        .update({
          status: "failed",
          error_message: "Failed to store generated audio",
        })
        .eq("id", generatedAudioRecord.id)

      return res.status(500).json({
        success: false,
        message: "Failed to store generated audio.",
        code: "AUDIO_UPLOAD_FAILED",
      })
    }

    const { data: audioUrlData } = supabaseAdmin.storage.from("avatar-media").getPublicUrl(audioFileName)
    const audioUrl = audioUrlData.publicUrl
    console.log(`[AUDIO_GEN] Audio uploaded to: ${audioUrl}`)

    // Update database record with final URL
    const { data: updatedRecord, error: updateError } = await supabaseAdmin
      .from("generated_audios")
      .update({
        audio_url: audioUrl,
        status: "completed",
      })
      .eq("id", generatedAudioRecord.id)
      .select()
      .single()

    if (updateError) {
      console.error("[AUDIO_GEN] Error updating record:", updateError)
    }

    // Update user's audio generation usage
    try {
      const { data: profile, error: fetchError } = await supabaseAdmin
        .from("profiles")
        .select("audio_generation_this_month")
        .eq("id", userId)
        .single()

      if (!fetchError && profile) {
        const currentUsage = profile.audio_generation_this_month || 0
        const newUsage = currentUsage + 1

        await supabaseAdmin
          .from("profiles")
          .update({
            audio_generation_this_month: newUsage,
            updated_at: new Date().toISOString(),
          })
          .eq("id", userId)

        console.log(`[AUDIO_GEN] Updated audio usage for user ${userId}: +1 generation (total: ${newUsage})`)
      }
    } catch (usageError) {
      console.error("[AUDIO_GEN] Error updating usage:", usageError)
    }

    res.status(200).json({
      success: true,
      message: "Audio generated successfully!",
      data: {
        record: updatedRecord || generatedAudioRecord,
        audioUrl: audioUrl,
        usageInfo: req.audioUsageInfo,
      },
    })
  } catch (err) {
    console.error("[AUDIO_GEN] Server error:", err)

    // If we have a record, mark it as failed
    if (generatedAudioRecord) {
      try {
        await supabaseAdmin
          .from("generated_audios")
          .update({
            status: "failed",
            error_message: err.message,
          })
          .eq("id", generatedAudioRecord.id)
      } catch (updateError) {
        console.error("[AUDIO_GEN] Failed to update error status:", updateError)
      }
    }

    res.status(500).json({
      success: false,
      message: "Internal server error during audio generation.",
      code: "INTERNAL_ERROR",
      error: err.message,
    })
  }
}

/**
 * Get user's audio generation history
 */
export const getAudioHistory = async (req, res) => {
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
      .from("generated_audios")
      .select(`
        *,
        voices (
          name
        )
      `)
      .eq("user_id", userId)
      .order("created_at", { ascending: false })

    if (error) throw error

    res.status(200).json({
      success: true,
      data: {
        audios: data || [],
        total: data?.length || 0,
      },
    })
  } catch (err) {
    console.error("[AUDIO_HISTORY] Error:", err)
    res.status(500).json({
      success: false,
      message: "Error fetching audio history.",
      code: "AUDIO_HISTORY_ERROR",
      error: err.message,
    })
  }
}

/**
 * Delete a generated audio record
 */
export const deleteAudio = async (req, res) => {
  const { audioId } = req.params
  const userId = req.user?.id

  if (!userId) {
    return res.status(401).json({
      success: false,
      message: "Authentication required.",
      code: "AUTH_REQUIRED",
    })
  }

  if (!audioId) {
    return res.status(400).json({
      success: false,
      message: "Audio ID is required.",
      code: "MISSING_AUDIO_ID",
    })
  }

  try {
    // First, get the audio record to check ownership and get file URL
    const { data: audio, error: fetchError } = await supabaseAdmin
      .from("generated_audios")
      .select("*")
      .eq("id", audioId)
      .eq("user_id", userId)
      .single()

    if (fetchError || !audio) {
      return res.status(404).json({
        success: false,
        message: "Audio not found or you don't have permission to delete it.",
        code: "AUDIO_NOT_FOUND",
      })
    }

    // Delete the audio file from storage if it exists
    if (audio.audio_url) {
      try {
        // Extract file path from URL
        const urlParts = audio.audio_url.split("/avatar-media/")
        if (urlParts.length > 1) {
          const filePath = urlParts[1]
          await supabaseAdmin.storage.from("avatar-media").remove([filePath])
          console.log(`[AUDIO_DELETE] Deleted audio file: ${filePath}`)
        }
      } catch (storageError) {
        console.warn("[AUDIO_DELETE] Failed to delete audio file from storage:", storageError)
        // Continue with database deletion even if file deletion fails
      }
    }

    // Delete the database record
    const { error: deleteError } = await supabaseAdmin
      .from("generated_audios")
      .delete()
      .eq("id", audioId)
      .eq("user_id", userId)

    if (deleteError) {
      throw deleteError
    }

    console.log(`[AUDIO_DELETE] Successfully deleted audio ${audioId} for user ${userId}`)

    res.status(200).json({
      success: true,
      message: "Audio deleted successfully.",
    })
  } catch (error) {
    console.error("[AUDIO_DELETE] Error:", error)
    res.status(500).json({
      success: false,
      message: "Error deleting audio.",
      code: "AUDIO_DELETE_ERROR",
      error: error.message,
    })
  }
}
