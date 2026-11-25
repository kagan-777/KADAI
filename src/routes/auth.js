const { q } = require('../db');
const { HttpError, SCREENS, sign, need } = require('../http');
const ROLES = ['salesman', 'admin', 'production', 'auditor', 'owner'];
module.exports = route => {
  route('post', '/auth/login', [], async (req, res) => {
    need(req.body, ['username', 'password', 'role']);
    const { username, password, role } = req.body;
    if (!ROLES.includes(role)) throw new HttpError(400, 'VALIDATION', 'Unknown role');
    const [u] = await q('SELECT id, username, full_name, role FROM users WHERE username=$1 AND active AND password_hash = crypt($2, password_hash)', [username, password]);
    if (!u) throw new HttpError(401, 'BAD_CREDENTIALS', 'Wrong username or password');
    if (u.role !== role) throw new HttpError(403, 'ROLE_MISMATCH', `This account is not a ${role} account`);
    res.json({ token: sign(u), user: { ...u, screens: SCREENS[u.role] } });
  });
  route('get', '/auth/me', ROLES, async (req, res) => {
    const { id, username, name, role } = req.user;
    res.json({ id, username, full_name: name, role, screens: SCREENS[role] });
  });
};
