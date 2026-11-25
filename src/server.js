require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const { auth, wrap, errorHandler } = require('./http');

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

const api = express.Router();
const route = (method, p, roles, fn) => api[method](p, auth(roles), wrap(fn));
['auth', 'masters', 'sales', 'inventory', 'production', 'reports'].forEach(m => require('./routes/' + m)(route));
app.get('/health', (req, res) => res.json({ ok: true }));
app.use('/api/v1', api);
app.use(express.static(path.join(__dirname, '..', 'public')));      // offline demo UI
app.use('/api/v1', (req, res) => res.status(404).json({ code: 'NOT_FOUND', message: 'No such endpoint' }));
app.use(errorHandler);

const port = process.env.PORT || 8000;
if (require.main === module) app.listen(port, () => console.log(`kadai API on http://localhost:${port}/api/v1`));
module.exports = app;
