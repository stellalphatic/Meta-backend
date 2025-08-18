// middleware/workerAuth.js
export function verifyWorkerToken(req, res, next) {
  const expected = process.env.WORKER_CALLBACK_TOKEN;
  if (!expected) {
    console.error("WORKER_CALLBACK_TOKEN not configured");
    return res.status(500).json({ success: false, message: "Server misconfigured" });
  }

  // Accept either Authorization: Bearer <token> OR x-worker-token: <token>
  const authHeader = req.header("authorization");
  const xToken = req.header("x-worker-token");

  if (authHeader && authHeader.startsWith("Bearer ")) {
    const token = authHeader.slice(7);
    if (token === expected) return next();
  }

  if (xToken && xToken === expected) return next();

  return res.status(401).json({ success: false, message: "Unauthorized worker" });
}
