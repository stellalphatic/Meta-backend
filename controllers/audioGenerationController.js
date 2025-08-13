import { supabaseAdmin } from "../services/supabase.js"
import { updateAudioUsage } from "../middleware/usageLimitMiddleware.js"
import fetch from "node-fetch"
import crypto from "crypto"
import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"
import { exec } from "child_process"
import { promisify } from "util"

const execAsync = promisify(exec)
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// In-memory processing queue
const processingQueue = []
let isProcessing = false

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
 * Estimate token count (more conservative: 1 token ≈ 3 characters for safety)
 */
function estimateTokenCount(text) {
  return Math.ceil(text.length / 3)
}

/**
 * Split text into chunks based on XTTS 400 token limit (very conservative: 200 tokens per chunk)
 */
function splitTextIntoChunks(text, maxTokens = 200) {
  const maxChars = maxTokens * 3 // Very conservative: 200 tokens = 600 chars max
  const sentences = text.split(/[.!?]+/).filter((s) => s.trim().length > 0)
  const chunks = []
  let currentChunk = ""

  console.log(`[CHUNKING] Input text: ${text.length} chars, estimated ${estimateTokenCount(text)} tokens`)
  console.log(`[CHUNKING] Target: max ${maxTokens} tokens (${maxChars} chars) per chunk`)

  for (const sentence of sentences) {
    const trimmedSentence = sentence.trim()
    const potentialChunk = currentChunk ? `${currentChunk}. ${trimmedSentence}` : trimmedSentence

    if (potentialChunk.length <= maxChars) {
      currentChunk = potentialChunk
    } else {
      // Current chunk is full, save it and start new one
      if (currentChunk) {
        chunks.push(currentChunk + ".")
        console.log(
          `[CHUNKING] Created chunk: ${currentChunk.length} chars, ~${estimateTokenCount(currentChunk)} tokens`,
        )
      }

      // If single sentence is too long, split by words
      if (trimmedSentence.length > maxChars) {
        const words = trimmedSentence.split(" ")
        let wordChunk = ""

        for (const word of words) {
          const potentialWordChunk = wordChunk ? `${wordChunk} ${word}` : word

          if (potentialWordChunk.length <= maxChars) {
            wordChunk = potentialWordChunk
          } else {
            if (wordChunk) {
              chunks.push(wordChunk)
              console.log(
                `[CHUNKING] Created word chunk: ${wordChunk.length} chars, ~${estimateTokenCount(wordChunk)} tokens`,
              )
            }
            wordChunk = word
          }
        }

        if (wordChunk) {
          currentChunk = wordChunk
        }
      } else {
        currentChunk = trimmedSentence
      }
    }
  }

  if (currentChunk) {
    chunks.push(currentChunk + ".")
    console.log(`[CHUNKING] Final chunk: ${currentChunk.length} chars, ~${estimateTokenCount(currentChunk)} tokens`)
  }

  const finalChunks = chunks.filter((chunk) => chunk.trim().length > 0)
  console.log(`[CHUNKING] Total chunks created: ${finalChunks.length}`)

  return finalChunks
}

/**
 * Concatenate audio files using FFmpeg
 */
async function concatenateAudioFiles(audioBuffers, tempDir) {
  if (audioBuffers.length === 1) {
    console.log(`[AUDIO_CONCAT] Single chunk, no concatenation needed`)
    return audioBuffers[0]
  }

  try {
    console.log(`[AUDIO_CONCAT] Concatenating ${audioBuffers.length} audio chunks`)

    // Create temporary directory if it doesn't exist
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true })
    }

    // Save individual audio buffers as temporary files
    const tempFiles = []
    const fileListPath = path.join(tempDir, `filelist_${Date.now()}.txt`)
    let fileListContent = ""

    for (let i = 0; i < audioBuffers.length; i++) {
      const tempFilePath = path.join(tempDir, `chunk_${i}_${Date.now()}.wav`)
      fs.writeFileSync(tempFilePath, Buffer.from(audioBuffers[i]))
      tempFiles.push(tempFilePath)
      fileListContent += `file '${tempFilePath}'\n`
      console.log(`[AUDIO_CONCAT] Saved chunk ${i + 1}: ${audioBuffers[i].byteLength} bytes`)
    }

    // Write file list for FFmpeg concat
    fs.writeFileSync(fileListPath, fileListContent)

    // Output file path
    const outputPath = path.join(tempDir, `concatenated_${Date.now()}.wav`)

    // Use FFmpeg to concatenate audio files
    const ffmpegCommand = `ffmpeg -f concat -safe 0 -i "${fileListPath}" -c copy "${outputPath}"`

    console.log(`[AUDIO_CONCAT] Running FFmpeg command: ${ffmpegCommand}`)

    await execAsync(ffmpegCommand)

    // Read the concatenated file
    const concatenatedBuffer = fs.readFileSync(outputPath)
    console.log(`[AUDIO_CONCAT] Concatenated file size: ${concatenatedBuffer.byteLength} bytes`)

    // Cleanup temporary files
    tempFiles.forEach((file) => {
      try {
        fs.unlinkSync(file)
      } catch (err) {
        console.warn(`[AUDIO_CONCAT] Failed to delete temp file ${file}:`, err.message)
      }
    })

    try {
      fs.unlinkSync(fileListPath)
      fs.unlinkSync(outputPath)
    } catch (err) {
      console.warn(`[AUDIO_CONCAT] Failed to delete temp files:`, err.message)
    }

    return concatenatedBuffer
  } catch (error) {
    console.error(`[AUDIO_CONCAT] Error concatenating audio:`, error)
    throw new Error(`Audio concatenation failed: ${error.message}`)
  }
}

/**
 * Generate audio from text
 */
export const generateAudio = async (req, res) => {
  const { text, voiceId, language = "en" } = req.body
  const userId = req.user?.id
  const isWithinLimit = req.isWithinAudioLimit !== false

  console.log(`[AUDIO_GEN] Generate audio request:`, {
    userId,
    voiceId,
    textLength: text?.length,
    estimatedTokens: text ? estimateTokenCount(text) : 0,
    language,
  })

  if (!text || !text.trim()) {
    return res.status(400).json({
      success: false,
      message: "Text is required.",
    })
  }

  if (!voiceId) {
    return res.status(400).json({
      success: false,
      message: "Voice ID is required.",
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
      message: "You have exceeded your monthly audio generation limit.",
      usageInfo: req.audioUsageInfo,
    })
  }

  // Check text length - limit to 1000 characters
  const textLength = text.trim().length
  const estimatedTokens = estimateTokenCount(text.trim())

  if (textLength > 1000) {
    return res.status(400).json({
      success: false,
      message: "Text is too long. Maximum 1000 characters allowed.",
    })
  }

  console.log(`[AUDIO_GEN] Text analysis: ${textLength} chars, ~${estimatedTokens} tokens`)

  try {
    // Create record in database with exact schema match
    const { data: audioRecord, error: insertError } = await supabaseAdmin
      .from("generated_audios")
      .insert({
        user_id: userId,
        voice_id: voiceId,
        text_input: text.trim(),
        language: language,
        audio_url: "", // Required field, will be updated when processing completes
        created_at: new Date().toISOString(),
        timestamp: new Date().toISOString(),
        status: "queued",
        error_message: null,
      })
      .select()
      .single()

    if (insertError) {
      console.error("[AUDIO_GEN] Error creating record:", insertError)
      return res.status(500).json({
        success: false,
        message: "Failed to create audio generation record.",
        error: insertError.message,
      })
    }

    console.log(`[AUDIO_GEN] Created record: ${audioRecord.id}`)

    // Add to processing queue
    processingQueue.push({
      id: audioRecord.id,
      userId,
      voiceId,
      text: text.trim(),
      language,
    })

    // Start processing if not already running
    if (!isProcessing) {
      processQueue().catch((error) => {
        console.error("[AUDIO_GEN] Queue processing error:", error)
      })
    }

    const estimatedChunks = Math.ceil(estimatedTokens / 200)
    res.status(200).json({
      success: true,
      message: "Audio generation started successfully.",
      data: {
        record: audioRecord,
        audioId: audioRecord.id,
        status: "queued",
        estimatedTime: estimatedChunks > 1 ? "60-120 seconds" : "30-60 seconds",
        chunks: estimatedChunks,
      },
    })
  } catch (error) {
    console.error("[AUDIO_GEN] Error in generateAudio:", error)
    res.status(500).json({
      success: false,
      message: "Failed to start audio generation.",
      error: error.message,
    })
  }
}

/**
 * Process the audio generation queue with aggressive text chunking and audio concatenation
 */
async function processQueue() {
  if (isProcessing || processingQueue.length === 0) {
    return
  }

  isProcessing = true
  console.log(`[AUDIO_GEN] Processing queue with ${processingQueue.length} tasks`)

  while (processingQueue.length > 0) {
    const task = processingQueue.shift()
    console.log(`[AUDIO_GEN] Processing task ${task.id}`)

    try {
      // Update status to processing
      await supabaseAdmin
        .from("generated_audios")
        .update({
          status: "processing",
          timestamp: new Date().toISOString(),
        })
        .eq("id", task.id)

      // Get voice details - try both tables for compatibility
      let voice = null
      let voiceError = null

      // First try 'voices' table
      const { data: voiceData, error: voicesError } = await supabaseAdmin
        .from("voices")
        .select("*")
        .eq("id", task.voiceId)
        .single()

      if (!voicesError && voiceData?.audio_url) {
        voice = voiceData
      } else {
        // Fallback to 'avatars' table
        const { data: avatarData, error: avatarsError } = await supabaseAdmin
          .from("avatars")
          .select("*")
          .eq("id", task.voiceId)
          .single()

        if (!avatarsError && avatarData?.voice_url) {
          voice = { ...avatarData, audio_url: avatarData.voice_url }
        } else {
          voiceError = voicesError || avatarsError
        }
      }

      if (!voice || !voice.audio_url) {
        throw new Error("Voice not found or voice URL missing")
      }

      console.log(`[AUDIO_GEN] Using voice: ${voice.name || "Unknown"} with URL: ${voice.audio_url}`)

      // Split text into very small chunks to ensure we stay under XTTS limits
      const textChunks = splitTextIntoChunks(task.text, 200) // Very conservative: 200 tokens max
      console.log(`[AUDIO_GEN] Split text into ${textChunks.length} chunks for processing`)

      const audioBuffers = []
      const voiceServiceUrl = process.env.COQUI_XTTS_BASE_URL

      if (!voiceServiceUrl) {
        throw new Error("Voice service not configured")
      }

      // Generate audio for each chunk
      for (let i = 0; i < textChunks.length; i++) {
        const chunk = textChunks[i]
        console.log(
          `[AUDIO_GEN] Processing chunk ${i + 1}/${textChunks.length}: "${chunk.substring(0, 50)}..." (${chunk.length} chars, ~${estimateTokenCount(chunk)} tokens)`,
        )

        const voiceServiceToken = generateVoiceServiceToken()

        const response = await fetch(`${voiceServiceUrl}/generate-audio`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: voiceServiceToken,
          },
          body: JSON.stringify({
            voice_id: task.voiceId,
            voice_clone_url: voice.audio_url,
            text: chunk,
            language: task.language,
          }),
        })

        if (!response.ok) {
          const errorText = await response.text()
          console.error(`[AUDIO_GEN] Voice service error for chunk ${i + 1}:`, errorText)
          throw new Error(`Voice service error for chunk ${i + 1}: ${response.status}: ${errorText}`)
        }

        const audioBuffer = await response.arrayBuffer()
        console.log(`[AUDIO_GEN] Chunk ${i + 1} audio buffer size: ${audioBuffer.byteLength} bytes`)

        if (audioBuffer.byteLength === 0) {
          throw new Error(`Generated audio for chunk ${i + 1} is empty`)
        }

        audioBuffers.push(audioBuffer)

        // Longer delay between chunks to avoid overwhelming the service
        if (i < textChunks.length - 1) {
          console.log(`[AUDIO_GEN] Waiting 3 seconds before next chunk...`)
          await new Promise((resolve) => setTimeout(resolve, 3000))
        }
      }

      // Concatenate audio files if multiple chunks
      let finalAudioBuffer
      if (audioBuffers.length > 1) {
        console.log(`[AUDIO_GEN] Concatenating ${audioBuffers.length} audio chunks`)
        const tempDir = path.join(__dirname, "..", "temp", "audio")
        finalAudioBuffer = await concatenateAudioFiles(audioBuffers, tempDir)
        console.log(`[AUDIO_GEN] Concatenated audio buffer size: ${finalAudioBuffer.byteLength} bytes`)
      } else {
        finalAudioBuffer = Buffer.from(audioBuffers[0])
        console.log(`[AUDIO_GEN] Single chunk audio buffer size: ${finalAudioBuffer.byteLength} bytes`)
      }

      // Upload to storage
      const fileName = `generated_audio/${task.userId}/${task.id}-${Date.now()}.wav`
      const { data: uploadData, error: uploadError } = await supabaseAdmin.storage
        .from("avatar-media")
        .upload(fileName, finalAudioBuffer, {
          contentType: "audio/wav",
        })

      if (uploadError) {
        throw new Error(`Storage upload failed: ${uploadError.message}`)
      }

      const { data: urlData } = supabaseAdmin.storage.from("avatar-media").getPublicUrl(fileName)
      const audioUrl = urlData.publicUrl

      console.log(`[AUDIO_GEN] Audio uploaded to: ${audioUrl}`)

      // Update record with success
      await supabaseAdmin
        .from("generated_audios")
        .update({
          audio_url: audioUrl,
          status: "completed",
          error_message: null,
          timestamp: new Date().toISOString(),
        })
        .eq("id", task.id)

      // Update usage - calculate duration based on text length and word count
      const words = task.text.trim().split(/\s+/).length
      const estimatedDuration = Math.max(0.5, words / 150.0) // 150 words per minute
      console.log(`[AUDIO_GEN] Updating usage: ${words} words = ${estimatedDuration.toFixed(2)} minutes`)
      await updateAudioUsage(task.userId, estimatedDuration)

      console.log(`[AUDIO_GEN] Task ${task.id} completed successfully with ${textChunks.length} chunks`)
    } catch (error) {
      console.error(`[AUDIO_GEN] Task ${task.id} failed:`, error)

      // Update record with error
      await supabaseAdmin
        .from("generated_audios")
        .update({
          status: "failed",
          error_message: error.message,
          timestamp: new Date().toISOString(),
        })
        .eq("id", task.id)
    }
  }

  isProcessing = false
  console.log(`[AUDIO_GEN] Queue processing completed`)
}

/**
 * Get audio generation status
 */
export const getAudioStatus = async (req, res) => {
  const { taskId } = req.params
  const userId = req.user?.id

  if (!userId) {
    return res.status(401).json({
      success: false,
      message: "Authentication required.",
    })
  }

  try {
    const { data: audio, error } = await supabaseAdmin
      .from("generated_audios")
      .select("*")
      .eq("id", taskId)
      .eq("user_id", userId)
      .single()

    if (error || !audio) {
      return res.status(404).json({
        success: false,
        message: "Audio generation task not found.",
      })
    }

    // Calculate progress based on status
    let progress = 0
    if (audio.status === "queued") progress = 10
    else if (audio.status === "processing") progress = 50
    else if (audio.status === "completed") progress = 100
    else if (audio.status === "failed") progress = 0

    res.status(200).json({
      success: true,
      data: {
        taskId: audio.id,
        status: audio.status,
        progress: progress,
        audio_url: audio.audio_url,
        error_message: audio.error_message,
        created_at: audio.created_at,
        timestamp: audio.timestamp,
      },
    })
  } catch (error) {
    console.error("Error fetching audio status:", error)
    res.status(500).json({
      success: false,
      message: "Failed to fetch audio status.",
      error: error.message,
    })
  }
}

/**
 * Get user's generated audio history
 */
export const getAudioHistory = async (req, res) => {
  const userId = req.user?.id

  if (!userId) {
    return res.status(401).json({
      success: false,
      message: "Authentication required.",
    })
  }

  try {
    // Get audio generation history without join since there's no foreign key
    const { data: audios, error: audiosError } = await supabaseAdmin
      .from("generated_audios")
      .select("*")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(50)

    if (audiosError) {
      console.error(`[AUDIO_GEN] Error fetching audio history:`, audiosError)
      return res.status(500).json({
        success: false,
        message: "Failed to fetch audio history",
        error: audiosError.message,
      })
    }

    // Get voice names separately from both tables
    const voiceIds = [...new Set(audios.map((audio) => audio.voice_id).filter(Boolean))]
    let voicesMap = {}

    if (voiceIds.length > 0) {
      // Try voices table first
      const { data: voices, error: voicesError } = await supabaseAdmin
        .from("voices")
        .select("id, name")
        .in("id", voiceIds)

      if (!voicesError && voices) {
        voicesMap = voices.reduce((acc, voice) => {
          acc[voice.id] = voice
          return acc
        }, {})
      }

      // Fill in missing voices from avatars table
      const missingVoiceIds = voiceIds.filter((id) => !voicesMap[id])
      if (missingVoiceIds.length > 0) {
        const { data: avatars, error: avatarsError } = await supabaseAdmin
          .from("avatars")
          .select("id, name")
          .in("id", missingVoiceIds)

        if (!avatarsError && avatars) {
          avatars.forEach((avatar) => {
            voicesMap[avatar.id] = avatar
          })
        }
      }
    }

    // Add voice names to audios
    const audiosWithVoices = audios.map((audio) => ({
      ...audio,
      voices: voicesMap[audio.voice_id] || { name: "Unknown Voice" },
    }))

    res.status(200).json({
      success: true,
      data: {
        audios: audiosWithVoices || [],
        total: audiosWithVoices?.length || 0,
      },
    })
  } catch (error) {
    console.error(`[AUDIO_GEN] Get audio history error:`, error)
    res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message,
    })
  }
}

/**
 * Delete generated audio
 */
export const deleteAudio = async (req, res) => {
  const { audioId } = req.params
  const userId = req.user?.id

  if (!userId) {
    return res.status(401).json({
      success: false,
      message: "Authentication required.",
    })
  }

  if (!audioId) {
    return res.status(400).json({
      success: false,
      message: "Audio ID is required.",
    })
  }

  try {
    // Get the audio record to check ownership and get file URL
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
      })
    }

    // Delete the audio file from storage if it exists
    if (audio.audio_url && audio.audio_url.trim() !== "") {
      try {
        const urlParts = audio.audio_url.split("/avatar-media/")
        if (urlParts.length > 1) {
          const filePath = urlParts[1]
          await supabaseAdmin.storage.from("avatar-media").remove([filePath])
          console.log(`[AUDIO_DELETE] Deleted audio file: ${filePath}`)
        }
      } catch (storageError) {
        console.warn("[AUDIO_DELETE] Failed to delete audio file from storage:", storageError)
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
      error: error.message,
    })
  }
}
