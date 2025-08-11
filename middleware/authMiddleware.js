import { supabaseAdmin } from "../services/supabase.js"

// Rate limiting store (in production, use Redis)
const rateLimitStore = new Map()

/**
 * Authenticate user using JWT token
 */
export const authenticateUser = async (token) => {
  try {
    if (!token) {
      return null
    }

    // Ensure token is a string and remove 'Bearer ' prefix if present
    const tokenString = String(token)
    const cleanToken = tokenString.replace(/^Bearer\s+/i, "")

    // Verify token with Supabase
    const {
      data: { user },
      error,
    } = await supabaseAdmin.auth.getUser(cleanToken)

    if (error || !user) {
      console.error("Token verification failed:", error?.message)
      return null
    }

    return user
  } catch (error) {
    console.error("Authentication error:", error)
    return null
  }
}

/**
 * Express middleware for JWT authentication
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next function
 */
export const authenticateJWT = (req, res, next) => {
  const authHeader = req.headers.authorization
  const token = authHeader && authHeader.split(" ")[1] // Bearer TOKEN

  if (!token) {
    return res.status(401).json({
      success: false,
      message: "Access token required",
      code: "TOKEN_MISSING",
    })
  }

  authenticateUser(token)
    .then((user) => {
      if (!user) {
        return res.status(401).json({
          success: false,
          message: "Invalid or expired token",
          code: "TOKEN_INVALID",
        })
      }

      req.user = user
      next()
    })
    .catch((error) => {
      console.error("JWT middleware error:", error)
      return res.status(500).json({
        success: false,
        message: "Authentication service error",
        code: "AUTH_SERVICE_ERROR",
      })
    })
}

/**
 * WebSocket authentication helper
 * @param {string} token - JWT token from WebSocket connection
 * @returns {Promise<Object|null>} User object or null
 */
export const authenticateWebSocket = async (token) => {
  try {
    const user = await authenticateUser(token)
    if (!user) {
      throw new Error("Invalid token")
    }
    return user
  } catch (error) {
    console.error("WebSocket authentication failed:", error)
    throw error
  }
}

/**
 * Optional authentication middleware (doesn't fail if no token)
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next function
 */
export const optionalAuth = (req, res, next) => {
  const authHeader = req.headers.authorization
  const token = authHeader && authHeader.split(" ")[1]

  if (!token) {
    req.user = null
    return next()
  }

  authenticateUser(token)
    .then((user) => {
      req.user = user
      next()
    })
    .catch((error) => {
      console.error("Optional auth error:", error)
      req.user = null
      next()
    })
}

/**
 * Admin role check middleware (use after authenticateJWT)
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next function
 */
export const requireAdmin = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({
      success: false,
      message: "Authentication required",
      code: "AUTH_REQUIRED",
    })
  }

  // Check if user has admin role
  if (req.user.user_metadata?.role !== "admin" && req.user.app_metadata?.role !== "admin") {
    return res.status(403).json({
      success: false,
      message: "Admin access required",
      code: "ADMIN_REQUIRED",
    })
  }

  next()
}

/**
 * Rate limiting helper (basic implementation)
 * @param {number} maxRequests - Maximum requests per window
 * @param {number} windowMs - Time window in milliseconds
 * @returns {Function} Express middleware
 */
export const rateLimit = (maxRequests = 100, windowMs = 15 * 60 * 1000) => {
  const requests = new Map()

  return (req, res, next) => {
    const key = req.user?.id || req.ip
    const now = Date.now()
    const windowStart = now - windowMs

    // Clean old entries
    for (const [k, timestamps] of requests.entries()) {
      const validTimestamps = timestamps.filter((t) => t > windowStart)
      if (validTimestamps.length === 0) {
        requests.delete(k)
      } else {
        requests.set(k, validTimestamps)
      }
    }

    // Check current user's requests
    const userRequests = requests.get(key) || []
    const recentRequests = userRequests.filter((t) => t > windowStart)

    if (recentRequests.length >= maxRequests) {
      return res.status(429).json({
        success: false,
        message: "Too many requests",
        code: "RATE_LIMIT_EXCEEDED",
        retryAfter: Math.ceil(windowMs / 1000),
      })
    }

    // Add current request
    recentRequests.push(now)
    requests.set(key, recentRequests)

    next()
  }
}
