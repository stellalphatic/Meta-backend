import { createClient } from "@supabase/supabase-js"

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)

// Usage tracking middleware
export const trackApiUsage = (endpointType) => {
  return async (req, res, next) => {
    const startTime = Date.now()

    // Override res.json to capture response
    const originalJson = res.json
    res.json = function (data) {
      const responseTime = Date.now() - startTime

      // Track usage asynchronously
      trackUsage(req, res, endpointType, responseTime, data)

      return originalJson.call(this, data)
    }

    next()
  }
}

async function trackUsage(req, res, endpointType, responseTime, responseData) {
  try {
    const usageAmount = calculateUsageAmount(endpointType, req.body, responseData)

    // Log API request
    await supabase.from("api_request_logs").insert({
      api_key_id: req.apiKey.id,
      user_id: req.userId,
      endpoint: req.originalUrl,
      method: req.method,
      ip_address: req.ip,
      user_agent: req.get("User-Agent"),
      request_body: req.body,
      response_status: res.statusCode,
      response_time_ms: responseTime,
      error_message: res.statusCode >= 400 ? responseData?.error : null,
    })

    // Track usage if successful
    if (res.statusCode < 400) {
      await supabase.from("api_usage").insert({
        api_key_id: req.apiKey.id,
        user_id: req.userId,
        endpoint_type: endpointType,
        usage_amount: usageAmount,
        success: true,
        response_time_ms: responseTime,
        request_metadata: {
          endpoint: req.originalUrl,
          method: req.method,
        },
      })

      // Update user's monthly usage
      await updateMonthlyUsage(req.userId, endpointType, usageAmount)
    }
  } catch (error) {
    console.error("Usage tracking error:", error)
  }
}

function calculateUsageAmount(endpointType, requestBody, responseData) {
  switch (endpointType) {
    case "audio_generation":
      // Estimate audio duration from text length (rough approximation)
      const textLength = requestBody?.text?.length || 0
      return Math.max(0.1, textLength / 200) // ~200 chars per minute of speech

    case "video_generation":
      // Use duration from request or default to 5 seconds
      return (requestBody?.duration || 5) / 60 // Convert to minutes

    case "avatar_creation":
      return 1 // 1 avatar created

    default:
      return 1
  }
}

async function updateMonthlyUsage(userId, endpointType, amount) {
  const field = `${endpointType}_minutes_this_month`

  if (endpointType === "avatar_creation") {
    // For avatars, use count instead of minutes
    await supabase.rpc("increment_avatar_usage", {
      user_id: userId,
      amount: Math.ceil(amount),
    })
  } else {
    // For audio/video, use minutes
    await supabase.rpc("increment_usage", {
      user_id: userId,
      field_name: field,
      amount: amount,
    })
  }
}
