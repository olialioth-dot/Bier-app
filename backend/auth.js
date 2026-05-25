const jwt    = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const SECRET  = process.env.JWT_SECRET || 'bierdeal-secret-2025';
const EXPIRES = '30d';

module.exports = {
  // Hash password
  hashPassword: pw => bcrypt.hashSync(pw, 10),
  checkPassword: (pw, hash) => bcrypt.compareSync(pw, hash),

  // Sign token
  signToken: payload => jwt.sign(payload, SECRET, { expiresIn: EXPIRES }),

  // Middleware: require valid JWT
  requireAuth(req, res, next) {
    const header = req.headers.authorization || '';
    const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Nicht eingeloggt' });
    try {
      req.user = jwt.verify(token, SECRET);
      next();
    } catch {
      res.status(401).json({ error: 'Token ungültig oder abgelaufen' });
    }
  },

  // Middleware: attach user if token present (optional auth)
  optionalAuth(req, res, next) {
    const header = req.headers.authorization || '';
    const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (token) {
      try { req.user = jwt.verify(token, SECRET); } catch {}
    }
    next();
  },
};
