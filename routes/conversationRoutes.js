import express from "express"
import { authenticateJWT, rateLimit } from "../middleware/authMiddleware.js"
import { supabaseAdmin } from "../services/supabase.js"

const router = express.Router()

// Apply authentication to all routes
router.use(authenticateJWT)

// Apply rate limiting
router.use(rateLimit(100, 15 * 60 * 1000)) // 100 requests per 15 minutes

// Get all conversations for a user
router.get("/", async (req, res) => {
  try {
    const userId = req.user.id
    const { status, type, limit = 50, offset = 0 } = req.query

    let query = supabaseAdmin
      .from("conversations")
      .select(`
       *,
       avatars (
         id,
         name,
         image_url
       )
     `)
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1)

    if (status) {
      query = query.eq("status", status)
    }

    if (type === "voice") {
      query = query.eq("audio_only", true)
    } else if (type === "video") {
      query = query.eq("audio_only", false)
    }

    const { data: conversations, error } = await query

    if (error) {
      throw error
    }

    res.json({
      success: true,
      conversations: conversations || [],
      total: conversations?.length || 0,
    })
  } catch (error) {
    console.error("Error fetching conversations:", error)
    res.status(500).json({
      success: false,
      message: "Failed to fetch conversations",
      error: error.message,
    })
  }
})

// Get a specific conversation
router.get("/:id", async (req, res) => {
  try {
    const userId = req.user.id
    const conversationId = req.params.id

    const { data: conversation, error } = await supabaseAdmin
      .from("conversations")
      .select(`
       *,
       avatars (
         id,
         name,
         image_url
       ),
       chat_history (
         id,
         chat_messages,
         summary,
         started_at,
         ended_at
       )
     `)
      .eq("id", conversationId)
      .eq("user_id", userId)
      .single()

    if (error) {
      if (error.code === "PGRST116") {
        return res.status(404).json({
          success: false,
          message: "Conversation not found",
          code: "CONVERSATION_NOT_FOUND",
        })
      }
      throw error
    }

    res.json({
      success: true,
      data: conversation,
    })
  } catch (error) {
    console.error("Error fetching conversation:", error)
    res.status(500).json({
      success: false,
      message: "Failed to fetch conversation",
      error: error.message,
    })
  }
})

// End an active conversation
router.patch("/:id/end", async (req, res) => {
  try {
    const userId = req.user.id
    const conversationId = req.params.id

    // First check if conversation exists and belongs to user
    const { data: conversation, error: fetchError } = await supabaseAdmin
      .from("conversations")
      .select("id, status, user_id")
      .eq("id", conversationId)
      .eq("user_id", userId)
      .single()

    if (fetchError) {
      if (fetchError.code === "PGRST116") {
        return res.status(404).json({
          success: false,
          message: "Conversation not found",
          code: "CONVERSATION_NOT_FOUND",
        })
      }
      throw fetchError
    }

    if (conversation.status !== "active") {
      return res.status(400).json({
        success: false,
        message: "Conversation is not active",
        code: "CONVERSATION_NOT_ACTIVE",
      })
    }

    // Update conversation status
    const { error: updateError } = await supabaseAdmin
      .from("conversations")
      .update({
        status: "ended",
        updated_at: new Date().toISOString(),
      })
      .eq("id", conversationId)

    if (updateError) {
      throw updateError
    }

    res.json({
      success: true,
      message: "Conversation ended successfully",
    })
  } catch (error) {
    console.error("Error ending conversation:", error)
    res.status(500).json({
      success: false,
      message: "Failed to end conversation",
      error: error.message,
    })
  }
})

// Delete a conversation
router.delete("/:id", async (req, res) => {
  try {
    const userId = req.user.id
    const conversationId = req.params.id

    // First check if conversation exists and belongs to user
    const { data: conversation, error: fetchError } = await supabaseAdmin
      .from("conversations")
      .select("id, user_id")
      .eq("id", conversationId)
      .eq("user_id", userId)
      .single()

    if (fetchError) {
      if (fetchError.code === "PGRST116") {
        return res.status(404).json({
          success: false,
          message: "Conversation not found",
          code: "CONVERSATION_NOT_FOUND",
        })
      }
      throw fetchError
    }

    // Delete related chat history first
    await supabaseAdmin.from("chat_history").delete().eq("conversation_id", conversationId)

    // Delete conversation
    const { error: deleteError } = await supabaseAdmin.from("conversations").delete().eq("id", conversationId)

    if (deleteError) {
      throw deleteError
    }

    res.json({
      success: true,
      message: "Conversation deleted successfully",
    })
  } catch (error) {
    console.error("Error deleting conversation:", error)
    res.status(500).json({
      success: false,
      message: "Failed to delete conversation",
      error: error.message,
    })
  }
})

// Get conversation statistics
router.get("/stats/summary", async (req, res) => {
  try {
    const userId = req.user.id

    const { data: stats, error } = await supabaseAdmin
      .from("conversations")
      .select("status, audio_only")
      .eq("user_id", userId)

    if (error) {
      throw error
    }

    const summary = {
      total: stats.length,
      active: stats.filter((c) => c.status === "active").length,
      ended: stats.filter((c) => c.status === "ended").length,
      failed: stats.filter((c) => c.status === "failed").length,
      voice: stats.filter((c) => c.audio_only === true).length,
      video: stats.filter((c) => c.audio_only === false).length,
    }

    res.json({
      success: true,
      data: summary,
    })
  } catch (error) {
    console.error("Error fetching conversation stats:", error)
    res.status(500).json({
      success: false,
      message: "Failed to fetch conversation statistics",
      error: error.message,
    })
  }
})

export default router
