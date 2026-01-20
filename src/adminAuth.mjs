import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";

function parseAllowlist(raw) {
  return String(raw || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function issueAdminJwt({ email }) {
  const secret = requireEnv("ADMIN_JWT_SECRET");
  const ttlDays = Number(process.env.ADMIN_JWT_TTL_DAYS || "7");
  const expiresIn = Math.max(60, Math.floor(ttlDays * 24 * 60 * 60));

  const token = jwt.sign(
    { sub: email, role: "admin", email },
    secret,
    { expiresIn }
  );

  return {
    token,
    expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
  };
}

function verifyAdminJwt(token) {
  const secret = requireEnv("ADMIN_JWT_SECRET");
  return jwt.verify(token, secret);
}

/**
 * Express middleware
 * Accepts:
 *   Authorization: Bearer <jwt>
 * Optional dev fallback:
 *   x-admin-token: dev_admin_token_123
 */
export function requireAdminSession({ allowDevHeaderToken = false } = {}) {
  const DEV_TOKEN = "dev_admin_token_123";

  return (req, res, next) => {
    try {
      if (allowDevHeaderToken && String(req.headers["x-admin-token"] || "") === DEV_TOKEN) {
        return next();
      }

      const auth = String(req.headers.authorization || "");
      const match = auth.match(/^Bearer\s+(.+)$/i);
      if (!match) {
        return res.status(401).json({ error: "Missing Authorization: Bearer <token>" });
      }

      const decoded = verifyAdminJwt(match[1]);
      if (decoded?.role !== "admin") {
        return res.status(403).json({ error: "Forbidden" });
      }

      req.admin = { email: decoded.email || decoded.sub };
      next();
    } catch (e) {
      return res.status(401).json({ error: "Invalid or expired admin session" });
    }
  };
}

/**
 * POST /admin/auth/login
 * body: { email, password }
 */
export async function handleAdminLogin(req, res) {
  try {
    const { email, password } = req.body || {};
    const emailNorm = String(email || "").trim().toLowerCase();
    const pwd = String(password || "");

    if (!emailNorm || !pwd) {
      return res.status(400).json({ error: "email and password required" });
    }

    const allowlist = parseAllowlist(process.env.ADMIN_ALLOWED_EMAILS);
    if (!allowlist.includes(emailNorm)) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const hash = requireEnv("ADMIN_PASSWORD_HASH");
    const ok = await bcrypt.compare(pwd, hash);
    if (!ok) return res.status(401).json({ error: "Invalid credentials" });

    const { token, expiresAt } = issueAdminJwt({ email: emailNorm });
    return res.json({ adminSessionToken: token, expiresAt, email: emailNorm });
  } catch (e) {
    return res.status(500).json({ error: "Admin login failed" });
  }
}
