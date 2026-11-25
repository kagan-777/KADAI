const jwt = require('jsonwebtoken');
const SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';

class HttpError extends Error {
  constructor(status, code, message, details) { super(message); this.status = status; this.code = code; this.details = details; }
}
const SCREENS = {
  salesman: ['new-order', 'my-orders'],
  admin: ['overview', 'sales-orders', 'inventory', 'collections'],
  production: ['overview', 'production', 'purchases', 'inventory'],
  auditor: ['monthly-audit', 'stock-ledger'],
  owner: ['overview', 'monthly-audit', 'inventory']
};
const sign = u => jwt.sign({ id: u.id, username: u.username, name: u.full_name, role: u.role }, SECRET, { expiresIn: '12h' });

// Role guard. roles = [] means public. The server is the only authority; hiding menus in the UI is cosmetic.
function auth(roles) {
  return (req, res, next) => {
    if (!roles || roles.length === 0) return next();
    const h = req.headers.authorization || '';
    if (!h.startsWith('Bearer ')) throw new HttpError(401, 'UNAUTHENTICATED', 'Login required');
    try { req.user = jwt.verify(h.slice(7), SECRET); } catch { throw new HttpError(401, 'BAD_TOKEN', 'Invalid or expired token'); }
    if (!roles.includes(req.user.role)) throw new HttpError(403, 'FORBIDDEN', `The ${req.user.role} role cannot use this endpoint`);
    next();
  };
}
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
const need = (obj, fields) => {
  const miss = fields.filter(f => obj?.[f] === undefined || obj[f] === null || obj[f] === '');
  if (miss.length) throw new HttpError(400, 'VALIDATION', `Missing: ${miss.join(', ')}`, { missing: miss });
};
const pos = (v, name) => { if (!(Number(v) > 0)) throw new HttpError(400, 'VALIDATION', `${name} must be greater than 0`); return Number(v); };

function errorHandler(err, req, res, next) {
  if (err instanceof HttpError) return res.status(err.status).json({ code: err.code, message: err.message, details: err.details });
  const m = err.message || '';
  if (err.code === 'P0001') {                                  // RAISE EXCEPTION from the database rules
    const code = /Insufficient stock/.test(m) ? 'INSUFFICIENT_STOCK' : /already|final|locked/.test(m) ? 'ALREADY_POSTED' : 'RULE_VIOLATION';
    return res.status(409).json({ code, message: m });
  }
  if (err.code === '23505') return res.status(409).json({ code: 'DUPLICATE', message: err.detail || m });
  if (err.code === '23503' || err.code === '23514' || err.code === '22P02') return res.status(422).json({ code: 'INVALID_DATA', message: err.detail || m });
  console.error(err);
  res.status(500).json({ code: 'SERVER_ERROR', message: 'Unexpected error' });
}
const csv = rows => {
  if (!rows.length) return '';
  const k = Object.keys(rows[0]), esc = v => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  return [k.join(','), ...rows.map(r => k.map(c => esc(r[c])).join(','))].join('\n');
};
module.exports = { HttpError, SCREENS, sign, auth, wrap, need, pos, errorHandler, csv };
