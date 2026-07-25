const jwt = require('jsonwebtoken');
const { pool } = require('../db');

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: 'Sign in to continue.' });
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.userId = payload.sub;
    req.userName = payload.name;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Your session has expired. Sign in again.' });
  }
}

// Attaches req.userId if a valid token is present, but doesn't block the request.
function optionalAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (token) {
    try {
      const payload = jwt.verify(token, process.env.JWT_SECRET);
      req.userId = payload.sub;
      req.userName = payload.name;
    } catch (err) {
      // ignore invalid token for optional routes
    }
  }
  next();
}

// There's no roles system beyond this single flag — flip users.is_admin to
// true directly in the database for whichever account should see /admin.html.
async function requireAdmin(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: 'Sign in to continue.' });
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const result = await pool.query('SELECT is_admin FROM users WHERE id = $1', [payload.sub]);
    if (!result.rows[0] || !result.rows[0].is_admin) {
      return res.status(403).json({ error: "You don't have access to this page." });
    }
    req.userId = payload.sub;
    req.userName = payload.name;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Your session has expired. Sign in again.' });
  }
}

module.exports = { requireAuth, optionalAuth, requireAdmin };
