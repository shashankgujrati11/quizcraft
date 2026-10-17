require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const mysql = require('mysql2/promise');

const app = express();
const PORT = Number(process.env.PORT || 3000);
if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
  console.error('JWT_SECRET must be configured and at least 32 characters long.');
  process.exit(1);
}
const origins = (process.env.FRONTEND_ORIGINS || '').split(',').map(x => x.trim()).filter(Boolean);
app.disable('x-powered-by');
app.use(helmet());
app.use(cors({ origin(origin, cb) { if (!origin || origins.includes(origin)) return cb(null, true); return cb(new Error('Origin not allowed by CORS')); } }));
app.use(express.json({ limit: '100kb' }));
app.use('/api/auth', rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: 'draft-7', legacyHeaders: false }));
app.use('/api/public', rateLimit({ windowMs: 60 * 1000, limit: 120, standardHeaders: 'draft-7', legacyHeaders: false }));

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 3306),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  ssl: process.env.DB_SSL === 'false' ? undefined : { rejectUnauthorized: true },
  decimalNumbers: true
});
const asyncRoute = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const clean = (v, max = 500) => typeof v === 'string' ? v.trim().slice(0, max) : '';
function makeCode() { const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let out = ''; for (let i = 0; i < 6; i++) out += alphabet[cryptoRandomInt(alphabet.length)]; return out; }
function cryptoRandomInt(max) { return require('crypto').randomInt(0, max); }
function signToken(user) { return jwt.sign({ sub: String(user.id), email: user.email }, process.env.JWT_SECRET, { expiresIn: '8h', issuer: 'quizcraft-api' }); }
function auth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) return res.status(401).json({ error: 'Please sign in to continue.' });
  try { const decoded = jwt.verify(token, process.env.JWT_SECRET, { issuer: 'quizcraft-api' }); req.user = { id: Number(decoded.sub), email: decoded.email }; next(); }
  catch { return res.status(401).json({ error: 'Your session expired. Please sign in again.' }); }
}
async function ownedQuiz(quizId, conductorId) {
  const [rows] = await pool.execute('SELECT id, conductor_id, title, description, code, is_active, created_at FROM quizzes WHERE id = ? AND conductor_id = ?', [quizId, conductorId]);
  return rows[0];
}
async function getQuestions(quizId, includeAnswers = false) {
  const [qs] = await pool.execute('SELECT id, question_text, position, correct_option_index FROM questions WHERE quiz_id = ? ORDER BY position', [quizId]);
  if (!qs.length) return [];
  const ids = qs.map(q => q.id);
  const placeholders = ids.map(() => '?').join(',');
  const [opts] = await pool.query(`SELECT question_id, option_text, option_index FROM question_options WHERE question_id IN (${placeholders}) ORDER BY question_id, option_index`, ids);
  return qs.map(q => {
    const item = { id: q.id, question: q.question_text, options: opts.filter(o => o.question_id === q.id).map(o => o.option_text) };
    if (includeAnswers) item.answerIndex = q.correct_option_index;
    return item;
  });
}
async function quizSummary(row) {
  const [countRows] = await pool.execute('SELECT COUNT(*) AS attempts FROM attempts WHERE quiz_id = ?', [row.id]);
  const [qRows] = await pool.execute('SELECT COUNT(*) AS questions FROM questions WHERE quiz_id = ?', [row.id]);
  return { id: String(row.id), title: row.title, description: row.description, code: row.code, active: Boolean(row.is_active), createdAt: row.created_at, questionCount: qRows[0].questions, attempts: countRows[0].attempts };
}

app.get('/api/health', asyncRoute(async (_req, res) => {
  await pool.query('SELECT 1');
  res.json({ ok: true, service: 'QuizCraft API', database: 'connected' });
}));

app.post('/api/auth/register', asyncRoute(async (req, res) => {
  const email = clean(req.body.email, 190).toLowerCase();
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
  if (password.length < 8 || password.length > 72) return res.status(400).json({ error: 'Password must be 8–72 characters long.' });
  const [existing] = await pool.execute('SELECT id FROM conductors WHERE email = ?', [email]);
  if (existing.length) return res.status(409).json({ error: 'An account with this email already exists.' });
  const hash = await bcrypt.hash(password, 12);
  const [result] = await pool.execute('INSERT INTO conductors (email, password_hash) VALUES (?, ?)', [email, hash]);
  const user = { id: result.insertId, email };
  res.status(201).json({ token: signToken(user), user: { email } });
}));
app.post('/api/auth/login', asyncRoute(async (req, res) => {
  const email = clean(req.body.email, 190).toLowerCase();
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  const [rows] = await pool.execute('SELECT id, email, password_hash FROM conductors WHERE email = ?', [email]);
  if (!rows.length || !(await bcrypt.compare(password, rows[0].password_hash))) return res.status(401).json({ error: 'Email or password is incorrect.' });
  res.json({ token: signToken(rows[0]), user: { email: rows[0].email } });
}));
app.get('/api/auth/me', auth, asyncRoute(async (req, res) => res.json({ user: { email: req.user.email } })));

app.get('/api/quizzes', auth, asyncRoute(async (req, res) => {
  const [rows] = await pool.execute('SELECT id, conductor_id, title, description, code, is_active, created_at FROM quizzes WHERE conductor_id = ? ORDER BY created_at DESC', [req.user.id]);
  res.json({ quizzes: await Promise.all(rows.map(quizSummary)) });
}));
app.post('/api/quizzes', auth, asyncRoute(async (req, res) => {
  const title = clean(req.body.title, 120), description = clean(req.body.description, 500);
  const questions = req.body.questions;
  if (!title) return res.status(400).json({ error: 'Quiz title is required.' });
  if (!Array.isArray(questions) || questions.length < 1 || questions.length > 100) return res.status(400).json({ error: 'A quiz must contain 1–100 questions.' });
  const normalized = [];
  for (const [i, q] of questions.entries()) {
    const question = clean(q.question, 1000), options = Array.isArray(q.options) ? q.options.map(o => clean(o, 500)) : [], answerIndex = Number(q.answerIndex);
    if (!question || options.length !== 4 || options.some(o => !o) || new Set(options).size !== 4 || !Number.isInteger(answerIndex) || answerIndex < 0 || answerIndex > 3) return res.status(400).json({ error: `Question ${i + 1} must have text, four distinct options, and a correct answer.` });
    normalized.push({ question, options, answerIndex });
  }
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    let code, inserted = false;
    for (let i = 0; i < 8 && !inserted; i++) {
      code = makeCode();
      try {
        const [r] = await conn.execute('INSERT INTO quizzes (conductor_id, title, description, code) VALUES (?, ?, ?, ?)', [req.user.id, title, description, code]);
        var quizId = r.insertId; inserted = true;
      } catch (e) { if (e.code !== 'ER_DUP_ENTRY') throw e; }
    }
    if (!inserted) throw new Error('Could not create a unique quiz code. Try again.');
    for (let i = 0; i < normalized.length; i++) {
      const q = normalized[i];
      const [qr] = await conn.execute('INSERT INTO questions (quiz_id, question_text, position, correct_option_index) VALUES (?, ?, ?, ?)', [quizId, q.question, i, q.answerIndex]);
      for (let j = 0; j < q.options.length; j++) await conn.execute('INSERT INTO question_options (question_id, option_text, option_index) VALUES (?, ?, ?)', [qr.insertId, q.options[j], j]);
    }
    await conn.commit();
    const [rows] = await pool.execute('SELECT id, conductor_id, title, description, code, is_active, created_at FROM quizzes WHERE id = ?', [quizId]);
    res.status(201).json({ quiz: await quizSummary(rows[0]) });
  } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }
}));
app.patch('/api/quizzes/:id/status', auth, asyncRoute(async (req, res) => {
  const quiz = await ownedQuiz(req.params.id, req.user.id);
  if (!quiz) return res.status(404).json({ error: 'Quiz not found.' });
  const active = req.body.active;
  if (typeof active !== 'boolean') return res.status(400).json({ error: 'active must be true or false.' });
  await pool.execute('UPDATE quizzes SET is_active = ? WHERE id = ?', [active, quiz.id]);
  res.json({ ok: true, active });
}));
app.get('/api/quizzes/:id/leaderboard', auth, asyncRoute(async (req, res) => {
  const quiz = await ownedQuiz(req.params.id, req.user.id);
  if (!quiz) return res.status(404).json({ error: 'Quiz not found.' });
  const [rows] = await pool.execute('SELECT student_name AS student, score, total_questions AS total, duration_seconds AS duration, submitted_at AS timestamp FROM attempts WHERE quiz_id = ? ORDER BY score DESC, duration_seconds ASC, submitted_at ASC, id ASC', [quiz.id]);
  res.json({ leaderboard: rows.map((r, i) => ({ rank: i + 1, ...r, duration: Number(r.duration), score: Number(r.score), total: Number(r.total) })) });
}));

app.get('/api/public/quizzes/:code', asyncRoute(async (req, res) => {
  const code = clean(req.params.code, 12).toUpperCase();
  const [rows] = await pool.execute('SELECT id, title, description, code, is_active FROM quizzes WHERE code = ?', [code]);
  const quiz = rows[0];
  if (!quiz || !quiz.is_active) return res.status(404).json({ error: 'No active quiz matches this code.' });
  const questions = await getQuestions(quiz.id, false); // Never expose correct answers to students.
  res.json({ quiz: { id: String(quiz.id), title: quiz.title, description: quiz.description, code: quiz.code, questions } });
}));
app.post('/api/public/quizzes/:code/submit', asyncRoute(async (req, res) => {
  const code = clean(req.params.code, 12).toUpperCase();
  const student = clean(req.body.studentName, 80);
  const answers = req.body.answers;
  const duration = Math.max(1, Math.min(86400, Math.floor(Number(req.body.durationSeconds) || 1)));
  if (!student) return res.status(400).json({ error: 'Student name is required.' });
  if (!Array.isArray(answers) || answers.length > 100 || answers.some(a => !Number.isInteger(Number(a)) || Number(a) < 0 || Number(a) > 3)) return res.status(400).json({ error: 'Answers are invalid.' });
  const [rows] = await pool.execute('SELECT id, is_active FROM quizzes WHERE code = ?', [code]);
  const quiz = rows[0];
  if (!quiz || !quiz.is_active) return res.status(404).json({ error: 'This quiz is closed or does not exist.' });
  const questions = await getQuestions(quiz.id, true);
  if (!questions.length || answers.length !== questions.length) return res.status(400).json({ error: 'The submitted answers do not match this quiz.' });
  const score = questions.reduce((sum, q, i) => sum + (Number(answers[i]) === q.answerIndex ? 1 : 0), 0);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [result] = await conn.execute('INSERT INTO attempts (quiz_id, student_name, score, total_questions, duration_seconds) VALUES (?, ?, ?, ?, ?)', [quiz.id, student, score, questions.length, duration]);
    for (let i = 0; i < questions.length; i++) await conn.execute('INSERT INTO attempt_answers (attempt_id, question_id, selected_option_index, is_correct) VALUES (?, ?, ?, ?)', [result.insertId, questions[i].id, Number(answers[i]), Number(answers[i]) === questions[i].answerIndex]);
    await conn.commit();
    const [rankRows] = await pool.execute('SELECT COUNT(*) AS ahead FROM attempts WHERE quiz_id = ? AND (score > ? OR (score = ? AND duration_seconds < ?) OR (score = ? AND duration_seconds = ? AND (submitted_at < (SELECT submitted_at FROM attempts WHERE id = ?) OR (submitted_at = (SELECT submitted_at FROM attempts WHERE id = ?) AND id < ?))))', [quiz.id, score, score, duration, score, duration, result.insertId, result.insertId, result.insertId]);
    const [countRows] = await pool.execute('SELECT COUNT(*) AS total FROM attempts WHERE quiz_id = ?', [quiz.id]);
    res.status(201).json({ score, total: questions.length, duration, rank: Number(rankRows[0].ahead) + 1, attempts: Number(countRows[0].total) });
  } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }
}));

app.use((err, _req, res, _next) => {
  console.error(err);
  if (err.message === 'Origin not allowed by CORS') return res.status(403).json({ error: 'This website is not allowed to use the QuizCraft API. Check FRONTEND_ORIGINS.' });
  if (err.code === 'ER_NO_SUCH_TABLE' || err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND') return res.status(503).json({ error: 'The database is unavailable or its schema has not been installed. Check the backend setup.' });
  res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Unexpected server error.' : (err.message || 'Unexpected server error.') });
});
app.listen(PORT, () => console.log(`QuizCraft API listening on port ${PORT}`));
