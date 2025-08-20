import { createClient } from "@supabase/supabase-js"

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)

// Rate limiting for API keys
export const apiRateLimit = (windowMs = 60000) => {
  // Default 1 minute window
  return async (req, res, next) => {
    try {
      const apiKeyId = req.apiKey.id
      const now = new Date()
      const windowStart = new Date(now.getTime() - windowMs)

      // Get current window's request count
      const { data: rateLimitData, error } = await supabase
        .from("api_rate_limits")
        .select("request_count")
        .eq("api_key_id", apiKeyId)
        .eq("endpoint_type", req.route.path.split("/")[1] || "general")
        .gte("window_start", windowStart.toISOString())
        .single()

      const currentCount = rateLimitData?.request_count || 0
      const limit =
        windowMs === 60000
          ? req.apiKey.rate_limit_per_minute
          : windowMs === 3600000
            ? req.apiKey.rate_limit_per_hour
            : req.apiKey.rate_limit_per_day

      if (currentCount >= limit) {
        return res.status(429).json({
          error: "Rate limit exceeded",
          limit: limit,
          window: windowMs / 1000 + " seconds",
          reset_time: new Date(now.getTime() + windowMs).toISOString(),
        })
      }

      // Update or create rate limit record
      const { error: upsertError } = await supabase.from("api_rate_limits").upsert(
        {
          api_key_id: apiKeyId,
          endpoint_type: req.route.path.split("/")[1] || "general",
          window_start: now.toISOString(),
          request_count: currentCount + 1,
        },
        {
          onConflict: "api_key_id,endpoint_type,window_start",
        },
      )

      if (upsertError) {
        console.error("Rate limit update error:", upsertError)
      }

      // Add rate limit headers
      res.set({
        "X-RateLimit-Limit": limit,
        "X-RateLimit-Remaining": Math.max(0, limit - currentCount - 1),
        "X-RateLimit-Reset": new Date(now.getTime() + windowMs).toISOString(),
      })

      next()
    } catch (error) {
      console.error("Rate limiting error:", error)
      next() // Continue on rate limit errors to avoid blocking legitimate requests
    }
  }
}
