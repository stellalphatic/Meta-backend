import { supabaseAdmin } from "../services/supabase.js"

/**
 * Get all avatars for authenticated user
 */
export const getUserAvatars = async (req, res) => {
  try {
    const userId = req.user.id

    const { data: avatars, error } = await supabaseAdmin
      .from("avatars")
      .select("*")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })

    if (error) {
      console.error("Error fetching user avatars:", error)
      return res.status(500).json({
        success: false,
        message: "Failed to fetch avatars",
        error: error.message,
      })
    }

    res.json({
      success: true,
      data: avatars || [],
      count: avatars?.length || 0,
    })
  } catch (error) {
    console.error("Get user avatars error:", error)
    res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message,
    })
  }
}

/**
 * Get single avatar by ID
 */
export const getAvatarById = async (req, res) => {
  try {
    const { id } = req.params
    const userId = req.user.id

    const { data: avatar, error } = await supabaseAdmin
      .from("avatars")
      .select("*")
      .eq("id", id)
      .eq("user_id", userId)
      .single()

    if (error) {
      if (error.code === "PGRST116") {
        return res.status(404).json({
          success: false,
          message: "Avatar not found",
          code: "AVATAR_NOT_FOUND",
        })
      }
      throw error
    }

    res.json({
      success: true,
      data: avatar,
    })
  } catch (error) {
    console.error("Get avatar by ID error:", error)
    res.status(500).json({
      success: false,
      message: "Failed to fetch avatar",
      error: error.message,
    })
  }
}

/**
 * Create new avatar
 */
export const createAvatar = async (req, res) => {
  try {
    const userId = req.user.id
    const { name, image_url, voice_url, system_prompt, persona_role, conversational_context } = req.body

    // Validation
    if (!name || !name.trim()) {
      return res.status(400).json({
        success: false,
        message: "Avatar name is required",
        code: "NAME_REQUIRED",
      })
    }

    if (!image_url || !image_url.trim()) {
      return res.status(400).json({
        success: false,
        message: "Avatar image URL is required",
        code: "IMAGE_URL_REQUIRED",
      })
    }

    const { data: avatar, error } = await supabaseAdmin
      .from("avatars")
      .insert({
        user_id: userId,
        name: name.trim(),
        image_url: image_url.trim(),
        voice_url: voice_url?.trim() || null,
        system_prompt: system_prompt?.trim() || null,
        persona_role: persona_role?.trim() || null,
        conversational_context: conversational_context?.trim() || null,
      })
      .select()
      .single()

    if (error) {
      console.error("Error creating avatar:", error)
      return res.status(500).json({
        success: false,
        message: "Failed to create avatar",
        error: error.message,
      })
    }

    res.status(201).json({
      success: true,
      message: "Avatar created successfully",
      data: avatar,
    })
  } catch (error) {
    console.error("Create avatar error:", error)
    res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message,
    })
  }
}

/**
 * Update avatar
 */
export const updateAvatar = async (req, res) => {
  try {
    const { id } = req.params
    const userId = req.user.id
    const { name, image_url, voice_url, system_prompt, persona_role, conversational_context } = req.body

    // Check if avatar exists and belongs to user
    const { data: existingAvatar, error: fetchError } = await supabaseAdmin
      .from("avatars")
      .select("id")
      .eq("id", id)
      .eq("user_id", userId)
      .single()

    if (fetchError) {
      if (fetchError.code === "PGRST116") {
        return res.status(404).json({
          success: false,
          message: "Avatar not found",
          code: "AVATAR_NOT_FOUND",
        })
      }
      throw fetchError
    }

    // Prepare update data
    const updateData = {
      updated_at: new Date().toISOString(),
    }

    if (name !== undefined) updateData.name = name?.trim() || null
    if (image_url !== undefined) updateData.image_url = image_url?.trim() || null
    if (voice_url !== undefined) updateData.voice_url = voice_url?.trim() || null
    if (system_prompt !== undefined) updateData.system_prompt = system_prompt?.trim() || null
    if (persona_role !== undefined) updateData.persona_role = persona_role?.trim() || null
    if (conversational_context !== undefined) updateData.conversational_context = conversational_context?.trim() || null

    const { data: avatar, error } = await supabaseAdmin
      .from("avatars")
      .update(updateData)
      .eq("id", id)
      .select()
      .single()

    if (error) {
      console.error("Error updating avatar:", error)
      return res.status(500).json({
        success: false,
        message: "Failed to update avatar",
        error: error.message,
      })
    }

    res.json({
      success: true,
      message: "Avatar updated successfully",
      data: avatar,
    })
  } catch (error) {
    console.error("Update avatar error:", error)
    res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message,
    })
  }
}

/**
 * Delete avatar
 */
export const deleteAvatar = async (req, res) => {
  try {
    const { id } = req.params
    const userId = req.user.id

    // Check if avatar exists and belongs to user
    const { data: existingAvatar, error: fetchError } = await supabaseAdmin
      .from("avatars")
      .select("id, name")
      .eq("id", id)
      .eq("user_id", userId)
      .single()

    if (fetchError) {
      if (fetchError.code === "PGRST116") {
        return res.status(404).json({
          success: false,
          message: "Avatar not found",
          code: "AVATAR_NOT_FOUND",
        })
      }
      throw fetchError
    }

    // Delete related records first (conversations, chat history, etc.)
    await supabaseAdmin.from("conversations").delete().eq("avatar_id", id)
    await supabaseAdmin.from("chat_history").delete().eq("avatar_id", id)
    await supabaseAdmin.from("video_generation_history").delete().eq("avatar_id", id)

    // Delete the avatar
    const { error: deleteError } = await supabaseAdmin.from("avatars").delete().eq("id", id)

    if (deleteError) {
      console.error("Error deleting avatar:", deleteError)
      return res.status(500).json({
        success: false,
        message: "Failed to delete avatar",
        error: deleteError.message,
      })
    }

    res.json({
      success: true,
      message: `Avatar "${existingAvatar.name}" deleted successfully`,
    })
  } catch (error) {
    console.error("Delete avatar error:", error)
    res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message,
    })
  }
}
