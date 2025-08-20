import { createClient } from "@supabase/supabase-js"
import crypto from "crypto"

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)

// API Key Authentication Middleware
export const authenticateApiKey = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({
        error: "Missing or invalid authorization header. Use: Authorization: Bearer your_api_key",
      })
    }

    const apiKey = authHeader.substring(7) // Remove 'Bearer ' prefix

    if (!apiKey.startsWith("mp_")) {
      return res.status(401).json({
        error: "Invalid API key format",
      })
    }

    // Hash the provided API key
    const keyHash = crypto.createHash("sha256").update(apiKey).digest("hex")

    // Find the API key in database
    const { data: apiKeyData, error } = await supabase
      .from("api_keys")
      .select(`
        *,
        profiles!inner(*)
      `)
      .eq("key_hash", keyHash)
      .eq("is_active", true)
      .single()

    if (error || !apiKeyData) {
      return res.status(401).json({
        error: "Invalid or inactive API key",
      })
    }

    // Check if API key has expired
    if (apiKeyData.expires_at && new Date(apiKeyData.expires_at) < new Date()) {
      return res.status(401).json({
        error: "API key has expired",
      })
    }

    // Update last_used_at timestamp
    await supabase.from("api_keys").update({ last_used_at: new Date().toISOString() }).eq("id", apiKeyData.id)

    // Attach API key and user data to request
    req.apiKey = apiKeyData
    req.user = apiKeyData.profiles
    req.userId = apiKeyData.user_id

    next()
  } catch (error) {
    console.error("API Key authentication error:", error)
    res.status(500).json({
      error: "Internal server error during authentication",
    })
  }
}

// Endpoint Permission Middleware
export const requireEndpoint = (endpointType) => {
  return (req, res, next) => {
    if (!req.apiKey.allowed_endpoints.includes(endpointType)) {
      return res.status(403).json({
        error: `API key does not have permission for ${endpointType} endpoint`,
      })
    }
    next()
  }
}
