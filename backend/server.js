require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const mysql = require('mysql2/promise');
const crypto = require('crypto');
const { Resend } = require('resend');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
const OTP_FROM = process.env.RESEND_FROM || 'QuizCraft <onboarding@resend.dev>';
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

function otpDigest(email, purpose, code) {
  return crypto.createHmac('sha256', process.env.OTP_SECRET || process.env.JWT_SECRET)
    .update(`${email}:${purpose}:${code}`).digest('hex');
}
function makeOtp() { return String(crypto.randomInt(100000, 1000000)); }
function httpError(statusCode, message) { const e = new Error(message); e.statusCode = statusCode; return e; }
async function deliverOtp(email, code, purpose) {
  if (!resend) throw httpError(503, 'Email delivery is not configured. Add RESEND_API_KEY in Railway Variables.');
  const subject = purpose === 'signup' ? 'Verify your QuizCraft conductor email' : 'Your QuizCraft sign-in code';
  const action = purpose === 'signup' ? 'verify your email and activate your conductor account' : 'finish signing in to QuizCraft';
  const { error } = await resend.emails.send({
    from: OTP_FROM,
    to: [email],
    subject,
    text: `Your QuizCraft verification code is ${code}. Use it to ${action}. It expires in 5 minutes. If you did not request this code, you can ignore this email.`,
    html: `<div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;color:#191b32"><h2>QuizCraft verification</h2><p>Use this code to ${action}:</p><div style="font-size:32px;letter-spacing:8px;font-weight:700;padding:18px;background:#f1efff;border-radius:12px;text-align:center">${code}</div><p>This code expires in <b>5 minutes</b>. Never share it with anyone.</p><p style="color:#777e95;font-size:12px">If you did not request this code, you can ignore this email.</p></div>`
  });
  if (error) {
    console.error('Resend email delivery failed:', error.message || error.name || 'unknown error');
    throw httpError(502, 'Could not send the verification email. Check your Resend sender/domain setup and try again.');
  }
}
async function issueOtp({ email, purpose, conductorId = null, passwordHash = null }) {
  const [recent] = await pool.execute(
    'SELECT id, TIMESTAMPDIFF(SECOND, created_at, NOW()) AS age_seconds FROM conductor_otp_challenges WHERE email = ? AND purpose = ? ORDER BY id DESC LIMIT 1',
    [email, purpose]
  );
  if (recent.length && Number(recent[0].age_seconds) < 60) {
    throw httpError(429, 'Please wait 60 seconds before requesting another code.');
  }
  await pool.execute('DELETE FROM conductor_otp_challenges WHERE email = ? AND purpose = ?', [email, purpose]);
  const code = makeOtp();
  const [insert] = await pool.execute(
    'INSERT INTO conductor_otp_challenges (email, purpose, conductor_id, password_hash, otp_hash, expires_at, attempts) VALUES (?, ?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL 5 MINUTE), 0)',
    [email, purpose, conductorId, passwordHash, otpDigest(email, purpose, code)]
  );
  try {
    await deliverOtp(email, code, purpose);
  } catch (err) {
    await pool.execute('DELETE FROM conductor_otp_challenges WHERE id = ?', [insert.insertId]);
    throw err;
  }
}
app.post('/api/auth/register', asyncRoute(async (req, res) => {
  const email = clean(req.body.email, 190).toLowerCase();
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
  if (password.length < 8 || password.length > 72) return res.status(400).json({ error: 'Password must be 8–72 characters long.' });
  const [existing] = await pool.execute('SELECT id FROM conductors WHERE email = ?', [email]);
  if (existing.length) return res.status(409).json({ error: 'An account with this email already exists. Please sign in.' });
  const hash = await bcrypt.hash(password, 12);
  await issueOtp({ email, purpose: 'signup', passwordHash: hash });
  res.status(202).json({ otpRequired: true, purpose: 'signup', email, message: 'A verification code has been sent to your email. It expires in 5 minutes.' });
}));
app.post('/api/auth/login', asyncRoute(async (req, res) => {
  const email = clean(req.body.email, 190).toLowerCase();
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  const [rows] = await pool.execute('SELECT id, email, password_hash FROM conductors WHERE email = ?', [email]);
  if (!rows.length || !(await bcrypt.compare(password, rows[0].password_hash))) return res.status(401).json({ error: 'Email or password is incorrect.' });
  await issueOtp({ email: rows[0].email, purpose: 'login', conductorId: rows[0].id });
  res.status(202).json({ otpRequired: true, purpose: 'login', email: rows[0].email, message: 'A sign-in code has been sent to your email. It expires in 5 minutes.' });
}));
app.post('/api/auth/resend-otp', asyncRoute(async (req, res) => {
  const email = clean(req.body.email, 190).toLowerCase();
  const purpose = req.body.purpose === 'signup' ? 'signup' : req.body.purpose === 'login' ? 'login' : '';
  if (!purpose || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Invalid OTP request.' });
  const [rows] = await pool.execute('SELECT conductor_id, password_hash FROM conductor_otp_challenges WHERE email = ? AND purpose = ? ORDER BY id DESC LIMIT 1', [email, purpose]);
  if (!rows.length) return res.status(400).json({ error: 'No pending verification was found. Please start again.' });
  await issueOtp({ email, purpose, conductorId: rows[0].conductor_id, passwordHash: rows[0].password_hash });
  res.json({ ok: true, message: 'A new verification code has been sent.' });
}));
app.post('/api/auth/verify-otp', asyncRoute(async (req, res) => {
  const email = clean(req.body.email, 190).toLowerCase();
  const purpose = req.body.purpose === 'signup' ? 'signup' : req.body.purpose === 'login' ? 'login' : '';
  const code = typeof req.body.otp === 'string' ? req.body.otp.trim() : '';
  if (!purpose || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !/^\d{6}$/.test(code)) return res.status(400).json({ error: 'Enter the 6-digit code sent to your email.' });
  const [rows] = await pool.execute('SELECT * FROM conductor_otp_challenges WHERE email = ? AND purpose = ? ORDER BY id DESC LIMIT 1', [email, purpose]);
  const challenge = rows[0];
  if (!challenge) return res.status(400).json({ error: 'No pending verification was found. Please request a new code.' });
  if (new Date(challenge.expires_at).getTime() <= Date.now()) {
    await pool.execute('DELETE FROM conductor_otp_challenges WHERE id = ?', [challenge.id]);
    return res.status(400).json({ error: 'This code has expired. Request a new one.' });
  }
  if (Number(challenge.attempts) >= 5) {
    await pool.execute('DELETE FROM conductor_otp_challenges WHERE id = ?', [challenge.id]);
    return res.status(429).json({ error: 'Too many incorrect attempts. Request a new code.' });
  }
  const expected = Buffer.from(challenge.otp_hash, 'hex');
  const actual = Buffer.from(otpDigest(email, purpose, code), 'hex');
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
    const nextAttempts = Number(challenge.attempts) + 1;
    if (nextAttempts >= 5) await pool.execute('DELETE FROM conductor_otp_challenges WHERE id = ?', [challenge.id]);
    else await pool.execute('UPDATE conductor_otp_challenges SET attempts = ? WHERE id = ?', [nextAttempts, challenge.id]);
    return res.status(400).json({ error: nextAttempts >= 5 ? 'Too many incorrect attempts. Request a new code.' : `Incorrect code. ${5 - nextAttempts} attempt(s) remaining.` });
  }
  let user;
  if (purpose === 'signup') {
    if (!challenge.password_hash) return res.status(400).json({ error: 'Signup verification expired. Please create the account again.' });
    const [existing] = await pool.execute('SELECT id FROM conductors WHERE email = ?', [email]);
    if (existing.length) {
      await pool.execute('DELETE FROM conductor_otp_challenges WHERE id = ?', [challenge.id]);
      return res.status(409).json({ error: 'An account with this email already exists. Please sign in.' });
    }
    const [result] = await pool.execute('INSERT INTO conductors (email, password_hash) VALUES (?, ?)', [email, challenge.password_hash]);
    user = { id: result.insertId, email };
  } else {
    const [users] = await pool.execute('SELECT id, email FROM conductors WHERE id = ? AND email = ?', [challenge.conductor_id, email]);
    if (!users.length) return res.status(400).json({ error: 'Account not found. Please sign in again.' });
    user = users[0];
  }
  await pool.execute('DELETE FROM conductor_otp_challenges WHERE email = ? AND purpose = ?', [email, purpose]);
  res.json({ token: signToken(user), user: { email: user.email } });
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
  console.error('QuizCraft API error:', err.message || err.code || 'unknown error');
  if (err.message === 'Origin not allowed by CORS') return res.status(403).json({ error: 'This website is not allowed to use the QuizCraft API. Check FRONTEND_ORIGINS.' });
  if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
  if (err.code === 'ER_NO_SUCH_TABLE' || err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND') return res.status(503).json({ error: 'The database is unavailable or its schema has not been installed. Check the backend setup.' });
  res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Unexpected server error.' : (err.message || 'Unexpected server error.') });
});
app.listen(PORT, () => console.log(`QuizCraft API listening on port ${PORT}`));
