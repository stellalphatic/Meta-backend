import { supabaseAdmin } from "../services/supabase.js"

/**
 * Middleware to check video generation limits
 */
export const checkVideoLimit = async (req, res, next) => {
  const userId = req.user?.id

  if (!userId) {
    return res.status(401).json({
      message: "Authentication required.",
    })
  }

  try {
    // Get user's profile to check limits and current usage
    const { data: profile, error: profileError } = await supabaseAdmin
      .from("profiles")
      .select(
        "current_plan, video_generation_minutes_monthly_limit, video_generation_minutes_this_month, last_billing_date",
      )
      .eq("id", userId)
      .single()

    if (profileError || !profile) {
      console.error("Error fetching user profile:", profileError)
      return res.status(500).json({
        message: "Error checking usage limits.",
      })
    }

    const monthlyLimit = profile.video_generation_minutes_monthly_limit || 0
    const currentUsage = profile.video_generation_minutes_this_month || 0

    // Estimate duration for current request (rough estimate: 0.1 minutes per 100 characters)
    const textLength = req.body.text?.length || 0
    const estimatedDuration = Math.max(textLength * 0.001, 0.5) // Minimum 0.5 minutes

    // Check if user would exceed limit
    const wouldExceedLimit = currentUsage + estimatedDuration > monthlyLimit

    // Add usage info to request for controller
    req.usageInfo = {
      currentUsage: currentUsage,
      monthlyLimit: monthlyLimit,
      estimatedDuration: estimatedDuration,
      remainingMinutes: Math.max(0, monthlyLimit - currentUsage),
      currentPlan: profile.current_plan,
    }

    req.isWithinLimit = !wouldExceedLimit

    if (wouldExceedLimit) {
      return res.status(403).json({
        message: `Video generation would exceed your monthly limit of ${monthlyLimit} minutes. Current usage: ${currentUsage.toFixed(1)} minutes.`,
        usageInfo: req.usageInfo,
      })
    }

    next()
  } catch (error) {
    console.error("Error in checkVideoLimit middleware:", error)
    res.status(500).json({
      message: "Error checking usage limits.",
      error: error.message,
    })
  }
}

/**
 * Middleware to check audio generation limits
 */
export const checkAudioLimit = async (req, res, next) => {
  const userId = req.user?.id

  if (!userId) {
    return res.status(401).json({
      message: "Authentication required.",
    })
  }

  try {
    // Get user's profile to check limits and current usage
    const { data: profile, error: profileError } = await supabaseAdmin
      .from("profiles")
      .select("current_plan, audio_generation_monthly_limit, audio_generation_this_month")
      .eq("id", userId)
      .single()

    if (profileError || !profile) {
      console.error("Error fetching user profile:", profileError)
      return res.status(500).json({
        message: "Error checking usage limits.",
      })
    }

    const monthlyLimit = profile.audio_generation_monthly_limit || 0
    const currentUsage = profile.audio_generation_this_month || 0

    // Check if user would exceed limit
    const wouldExceedLimit = currentUsage + 1 > monthlyLimit

    // Add usage info to request for controller
    req.audioUsageInfo = {
      currentUsage: currentUsage,
      monthlyLimit: monthlyLimit,
      remainingGenerations: Math.max(0, monthlyLimit - currentUsage),
      currentPlan: profile.current_plan,
    }

    req.isWithinAudioLimit = !wouldExceedLimit

    if (wouldExceedLimit) {
      return res.status(403).json({
        message: `Audio generation would exceed your monthly limit of ${monthlyLimit} generations. Current usage: ${currentUsage} generations.`,
        usageInfo: req.audioUsageInfo,
      })
    }

    next()
  } catch (error) {
    console.error("Error in checkAudioLimit middleware:", error)
    res.status(500).json({
      message: "Error checking usage limits.",
      error: error.message,
    })
  }
}

/**
 * Middleware to check conversation limits (for voice/video chat)
 */
export const checkConversationLimit = async (req, res, next) => {
  const userId = req.user?.id

  if (!userId) {
    return res.status(401).json({
      message: "Authentication required.",
    })
  }

  try {
    // Get user's profile to check limits and current usage
    const { data: profile, error: profileError } = await supabaseAdmin
      .from("profiles")
      .select("current_plan, conversation_minutes_monthly_limit, conversation_minutes_this_month")
      .eq("id", userId)
      .single()

    if (profileError || !profile) {
      console.error("Error fetching user profile:", profileError)
      return res.status(500).json({
        message: "Error checking usage limits.",
      })
    }

    const monthlyLimit = profile.conversation_minutes_monthly_limit || 0
    const currentUsage = profile.conversation_minutes_this_month || 0

    // Check if user would exceed limit (allow some buffer for current session)
    const wouldExceedLimit = currentUsage >= monthlyLimit

    // Add usage info to request
    req.conversationUsageInfo = {
      currentUsage: currentUsage,
      monthlyLimit: monthlyLimit,
      remainingMinutes: Math.max(0, monthlyLimit - currentUsage),
      currentPlan: profile.current_plan,
    }

    req.isWithinConversationLimit = !wouldExceedLimit

    if (wouldExceedLimit) {
      return res.status(403).json({
        message: `You have exceeded your monthly conversation limit of ${monthlyLimit} minutes. Current usage: ${currentUsage.toFixed(1)} minutes.`,
        usageInfo: req.conversationUsageInfo,
      })
    }

    next()
  } catch (error) {
    console.error("Error in checkConversationLimit middleware:", error)
    res.status(500).json({
      message: "Error checking usage limits.",
      error: error.message,
    })
  }
}

/**
 * Middleware to check avatar creation limits
 */
export const checkAvatarCreationLimit = async (req, res, next) => {
  const userId = req.user?.id

  if (!userId) {
    return res.status(401).json({
      message: "Authentication required.",
    })
  }

  try {
    // Get user's profile to check limits and current usage
    const { data: profile, error: profileError } = await supabaseAdmin
      .from("profiles")
      .select("current_plan, custom_avatar_creations_monthly_limit, custom_avatar_creations_this_month")
      .eq("id", userId)
      .single()

    if (profileError || !profile) {
      console.error("Error fetching user profile:", profileError)
      return res.status(500).json({
        message: "Error checking usage limits.",
      })
    }

    const monthlyLimit = profile.custom_avatar_creations_monthly_limit || 0
    const currentUsage = profile.custom_avatar_creations_this_month || 0

    // Check if user would exceed limit
    const wouldExceedLimit = currentUsage + 1 > monthlyLimit

    // Add usage info to request
    req.avatarCreationUsageInfo = {
      currentUsage: currentUsage,
      monthlyLimit: monthlyLimit,
      remainingCreations: Math.max(0, monthlyLimit - currentUsage),
      currentPlan: profile.current_plan,
    }

    req.isWithinAvatarCreationLimit = !wouldExceedLimit

    if (wouldExceedLimit) {
      return res.status(403).json({
        message: `You have exceeded your monthly avatar creation limit of ${monthlyLimit} avatars. Current usage: ${currentUsage} avatars.`,
        usageInfo: req.avatarCreationUsageInfo,
      })
    }

    next()
  } catch (error) {
    console.error("Error in checkAvatarCreationLimit middleware:", error)
    res.status(500).json({
      message: "Error checking usage limits.",
      error: error.message,
    })
  }
}

/**
 * Update video generation usage after successful generation
 */
export const updateVideoUsage = async (userId, durationMinutes) => {
  try {
    // Get current usage first
    const { data: profile, error: fetchError } = await supabaseAdmin
      .from("profiles")
      .select("video_generation_minutes_this_month")
      .eq("id", userId)
      .single()

    if (fetchError) {
      console.error("Error fetching current video usage:", fetchError)
      return
    }

    const currentUsage = profile.video_generation_minutes_this_month || 0
    const newUsage = currentUsage + durationMinutes

    const { error } = await supabaseAdmin
      .from("profiles")
      .update({
        video_generation_minutes_this_month: newUsage,
        updated_at: new Date().toISOString(),
      })
      .eq("id", userId)

    if (error) {
      console.error("Error updating video usage:", error)
    } else {
      console.log(`Updated video usage for user ${userId}: +${durationMinutes} minutes (total: ${newUsage})`)
    }
  } catch (error) {
    console.error("Error in updateVideoUsage:", error)
  }
}

/**
 * Update conversation usage after chat session
 */
export const updateConversationUsage = async (userId, durationMinutes) => {
  try {
    // Get current usage first
    const { data: profile, error: fetchError } = await supabaseAdmin
      .from("profiles")
      .select("conversation_minutes_this_month")
      .eq("id", userId)
      .single()

    if (fetchError) {
      console.error("Error fetching current conversation usage:", fetchError)
      return
    }

    const currentUsage = profile.conversation_minutes_this_month || 0
    const newUsage = currentUsage + durationMinutes

    const { error } = await supabaseAdmin
      .from("profiles")
      .update({
        conversation_minutes_this_month: newUsage,
        updated_at: new Date().toISOString(),
      })
      .eq("id", userId)

    if (error) {
      console.error("Error updating conversation usage:", error)
    } else {
      console.log(`Updated conversation usage for user ${userId}: +${durationMinutes} minutes (total: ${newUsage})`)
    }
  } catch (error) {
    console.error("Error in updateConversationUsage:", error)
  }
}

/**
 * Update avatar creation usage after successful creation
 */
export const updateAvatarCreationUsage = async (userId) => {
  try {
    // Get current usage first
    const { data: profile, error: fetchError } = await supabaseAdmin
      .from("profiles")
      .select("custom_avatar_creations_this_month")
      .eq("id", userId)
      .single()

    if (fetchError) {
      console.error("Error fetching current avatar creation usage:", fetchError)
      return
    }

    const currentUsage = profile.custom_avatar_creations_this_month || 0
    const newUsage = currentUsage + 1

    const { error } = await supabaseAdmin
      .from("profiles")
      .update({
        custom_avatar_creations_this_month: newUsage,
        updated_at: new Date().toISOString(),
      })
      .eq("id", userId)

    if (error) {
      console.error("Error updating avatar creation usage:", error)
    } else {
      console.log(`Updated avatar creation usage for user ${userId}: +1 avatar (total: ${newUsage})`)
    }
  } catch (error) {
    console.error("Error in updateAvatarCreationUsage:", error)
  }
}

/**
 * Get usage statistics for a user
 */
export const getUserUsageStats = async (req, res) => {
  const userId = req.user?.id

  if (!userId) {
    return res.status(401).json({
      success: false,
      message: "Authentication required.",
    })
  }

  try {
    // Get user's profile with all usage data
    const { data: profile, error: profileError } = await supabaseAdmin
      .from("profiles")
      .select(`
        current_plan,
        conversation_minutes_monthly_limit,
        conversation_minutes_this_month,
        video_generation_minutes_monthly_limit,
        video_generation_minutes_this_month,
        custom_avatar_creations_monthly_limit,
        custom_avatar_creations_this_month,
        audio_generation_monthly_limit,
        audio_generation_this_month,
        last_billing_date
      `)
      .eq("id", userId)
      .single()

    if (profileError || !profile) {
      throw new Error("Error fetching user profile")
    }

    // Calculate percentages and remaining usage
    const videoUsed = profile.video_generation_minutes_this_month || 0
    const videoLimit = profile.video_generation_minutes_monthly_limit || 0
    const videoPercentage = videoLimit > 0 ? Math.min(100, (videoUsed / videoLimit) * 100) : 0

    const conversationUsed = profile.conversation_minutes_this_month || 0
    const conversationLimit = profile.conversation_minutes_monthly_limit || 0
    const conversationPercentage =
      conversationLimit > 0 ? Math.min(100, (conversationUsed / conversationLimit) * 100) : 0

    const avatarUsed = profile.custom_avatar_creations_this_month || 0
    const avatarLimit = profile.custom_avatar_creations_monthly_limit || 0
    const avatarPercentage = avatarLimit > 0 ? Math.min(100, (avatarUsed / avatarLimit) * 100) : 0

    const audioUsed = profile.audio_generation_this_month || 0
    const audioLimit = profile.audio_generation_monthly_limit || 0
    const audioPercentage = audioLimit > 0 ? Math.min(100, (audioUsed / audioLimit) * 100) : 0

    res.status(200).json({
      success: true,
      data: {
        currentPlan: profile.current_plan,
        videoGeneration: {
          used: videoUsed,
          limit: videoLimit,
          remaining: Math.max(0, videoLimit - videoUsed),
          percentage: videoPercentage,
        },
        conversation: {
          used: conversationUsed,
          limit: conversationLimit,
          remaining: Math.max(0, conversationLimit - conversationUsed),
          percentage: conversationPercentage,
        },
        avatarCreation: {
          used: avatarUsed,
          limit: avatarLimit,
          remaining: Math.max(0, avatarLimit - avatarUsed),
          percentage: avatarPercentage,
        },
        audioGeneration: {
          used: audioUsed,
          limit: audioLimit,
          remaining: Math.max(0, audioLimit - audioUsed),
          percentage: audioPercentage,
        },
        billingPeriod: {
          lastBillingDate: profile.last_billing_date,
          nextBillingDate: getNextBillingDate(profile.last_billing_date),
        },
      },
    })
  } catch (error) {
    console.error("Error getting usage stats:", error)
    res.status(500).json({
      success: false,
      message: "Error fetching usage statistics.",
      error: error.message,
    })
  }
}

/**
 * Calculate next billing date (monthly)
 */
function getNextBillingDate(lastBillingDate) {
  if (!lastBillingDate) return null

  const lastDate = new Date(lastBillingDate)
  const nextDate = new Date(lastDate)
  nextDate.setMonth(nextDate.getMonth() + 1)

  return nextDate.toISOString()
}

/**
 * API endpoint to update conversation usage
 */
export const updateConversationUsageAPI = async (req, res) => {
  const { durationMinutes } = req.body
  const userId = req.user?.id

  if (!userId) {
    return res.status(401).json({
      success: false,
      message: "Authentication required.",
    })
  }

  if (!durationMinutes || durationMinutes <= 0) {
    return res.status(400).json({
      success: false,
      message: "Invalid duration provided.",
    })
  }

  try {
    await updateConversationUsage(userId, durationMinutes)

    res.status(200).json({
      success: true,
      message: "Conversation usage updated successfully.",
      durationMinutes: durationMinutes,
    })
  } catch (error) {
    console.error("Error updating conversation usage:", error)
    res.status(500).json({
      success: false,
      message: "Failed to update conversation usage.",
      error: error.message,
    })
  }
}

/**
 * API endpoint to update avatar creation usage
 */
export const updateAvatarCreationUsageAPI = async (req, res) => {
  const { increment = 1 } = req.body
  const userId = req.user?.id

  if (!userId) {
    return res.status(401).json({
      success: false,
      message: "Authentication required.",
    })
  }

  try {
    for (let i = 0; i < increment; i++) {
      await updateAvatarCreationUsage(userId)
    }

    res.status(200).json({
      success: true,
      message: "Avatar creation usage updated successfully.",
      increment: increment,
    })
  } catch (error) {
    console.error("Error updating avatar creation usage:", error)
    res.status(500).json({
      success: false,
      message: "Failed to update avatar creation usage.",
      error: error.message,
    })
  }
}
