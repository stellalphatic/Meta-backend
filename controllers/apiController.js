import { createClient } from "@supabase/supabase-js"
import crypto from "crypto"

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)

const PLAN_LIMITS = {
  Free: {
    requests_per_minute: 10,
    requests_per_hour: 100,
    requests_per_day: 1000,
    max_api_keys: 1,
  },
  Starter: {
    requests_per_minute: 30,
    requests_per_hour: 500,
    requests_per_day: 5000,
    max_api_keys: 3,
  },
  Growth: {
    requests_per_minute: 100,
    requests_per_hour: 2000,
    requests_per_day: 20000,
    max_api_keys: 10,
  },
  Pro: {
    requests_per_minute: 300,
    requests_per_hour: 10000,
    requests_per_day: 100000,
    max_api_keys: 50,
  },
}

// Generate API key with prefix
function generateApiKey() {
  const randomBytes = crypto.randomBytes(32).toString("hex")
  return `mp_${randomBytes}`
}

// Create new API key
export const createApiKey = async (req, res) => {
  try {
    const { name, allowedEndpoints = ["audio_generation", "video_generation", "avatar_creation"] } = req.body
    const userId = req.user?.id

    if (!userId) {
      return res.status(401).json({ success: false, message: "User not authenticated" })
    }

    if (!name || name.trim().length === 0) {
      return res.status(400).json({ success: false, message: "API key name is required" })
    }

    const { data: profile, error: profileError } = await supabase
      .from("profiles")
      .select("current_plan")
      .eq("id", userId)
      .single()

    if (profileError) {
      console.error("Error fetching user profile:", profileError)
      return res.status(500).json({ success: false, message: "Failed to fetch user profile" })
    }

    const userPlan = profile?.current_plan || "Free"
    const planLimits = PLAN_LIMITS[userPlan] || PLAN_LIMITS.Free

    // Check existing API key count
    const { data: existingKeys, error: countError } = await supabase
      .from("api_keys")
      .select("id")
      .eq("user_id", userId)
      .eq("is_active", true)

    if (countError) {
      console.error("Error counting existing API keys:", countError)
      return res.status(500).json({ success: false, message: "Failed to check existing API keys" })
    }

    if (existingKeys.length >= planLimits.max_api_keys) {
      return res.status(403).json({
        success: false,
        message: `Your ${userPlan} plan allows maximum ${planLimits.max_api_keys} API keys. Please upgrade your plan or delete existing keys.`,
      })
    }

    // Generate API key
    const apiKey = generateApiKey()
    const keyHash = crypto.createHash("sha256").update(apiKey).digest("hex")
    const keyPrefix = apiKey.substring(0, 12)

    const { data, error } = await supabase
      .from("api_keys")
      .insert({
        user_id: userId,
        name: name.trim(),
        key_hash: keyHash,
        prefix: keyPrefix,
        allowed_endpoints: allowedEndpoints,
        is_active: true,
        created_at: new Date().toISOString(),
        last_used_at: null,
        expires_at: null,
      })
      .select()
      .single()

    if (error) {
      console.error("Database error creating API key:", error)
      return res.status(500).json({ success: false, message: "Failed to create API key" })
    }

    res.status(201).json({
      success: true,
      message: "API key created successfully",
      data: {
        id: data.id,
        name: data.name,
        key: apiKey, // Only returned once during creation
        prefix: data.prefix,
        allowed_endpoints: data.allowed_endpoints,
        is_active: data.is_active,
        created_at: data.created_at,
        rate_limits: {
          per_minute: planLimits.requests_per_minute,
          per_hour: planLimits.requests_per_hour,
          per_day: planLimits.requests_per_day,
        },
      },
    })
  } catch (error) {
    console.error("Error creating API key:", error)
    res.status(500).json({ success: false, message: "Internal server error" })
  }
}

// Get user's API keys
export const getUserApiKeys = async (req, res) => {
  try {
    const userId = req.user?.id

    if (!userId) {
      return res.status(401).json({ success: false, message: "User not authenticated" })
    }

    const { data, error } = await supabase
      .from("api_keys")
      .select("id, name, prefix, allowed_endpoints, is_active, created_at, last_used_at, expires_at")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })

    if (error) {
      console.error("Database error fetching API keys:", error)
      return res.status(500).json({ success: false, message: "Failed to fetch API keys" })
    }

    const { data: profile } = await supabase.from("profiles").select("current_plan").eq("id", userId).single()

    const userPlan = profile?.current_plan || "Free"
    const planLimits = PLAN_LIMITS[userPlan] || PLAN_LIMITS.Free

    const keysWithLimits = (data || []).map((key) => ({
      ...key,
      rate_limit_per_minute: planLimits.requests_per_minute,
      rate_limit_per_hour: planLimits.requests_per_hour,
      rate_limit_per_day: planLimits.requests_per_day,
    }))

    res.json({ success: true, data: keysWithLimits })
  } catch (error) {
    console.error("Error fetching API keys:", error)
    res.status(500).json({ success: false, message: "Internal server error" })
  }
}

export const revokeApiKey = async (req, res) => {
  try {
    const { keyId } = req.params
    const userId = req.user?.id

    if (!userId) {
      return res.status(401).json({ success: false, message: "User not authenticated" })
    }

    const { error } = await supabase.from("api_keys").update({ is_active: false }).eq("id", keyId).eq("user_id", userId)

    if (error) {
      console.error("Database error revoking API key:", error)
      return res.status(500).json({ success: false, message: "Failed to revoke API key" })
    }

    res.json({ success: true, message: "API key revoked successfully" })
  } catch (error) {
    console.error("Error revoking API key:", error)
    res.status(500).json({ success: false, message: "Internal server error" })
  }
}

// Delete API key
export const deleteApiKey = async (req, res) => {
  try {
    const { keyId } = req.params
    const userId = req.user?.id

    if (!userId) {
      return res.status(401).json({ success: false, message: "User not authenticated" })
    }

    // Verify ownership and delete
    const { error } = await supabase.from("api_keys").delete().eq("id", keyId).eq("user_id", userId)

    if (error) {
      console.error("Database error deleting API key:", error)
      return res.status(500).json({ success: false, message: "Failed to delete API key" })
    }

    res.json({ success: true, message: "API key deleted successfully" })
  } catch (error) {
    console.error("Error deleting API key:", error)
    res.status(500).json({ success: false, message: "Internal server error" })
  }
}

// Toggle API key status
export const toggleApiKeyStatus = async (req, res) => {
  try {
    const { keyId } = req.params
    const { is_active } = req.body
    const userId = req.user?.id

    if (!userId) {
      return res.status(401).json({ success: false, message: "User not authenticated" })
    }

    const { data, error } = await supabase
      .from("api_keys")
      .update({ is_active })
      .eq("id", keyId)
      .eq("user_id", userId)
      .select()
      .single()

    if (error) {
      console.error("Database error updating API key:", error)
      return res.status(500).json({ success: false, message: "Failed to update API key" })
    }

    res.json({
      success: true,
      message: `API key ${is_active ? "activated" : "deactivated"} successfully`,
      data: data,
    })
  } catch (error) {
    console.error("Error updating API key:", error)
    res.status(500).json({ success: false, message: "Internal server error" })
  }
}

export const getApiUsageStats = async (req, res) => {
  try {
    const userId = req.user?.id

    if (!userId) {
      return res.status(401).json({ success: false, message: "User not authenticated" })
    }

    // Get user profile with plan info
    const { data: profile, error: profileError } = await supabase
      .from("profiles")
      .select("current_plan")
      .eq("id", userId)
      .single()

    if (profileError) {
      console.error("Error fetching profile:", profileError)
      return res.status(500).json({ success: false, message: "Failed to fetch usage data" })
    }

    // Get API usage from last 30 days
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
    const { data: apiUsage, error: usageError } = await supabase
      .from("api_usage")
      .select("*")
      .eq("user_id", userId)
      .gte("created_at", thirtyDaysAgo)
      .order("created_at", { ascending: true })

    if (usageError) {
      console.error("Error fetching API usage:", usageError)
      return res.status(500).json({ success: false, message: "Failed to fetch usage statistics" })
    }

    const userPlan = profile?.current_plan || "Free"
    const planLimits = PLAN_LIMITS[userPlan] || PLAN_LIMITS.Free

    // Calculate current month usage
    const currentMonth = new Date().getMonth()
    const currentYear = new Date().getFullYear()
    const currentMonthUsage = (apiUsage || []).filter((usage) => {
      const usageDate = new Date(usage.created_at)
      return usageDate.getMonth() === currentMonth && usageDate.getFullYear() === currentYear
    })

    const totalApiCalls = currentMonthUsage.length
    const apiCallsPercentage =
      planLimits.requests_per_day > 0 ? Math.min(100, (totalApiCalls / (planLimits.requests_per_day * 30)) * 100) : 0

    res.json({
      success: true,
      data: {
        currentPlan: userPlan,
        apiCalls: {
          used: totalApiCalls,
          limit: planLimits.requests_per_day * 30, // Monthly limit
          remaining: Math.max(0, planLimits.requests_per_day * 30 - totalApiCalls),
          percentage: apiCallsPercentage,
        },
        rateLimits: {
          per_minute: planLimits.requests_per_minute,
          per_hour: planLimits.requests_per_hour,
          per_day: planLimits.requests_per_day,
        },
      },
    })
  } catch (error) {
    console.error("Error fetching API usage stats:", error)
    res.status(500).json({ success: false, message: "Internal server error" })
  }
}

export const getApiUsageAnalytics = async (req, res) => {
  try {
    const userId = req.user?.id

    if (!userId) {
      return res.status(401).json({ success: false, message: "User not authenticated" })
    }

    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
    const { data: apiUsage, error: usageError } = await supabase
      .from("api_usage")
      .select("*")
      .eq("user_id", userId)
      .gte("created_at", thirtyDaysAgo)
      .order("created_at", { ascending: true })

    if (usageError) {
      console.error("Error fetching API usage analytics:", usageError)
      return res.status(500).json({ success: false, message: "Failed to fetch analytics" })
    }

    // Process daily usage
    const dailyUsage = {}
    const endpointUsage = { audio_generation: 0, video_generation: 0, avatar_creation: 0 }
    ;(apiUsage || []).forEach((record) => {
      const date = new Date(record.created_at).toLocaleDateString()
      if (!dailyUsage[date]) {
        dailyUsage[date] = { date, audio: 0, video: 0, avatar: 0, total: 0 }
      }

      const amount = Number.parseFloat(record.usage_amount) || 1
      const endpointType = record.endpoint_type || "audio_generation"
      const category = endpointType.split("_")[0]

      dailyUsage[date][category] += amount
      dailyUsage[date].total += amount
      endpointUsage[endpointType] += amount
    })

    const processedData = {
      daily: Object.values(dailyUsage),
      endpoints: Object.entries(endpointUsage).map(([key, value]) => ({
        name: key.replace("_", " ").replace(/\b\w/g, (l) => l.toUpperCase()),
        value: value,
      })),
    }

    res.json({ success: true, data: processedData })
  } catch (error) {
    console.error("Error fetching API usage analytics:", error)
    res.status(500).json({ success: false, message: "Internal server error" })
  }
}
