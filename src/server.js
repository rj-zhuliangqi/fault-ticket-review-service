import express from 'express';
import multer from 'multer';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes, randomUUID, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, unlinkSync, writeFileSync, readFileSync, copyFileSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const scrypt = promisify(scryptCb);
const __dirname = resolve(fileURLToPath(new URL('.', import.meta.url)));
const ROOT = resolve(__dirname, '..');
const ENV_FILE = join(ROOT, '.env');
if (existsSync(ENV_FILE)) { for (const line of readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) { const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, ''); } }
const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = resolve(process.env.DATA_DIR || join(ROOT, 'data'));
const DATASETS_DIR = join(DATA_DIR, 'datasets');
const DB_PATH = join(DATA_DIR, 'review.sqlite');
const SESSION_DAYS = Number(process.env.SESSION_DAYS || 7);
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 80);

mkdirSync(DATA_DIR, { recursive: true });
mkdirSync(DATASETS_DIR, { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
db.exec(`
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'reviewer' CHECK(role IN ('admin','reviewer')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','active','disabled')),
  created_at TEXT NOT NULL, approved_at TEXT, last_login_at TEXT
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS datasets (
  id TEXT PRIMARY KEY, original_name TEXT NOT NULL, sha256 TEXT NOT NULL UNIQUE,
  headers_json TEXT NOT NULL, total_rows INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','published','archived')),
  source_path TEXT NOT NULL, created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL, published_at TEXT
);
CREATE TABLE IF NOT EXISTS dataset_rows (
  id TEXT PRIMARY KEY, dataset_id TEXT NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
  row_number INTEGER NOT NULL, data_json TEXT NOT NULL,
  main_ticket_number TEXT, similar_ticket_number TEXT, main_business_group TEXT,
  ai_route TEXT, ai_judgment TEXT, human_judgment TEXT, similarity_score REAL, ai_confidence REAL,
  main_title TEXT, similar_title TEXT, main_solution TEXT, similar_solution TEXT,
  main_root_cause TEXT, similar_root_cause TEXT, ai_reason TEXT, human_note TEXT,
  UNIQUE(dataset_id, row_number)
);
CREATE INDEX IF NOT EXISTS idx_dataset_rows_dataset ON dataset_rows(dataset_id, row_number);
CREATE INDEX IF NOT EXISTS idx_dataset_rows_filters ON dataset_rows(dataset_id, main_business_group, ai_route, ai_judgment, human_judgment);
CREATE TABLE IF NOT EXISTS review_results (
  dataset_id TEXT NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
  row_id TEXT NOT NULL REFERENCES dataset_rows(id) ON DELETE CASCADE,
  review_status TEXT NOT NULL CHECK(review_status IN ('in_progress','completed')),
  review_conclusion TEXT, review_note TEXT, reviewer_id TEXT REFERENCES users(id),
  reviewer_name TEXT, reviewer_username TEXT, claimed_at TEXT, reviewed_at TEXT, updated_at TEXT NOT NULL,
  PRIMARY KEY(dataset_id, row_id)
);
CREATE TABLE IF NOT EXISTS review_drafts (
  dataset_id TEXT NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
  row_id TEXT NOT NULL REFERENCES dataset_rows(id) ON DELETE CASCADE,
  review_conclusion TEXT, review_note TEXT, saved_by TEXT REFERENCES users(id), updated_at TEXT NOT NULL,
  PRIMARY KEY(dataset_id, row_id)
);
CREATE TABLE IF NOT EXISTS review_events (
  id TEXT PRIMARY KEY, dataset_id TEXT NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
  row_id TEXT NOT NULL REFERENCES dataset_rows(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL, actor_id TEXT REFERENCES users(id), payload_json TEXT, created_at TEXT NOT NULL
);
`);

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 } });
const now = () => new Date().toISOString();
const safeName = (name) => basename(String(name || 'upload.csv')).replace(/[^\w\-.\u4e00-\u9fff]+/g, '_').slice(0, 180) || 'upload.csv';
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const tokenHash = (token) => createHash('sha256').update(token).digest('hex');
const json = (value) => JSON.stringify(value ?? null);
const parseJson = (value, fallback = null) => { try { return JSON.parse(value); } catch { return fallback; } };
const clean = (value) => String(value ?? '').trim();
const num = (value) => { const n = Number.parseFloat(String(value ?? '').replace(/,/g, '')); return Number.isFinite(n) ? n : null; };

function parseCsvText(text) {
  const input = String(text || '').replace(/^\uFEFF/, '');
  const all = []; let row = []; let field = ''; let quoted = false;
  for (let i = 0; i < input.length; i += 1) {
    const c = input[i];
    if (quoted) {
      if (c === '"') { if (input[i + 1] === '"') { field += '"'; i += 1; } else quoted = false; }
      else field += c;
    } else if (c === '"' && field === '') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); all.push(row); row = []; field = ''; }
    else if (c === '\r') { if (input[i + 1] !== '\n') { row.push(field); all.push(row); row = []; field = ''; } }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); all.push(row); }
  while (all.length && all.at(-1).every((x) => x === '')) all.pop();
  if (!all.length) throw new Error('CSV 文件为空。');
  const headers = all.shift().map((x) => clean(x));
  if (headers.some((x) => !x)) throw new Error('CSV 表头为空或存在空字段。');
  if (new Set(headers).size !== headers.length) throw new Error('CSV 表头存在重复字段。');
  const bad = all.findIndex((r) => r.length !== headers.length);
  if (bad >= 0) throw new Error(`第 ${bad + 2} 行字段数为 ${all[bad].length}，应为 ${headers.length}；请检查引号或换行。`);
  return { headers, rows: all.map((values) => Object.fromEntries(headers.map((h, i) => [h, values[i]]))) };
}
function decodeCsv(buffer) { let text = new TextDecoder('utf-8').decode(buffer); if (text.includes('\uFFFD')) text = new TextDecoder('gb18030').decode(buffer); return text; }
function rowId(datasetId, row, index) { const key = `${datasetId}|${index + 1}|${clean(row.main_ticket_number)}|${clean(row.similar_ticket_number)}|${clean(row.main_incident_id)}|${clean(row.similar_incident_id)}`; return `row_${index + 1}_${createHash('sha1').update(key).digest('hex').slice(0, 12)}`; }
async function hashPassword(password) { if (typeof password !== 'string' || password.length < 8) throw new Error('密码至少需要 8 位。'); const salt = randomBytes(16).toString('hex'); const derived = await scrypt(password, salt, 64); return `scrypt$${salt}$${Buffer.from(derived).toString('hex')}`; }
async function verifyPassword(password, encoded) { const [scheme, salt, hash] = String(encoded || '').split('$'); if (scheme !== 'scrypt' || !salt || !hash) return false; const derived = Buffer.from(await scrypt(password, salt, 64)); const expected = Buffer.from(hash, 'hex'); return expected.length === derived.length && timingSafeEqual(expected, derived); }
function setCookie(res, name, value, maxAge) { const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax']; if (maxAge != null) parts.push(`Max-Age=${Math.max(0, Math.floor(maxAge))}`); res.setHeader('Set-Cookie', parts.join('; ')); }
function clearCookie(res, name) { setCookie(res, name, '', 0); }
function readCookie(req, name) { const raw = req.headers.cookie || ''; const found = raw.split(';').map((x) => x.trim()).find((x) => x.startsWith(`${name}=`)); return found ? decodeURIComponent(found.slice(name.length + 1)) : ''; }
function publicUser(user) { return user ? { id: user.id, username: user.username, display_name: user.display_name, role: user.role, status: user.status } : null; }
function authRequired(req, res, next) { const token = readCookie(req, 'review_sid'); if (!token) return res.status(401).json({ error: '请先登录。', code: 'AUTH_REQUIRED' }); const session = db.prepare(`SELECT s.*, u.username, u.display_name, u.role, u.status FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?`).get(tokenHash(token), now()); if (!session || session.status !== 'active') { clearCookie(res, 'review_sid'); return res.status(401).json({ error: '登录已失效或账号未审核。', code: 'AUTH_REQUIRED' }); } req.user = { id: session.user_id, username: session.username, display_name: session.display_name, role: session.role, status: session.status }; return next(); }
function adminRequired(req, res, next) { if (req.user?.role !== 'admin') return res.status(403).json({ error: '只有管理员可以执行此操作。', code: 'ADMIN_REQUIRED' }); return next(); }
function activeDataset(req, res, next) { const dataset = db.prepare('SELECT * FROM datasets WHERE id=?').get(req.params.id); if (!dataset) return res.status(404).json({ error: '数据批次不存在。' }); if (req.user.role !== 'admin' && dataset.status !== 'published') return res.status(403).json({ error: '当前批次尚未发布。' }); req.dataset = dataset; return next(); }
function logEvent(datasetId, rowIdValue, eventType, actorId, payload = {}) { db.prepare('INSERT INTO review_events(id,dataset_id,row_id,event_type,actor_id,payload_json,created_at) VALUES(?,?,?,?,?,?,?)').run(randomUUID(), datasetId, rowIdValue, eventType, actorId || null, json(payload), now()); }
function rowView(dataset, row, review, draft) { return { id: row.id, row_number: row.row_number, data: parseJson(row.data_json, {}), review: review ? { ...review } : null, draft: draft ? { ...draft } : null, dataset_id: dataset.id }; }
function datasetView(d) { const counts = db.prepare(`SELECT COUNT(*) AS total, SUM(CASE WHEN rr.review_status='completed' THEN 1 ELSE 0 END) AS completed, SUM(CASE WHEN rr.review_status='in_progress' THEN 1 ELSE 0 END) AS in_progress, AVG(dr.similarity_score) AS avg_similarity, AVG(dr.ai_confidence) AS avg_confidence FROM dataset_rows dr LEFT JOIN review_results rr ON rr.dataset_id=dr.dataset_id AND rr.row_id=dr.id WHERE dr.dataset_id=?`).get(d.id); return { ...d, avg_similarity: counts?.avg_similarity == null ? null : Number(counts.avg_similarity), avg_confidence: counts?.avg_confidence == null ? null : Number(counts.avg_confidence), headers: parseJson(d.headers_json, []), total: d.total_rows, completed: Number(counts?.completed || 0), in_progress: Number(counts?.in_progress || 0), pending: d.total_rows - Number(counts?.completed || 0) - Number(counts?.in_progress || 0) }; }

function keyValue(data, names) {
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(data, name) && clean(data[name])) return clean(data[name]);
  }
  return '';
}
function rowColumns(data) {
  return {
    main_ticket_number: keyValue(data, ['main_ticket_number', '主工单号', '主工单编号']),
    similar_ticket_number: keyValue(data, ['similar_ticket_number', '关联工单号', '相似工单号']),
    main_incident_id: keyValue(data, ['main_incident_id', '主事件ID', '主事件 id']),
    similar_incident_id: keyValue(data, ['similar_incident_id', '关联事件ID', '相似事件ID']),
    business_group: keyValue(data, ['main_business_group', 'business_group', '业务群组', '业务组']),
    ai_route: keyValue(data, ['ai_route', 'AI路由', 'ai_route_name', 'AI 路由']),
    ai_judgment: keyValue(data, ['ai_judgment', 'AI判断', 'AI 判断']),
    human_judgment: keyValue(data, ['human_judgment', '人工判断', '人工 判断']),
    similarity_score: num(keyValue(data, ['similarity_score', '相似度', 'similarity'])),
    ai_confidence: num(keyValue(data, ['ai_confidence', 'AI置信度', 'AI 置信度', 'confidence'])),
    main_title: keyValue(data, ['main_title', '主工单标题', '主标题']),
    similar_title: keyValue(data, ['similar_title', '关联工单标题', '相似工单标题']),
    main_solution: keyValue(data, ['main_solution', '主工单解决方案', '主解决方案']),
    similar_solution: keyValue(data, ['similar_solution', '关联工单解决方案', '相似解决方案']),
    main_root_cause: keyValue(data, ['main_root_cause', '主工单根因', '主根因']),
    similar_root_cause: keyValue(data, ['similar_root_cause', '关联工单根因', '相似工单根因']),
    ai_reason: keyValue(data, ['ai_reason', 'AI理由', 'AI 理由']),
    human_note: keyValue(data, ['human_note', '人工备注', '人工 备注'])
  };
}
function requireField(data, names, label) { if (!keyValue(data, names)) throw new Error(`缺少关键字段：${label}。`); }
function originalReviewerForData(data) { return keyValue(data, ['human_reviewed_by', '人工复核人', '人工审核人', '原始标注人']); }
function csvCell(value) { const s = String(value ?? ''); return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }
function csvText(headers, rows) { return `\uFEFF${headers.map(csvCell).join(',')}\r\n${rows.map((r) => headers.map((h) => csvCell(r[h])).join(',')).join('\r\n')}\r\n`; }
function reviewFor(datasetId, rowIdValue) { return db.prepare('SELECT * FROM review_results WHERE dataset_id=? AND row_id=?').get(datasetId, rowIdValue) || null; }
function draftFor(datasetId, rowIdValue) { return db.prepare('SELECT * FROM review_drafts WHERE dataset_id=? AND row_id=?').get(datasetId, rowIdValue) || null; }
function getRow(datasetId, rowIdValue) { return db.prepare('SELECT * FROM dataset_rows WHERE dataset_id=? AND id=?').get(datasetId, rowIdValue); }
function editableBy(user, review) { return Boolean(user && (user.role === 'admin' || (review && review.reviewer_id === user.id && review.review_status === 'in_progress'))); }
function createSession(res, userId) { const token = randomBytes(32).toString('hex'); const expires = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString(); db.prepare('INSERT INTO sessions(id,user_id,token_hash,created_at,expires_at) VALUES(?,?,?,?,?)').run(randomUUID(), userId, tokenHash(token), now(), expires); setCookie(res, 'review_sid', token, SESSION_DAYS * 86400); }
function publicReview(review) {
  if (!review) return null;
  return { review_status: review.review_status, review_conclusion: review.review_conclusion, review_note: review.review_note, reviewer_id: review.reviewer_id, reviewer_name: review.reviewer_name, reviewer_username: review.reviewer_username, claimed_at: review.claimed_at, reviewed_at: review.reviewed_at, updated_at: review.updated_at };
}
function publicDraft(draft) { return draft ? { review_conclusion: draft.review_conclusion, review_note: draft.review_note, saved_by: draft.saved_by, updated_at: draft.updated_at } : null; }

app.get('/api/setup/status', (req, res) => {
  const admins = Number(db.prepare("SELECT COUNT(*) AS n FROM users WHERE role='admin'").get().n || 0);
  res.json({ initialized: admins > 0, can_initialize: admins === 0 });
});
app.post('/api/setup/admin', async (req, res) => {
  try {
    if (Number(db.prepare("SELECT COUNT(*) AS n FROM users WHERE role='admin'").get().n || 0) > 0) return res.status(409).json({ error: '管理员已经初始化。' });
    const { username, display_name, password } = req.body || {};
    if (!clean(username) || !clean(display_name)) throw new Error('请填写登录名和姓名。');
    const user = { id: randomUUID(), username: clean(username).toLowerCase(), display_name: clean(display_name), password_hash: await hashPassword(password), role: 'admin', status: 'active', created_at: now(), approved_at: now() };
    db.prepare('INSERT INTO users(id,username,display_name,password_hash,role,status,created_at,approved_at) VALUES(?,?,?,?,?,?,?,?)').run(user.id, user.username, user.display_name, user.password_hash, user.role, user.status, user.created_at, user.approved_at);
    createSession(res, user.id); res.json({ user: publicUser(user) });
  } catch (error) { res.status(error.message?.includes('UNIQUE') ? 409 : 400).json({ error: error.message || '初始化失败。' }); }
});
app.post('/api/auth/register', async (req, res) => {
  try {
    const { username, display_name, password } = req.body || {};
    const uname = clean(username).toLowerCase();
    if (!/^[a-z0-9][a-z0-9_.-]{2,31}$/.test(uname)) throw new Error('登录名需为 3-32 位字母、数字、下划线、点或横线。');
    if (!clean(display_name)) throw new Error('请填写姓名。');
    const user = { id: randomUUID(), username: uname, display_name: clean(display_name), password_hash: await hashPassword(password), role: 'reviewer', status: 'pending', created_at: now() };
    db.prepare('INSERT INTO users(id,username,display_name,password_hash,role,status,created_at) VALUES(?,?,?,?,?,?,?)').run(user.id, user.username, user.display_name, user.password_hash, user.role, user.status, user.created_at);
    res.status(201).json({ message: '注册成功，请等待管理员审核。' });
  } catch (error) { res.status(error.message?.includes('UNIQUE') ? 409 : 400).json({ error: error.message || '注册失败。' }); }
});
app.post('/api/auth/login', async (req, res) => {
  try {
    const username = clean(req.body?.username).toLowerCase(); const password = req.body?.password;
    const user = db.prepare('SELECT * FROM users WHERE username=?').get(username);
    if (!user || !(await verifyPassword(password, user.password_hash))) return res.status(401).json({ error: '登录名或密码错误。' });
    if (user.status !== 'active') return res.status(403).json({ error: user.status === 'pending' ? '账号待管理员审核。' : '账号已停用。' });
    db.prepare('UPDATE users SET last_login_at=? WHERE id=?').run(now(), user.id); createSession(res, user.id); res.json({ user: publicUser({ ...user, last_login_at: now() }) });
  } catch (error) { res.status(400).json({ error: error.message || '登录失败。' }); }
});
app.post('/api/auth/logout', (req, res) => { const token = readCookie(req, 'review_sid'); if (token) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(tokenHash(token)); clearCookie(res, 'review_sid'); res.json({ ok: true }); });
app.get('/api/auth/session', (req, res) => {
  const token = readCookie(req, 'review_sid'); let user = null;
  if (token) { const s = db.prepare('SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?').get(tokenHash(token), now()); if (s?.status === 'active') user = publicUser(s); }
  const admins = Number(db.prepare("SELECT COUNT(*) AS n FROM users WHERE role='admin'").get().n || 0);
  res.json({ user, initialized: admins > 0 });
});

app.get('/api/admin/users', authRequired, adminRequired, (req, res) => res.json({ users: db.prepare('SELECT id,username,display_name,role,status,created_at,approved_at,last_login_at FROM users ORDER BY CASE status WHEN \'pending\' THEN 0 WHEN \'active\' THEN 1 ELSE 2 END, created_at DESC').all() }));
app.post('/api/admin/users/:id/approve', authRequired, adminRequired, (req, res) => { const result = db.prepare("UPDATE users SET status='active', approved_at=COALESCE(approved_at,?) WHERE id=? AND role='reviewer'").run(now(), req.params.id); if (!result.changes) return res.status(404).json({ error: '用户不存在或不可审核。' }); res.json({ ok: true }); });
app.post('/api/admin/users/:id/disable', authRequired, adminRequired, (req, res) => { const result = db.prepare("UPDATE users SET status='disabled' WHERE id=? AND id<>?").run(req.params.id, req.user.id); if (!result.changes) return res.status(404).json({ error: '用户不存在或不能停用自己。' }); db.prepare('DELETE FROM sessions WHERE user_id=?').run(req.params.id); res.json({ ok: true }); });

app.get('/api/datasets', authRequired, (req, res) => {
  const rows = req.user.role === 'admin' ? db.prepare('SELECT * FROM datasets ORDER BY created_at DESC').all() : db.prepare("SELECT * FROM datasets WHERE status='published' ORDER BY published_at DESC, created_at DESC").all();
  res.json({ datasets: rows.map(datasetView) });
});
app.post('/api/datasets', authRequired, adminRequired, upload.single('file'), (req, res) => {
  try {
    if (!req.file) throw new Error('请选择 CSV 文件。');
    const digest = sha256(req.file.buffer); const existing = db.prepare('SELECT * FROM datasets WHERE sha256=?').get(digest);
    if (existing) return res.json({ dataset: datasetView(existing), reused: true });
    const parsed = parseCsvText(decodeCsv(req.file.buffer)); if (!parsed.rows.length) throw new Error('CSV 没有数据行。');
    for (const row of parsed.rows) { requireField(row, ['main_ticket_number', '主工单号', '主工单编号'], '主工单号'); requireField(row, ['similar_ticket_number', '关联工单号', '相似工单号'], '关联工单号'); }
    const id = randomUUID(); const originalName = safeName(req.file.originalname); const sourcePath = join(DATASETS_DIR, `${digest}_${originalName}`); writeFileSync(sourcePath, req.file.buffer);
    const created = now(); const insertDataset = db.prepare('INSERT INTO datasets(id,original_name,sha256,headers_json,total_rows,status,source_path,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?)');
    const insertRow = db.prepare(`INSERT INTO dataset_rows(id,dataset_id,row_number,data_json,main_ticket_number,similar_ticket_number,main_business_group,ai_route,ai_judgment,human_judgment,similarity_score,ai_confidence,main_title,similar_title,main_solution,similar_solution,main_root_cause,similar_root_cause,ai_reason,human_note) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    db.exec('BEGIN');
    try {
      insertDataset.run(id, originalName, digest, json(parsed.headers), parsed.rows.length, 'draft', sourcePath, req.user.id, created);
      parsed.rows.forEach((data, index) => { const c = rowColumns(data); insertRow.run(rowId(id, data, index), id, index + 1, json(data), c.main_ticket_number, c.similar_ticket_number, c.business_group, c.ai_route, c.ai_judgment, c.human_judgment, c.similarity_score, c.ai_confidence, c.main_title, c.similar_title, c.main_solution, c.similar_solution, c.main_root_cause, c.similar_root_cause, c.ai_reason, c.human_note); });
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); try { unlinkSync(sourcePath); } catch {} throw error; }
    res.status(201).json({ dataset: datasetView(db.prepare('SELECT * FROM datasets WHERE id=?').get(id)), reused: false });
  } catch (error) { res.status(400).json({ error: error.message || '上传失败。' }); }
});
app.post('/api/datasets/:id/publish', authRequired, adminRequired, (req, res) => { const result = db.prepare("UPDATE datasets SET status='published', published_at=COALESCE(published_at,?) WHERE id=? AND status<>'archived'").run(now(), req.params.id); if (!result.changes) return res.status(404).json({ error: '批次不存在或已归档。' }); res.json({ dataset: datasetView(db.prepare('SELECT * FROM datasets WHERE id=?').get(req.params.id)) }); });
app.post('/api/datasets/:id/archive', authRequired, adminRequired, (req, res) => { const result = db.prepare("UPDATE datasets SET status='archived' WHERE id=?").run(req.params.id); if (!result.changes) return res.status(404).json({ error: '批次不存在。' }); res.json({ ok: true }); });
app.get('/api/datasets/:id/source', authRequired, adminRequired, activeDataset, (req, res) => res.download(req.dataset.source_path, req.dataset.original_name));

app.get('/api/datasets/:id/rows', authRequired, activeDataset, (req, res) => {
  const q = req.query || {}; const page = Math.max(1, Number.parseInt(q.page || '1', 10) || 1); const pageSize = Math.min(2000, Math.max(10, Number.parseInt(q.pageSize || '30', 10) || 30));
  const where = ['dr.dataset_id=?']; const params = [req.dataset.id];
  const addLike = (field, value) => { if (clean(value)) { where.push(`LOWER(COALESCE(${field},'')) LIKE LOWER(?)`); params.push(`%${clean(value)}%`); } };
  addLike('dr.main_business_group', q.business_group); addLike('dr.ai_route', q.ai_route); addLike('dr.ai_judgment', q.ai_judgment); addLike('dr.human_judgment', q.human_judgment);
  if (clean(q.reviewer_id)) { if (q.reviewer_id === '__unassigned__') where.push('rr.reviewer_id IS NULL'); else { where.push('rr.reviewer_id=?'); params.push(clean(q.reviewer_id)); } }
  if (clean(q.original_reviewer)) { const wanted = clean(q.original_reviewer); const originalRows = db.prepare('SELECT id,data_json FROM dataset_rows WHERE dataset_id=?').all(req.dataset.id).filter(item => { const value = originalReviewerForData(parseJson(item.data_json, {})); return wanted === '__unassigned__' ? !value : value === wanted; }).map(item => item.id); if (!originalRows.length) where.push('1=0'); else { where.push(`dr.id IN (${originalRows.map(() => '?').join(',')})`); params.push(...originalRows); } }
  if (clean(q.keyword)) { where.push(`(LOWER(COALESCE(dr.main_ticket_number,'')) LIKE LOWER(?) OR LOWER(COALESCE(dr.similar_ticket_number,'')) LIKE LOWER(?) OR LOWER(COALESCE(dr.main_title,'')) LIKE LOWER(?) OR LOWER(COALESCE(dr.similar_title,'')) LIKE LOWER(?) OR LOWER(COALESCE(dr.main_root_cause,'')) LIKE LOWER(?) OR LOWER(COALESCE(dr.similar_root_cause,'')) LIKE LOWER(?) OR LOWER(COALESCE(dr.main_solution,'')) LIKE LOWER(?) OR LOWER(COALESCE(dr.similar_solution,'')) LIKE LOWER(?) OR LOWER(COALESCE(dr.ai_reason,'')) LIKE LOWER(?) OR LOWER(COALESCE(dr.human_note,'')) LIKE LOWER(?))`); for (let i = 0; i < 10; i += 1) params.push(`%${clean(q.keyword)}%`); }
  if (q.minSimilarity !== undefined && q.minSimilarity !== '') { where.push('dr.similarity_score>=?'); params.push(Number(q.minSimilarity)); }
  if (q.maxSimilarity !== undefined && q.maxSimilarity !== '') { where.push('dr.similarity_score<=?'); params.push(Number(q.maxSimilarity)); }
  if (q.minConfidence !== undefined && q.minConfidence !== '') { where.push('dr.ai_confidence>=?'); params.push(Number(q.minConfidence)); }
  if (q.maxConfidence !== undefined && q.maxConfidence !== '') { where.push('dr.ai_confidence<=?'); params.push(Number(q.maxConfidence)); }
  const status = clean(q.review_status || q.status); if (status === 'pending') where.push('rr.review_status IS NULL'); else if (status === 'in_progress') { where.push("rr.review_status='in_progress'"); if (req.user.role !== 'admin' && q.mine === '1') { where.push('rr.reviewer_id=?'); params.push(req.user.id); } } else if (status === 'completed') where.push("rr.review_status='completed'");
  if (q.mine === '1' && !status) { where.push('rr.reviewer_id=?'); params.push(req.user.id); }
  const whereSql = where.join(' AND '); const groupCountExpr = "COUNT(*) OVER (PARTITION BY CASE WHEN NULLIF(TRIM(COALESCE(dr.main_ticket_number,'')),'') IS NULL THEN dr.id ELSE dr.main_ticket_number END)"; const reportTimeExpr = "COALESCE(json_extract(dr.data_json, '$.main_reported_at'), json_extract(dr.data_json, '$.main_report_time'), json_extract(dr.data_json, '$.main_report_date'), '')"; const sortMap = { similarity: 'dr.similarity_score', confidence: 'dr.ai_confidence', row: 'dr.row_number', group_count: groupCountExpr, report_time: reportTimeExpr }; const order = sortMap[clean(q.sort)] || groupCountExpr; const direction = String(q.direction).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  const total = Number(db.prepare(`SELECT COUNT(*) AS n FROM dataset_rows dr LEFT JOIN review_results rr ON rr.dataset_id=dr.dataset_id AND rr.row_id=dr.id WHERE ${whereSql}`).get(...params).n || 0);
  const rows = db.prepare(`SELECT dr.id,dr.row_number,dr.main_ticket_number,dr.similar_ticket_number,dr.main_business_group,dr.ai_route,dr.ai_judgment,dr.human_judgment,dr.similarity_score,dr.ai_confidence,dr.main_title,dr.similar_title,rr.review_status,rr.review_conclusion,rr.reviewer_id,rr.reviewer_name,rr.reviewer_username,rr.claimed_at,rr.reviewed_at,rr.updated_at FROM dataset_rows dr LEFT JOIN review_results rr ON rr.dataset_id=dr.dataset_id AND rr.row_id=dr.id WHERE ${whereSql} ORDER BY ${order} ${direction}, dr.row_number ASC LIMIT ? OFFSET ?`).all(...params, pageSize, (page - 1) * pageSize);
  res.json({ rows, page, pageSize, total, pages: Math.max(1, Math.ceil(total / pageSize)) });
});
app.get('/api/datasets/:id/rows/:rowId', authRequired, activeDataset, (req, res) => {
  const row = getRow(req.dataset.id, req.params.rowId); if (!row) return res.status(404).json({ error: '工单不存在。' });
  res.json({ row: rowView(req.dataset, row, publicReview(reviewFor(req.dataset.id, row.id)), publicDraft(draftFor(req.dataset.id, row.id))) });
});
app.post('/api/datasets/:id/rows/:rowId/claim', authRequired, activeDataset, (req, res) => {
  const row = getRow(req.dataset.id, req.params.rowId); if (!row) return res.status(404).json({ error: '工单不存在。' });
  const existing = reviewFor(req.dataset.id, row.id);
  if (existing?.review_status === 'completed' && req.user.role !== 'admin') return res.status(409).json({ error: '该工单已提交，当前为只读。' });
  if (existing?.review_status === 'in_progress' && existing.reviewer_id !== req.user.id && req.user.role !== 'admin') return res.status(409).json({ error: `该工单已由 ${existing.reviewer_name || existing.reviewer_username} 领取。`, review: publicReview(existing) });
  const timestamp = existing?.claimed_at || now();
  const reviewer = req.user;
  db.prepare(`INSERT INTO review_results(dataset_id,row_id,review_status,review_conclusion,review_note,reviewer_id,reviewer_name,reviewer_username,claimed_at,reviewed_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(dataset_id,row_id) DO UPDATE SET review_status='in_progress', reviewer_id=excluded.reviewer_id, reviewer_name=excluded.reviewer_name, reviewer_username=excluded.reviewer_username, claimed_at=COALESCE(review_results.claimed_at,excluded.claimed_at), reviewed_at=NULL, updated_at=excluded.updated_at`).run(req.dataset.id, row.id, 'in_progress', existing?.review_conclusion || null, existing?.review_note || null, reviewer.id, reviewer.display_name, reviewer.username, timestamp, null, now());
  logEvent(req.dataset.id, row.id, 'claim', req.user.id, { previous_reviewer_id: existing?.reviewer_id || null });
  res.json({ row: rowView(req.dataset, getRow(req.dataset.id, row.id), publicReview(reviewFor(req.dataset.id, row.id)), publicDraft(draftFor(req.dataset.id, row.id))) });
});
app.put('/api/datasets/:id/rows/:rowId/draft', authRequired, activeDataset, (req, res) => {
  const row = getRow(req.dataset.id, req.params.rowId); if (!row) return res.status(404).json({ error: '工单不存在。' });
  let review = reviewFor(req.dataset.id, row.id);
  if (!editableBy(req.user, review)) return res.status(403).json({ error: '请先领取该工单，或该工单已被其他人领取/提交。' });
  const conclusion = clean(req.body?.review_conclusion) || null; const note = String(req.body?.review_note ?? ''); const timestamp = now();
  db.prepare(`INSERT INTO review_drafts(dataset_id,row_id,review_conclusion,review_note,saved_by,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(dataset_id,row_id) DO UPDATE SET review_conclusion=excluded.review_conclusion, review_note=excluded.review_note, saved_by=excluded.saved_by, updated_at=excluded.updated_at`).run(req.dataset.id, row.id, conclusion, note, req.user.id, timestamp);
  db.prepare('UPDATE review_results SET review_conclusion=?, review_note=?, updated_at=? WHERE dataset_id=? AND row_id=? AND review_status=\'in_progress\'').run(conclusion, note, timestamp, req.dataset.id, row.id);
  logEvent(req.dataset.id, row.id, 'draft_save', req.user.id, { review_conclusion: conclusion });
  review = reviewFor(req.dataset.id, row.id);
  res.json({ review: publicReview(review), draft: publicDraft(draftFor(req.dataset.id, row.id)) });
});
app.post('/api/datasets/:id/rows/:rowId/submit', authRequired, activeDataset, (req, res) => {
  const row = getRow(req.dataset.id, req.params.rowId); if (!row) return res.status(404).json({ error: '工单不存在。' });
  const existing = reviewFor(req.dataset.id, row.id); if (!editableBy(req.user, existing)) return res.status(403).json({ error: '只有负责人或管理员可以提交该工单。' });
  const conclusion = clean(req.body?.review_conclusion || existing?.review_conclusion); if (!['ai_error', 'human_error', 'uncertain'].includes(conclusion)) return res.status(400).json({ error: '请选择有效的复核结论。' });
  const note = String(req.body?.review_note ?? existing?.review_note ?? ''); const timestamp = now(); const submitter = req.user;
  db.prepare(`INSERT INTO review_results(dataset_id,row_id,review_status,review_conclusion,review_note,reviewer_id,reviewer_name,reviewer_username,claimed_at,reviewed_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(dataset_id,row_id) DO UPDATE SET review_status='completed', review_conclusion=excluded.review_conclusion, review_note=excluded.review_note, reviewer_id=excluded.reviewer_id, reviewer_name=excluded.reviewer_name, reviewer_username=excluded.reviewer_username, claimed_at=COALESCE(review_results.claimed_at,excluded.claimed_at), reviewed_at=excluded.reviewed_at, updated_at=excluded.updated_at`).run(req.dataset.id, row.id, 'completed', conclusion, note, submitter.id, submitter.display_name, submitter.username, existing?.claimed_at || timestamp, timestamp, timestamp);
  db.prepare('DELETE FROM review_drafts WHERE dataset_id=? AND row_id=?').run(req.dataset.id, row.id); logEvent(req.dataset.id, row.id, 'submit', req.user.id, { review_conclusion: conclusion });
  res.json({ row: rowView(req.dataset, getRow(req.dataset.id, row.id), publicReview(reviewFor(req.dataset.id, row.id)), null) });
});
app.post('/api/datasets/:id/rows/:rowId/reopen', authRequired, adminRequired, activeDataset, (req, res) => {
  const row = getRow(req.dataset.id, req.params.rowId); if (!row) return res.status(404).json({ error: '工单不存在。' });
  db.prepare('DELETE FROM review_results WHERE dataset_id=? AND row_id=?').run(req.dataset.id, row.id); db.prepare('DELETE FROM review_drafts WHERE dataset_id=? AND row_id=?').run(req.dataset.id, row.id); logEvent(req.dataset.id, row.id, 'reopen', req.user.id, {}); res.json({ ok: true });
});


function exportedRows(datasetId) {
  const dataset = db.prepare('SELECT * FROM datasets WHERE id=?').get(datasetId);
  if (!dataset) return null;
  const sourceRows = db.prepare('SELECT * FROM dataset_rows WHERE dataset_id=? ORDER BY row_number').all(datasetId);
  return { dataset, rows: sourceRows.map((row) => { const raw = parseJson(row.data_json, {}); const review = reviewFor(datasetId, row.id); return { ...raw, review_status: review?.review_status || 'pending', review_conclusion: review?.review_conclusion || '', review_note: review?.review_note || '', reviewer_id: review?.reviewer_id || '', reviewer_name: review?.reviewer_name || '', reviewer_username: review?.reviewer_username || '', claimed_at: review?.claimed_at || '', reviewed_at: review?.reviewed_at || '' }; }) };
}
app.get('/api/datasets/:id/export.json', authRequired, activeDataset, adminRequired, (req, res) => {
  const bundle = exportedRows(req.dataset.id); if (!bundle) return res.status(404).json({ error: '批次不存在。' });
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(bundle.dataset.original_name.replace(/\.csv$/i, '') + '-review.json')}"`); res.json({ dataset: datasetView(bundle.dataset), rows: bundle.rows });
});
app.get('/api/datasets/:id/export.csv', authRequired, activeDataset, adminRequired, (req, res) => {
  const bundle = exportedRows(req.dataset.id); if (!bundle) return res.status(404).json({ error: '批次不存在。' });
  const headers = [...parseJson(bundle.dataset.headers_json, []), 'review_status', 'review_conclusion', 'review_note', 'reviewer_id', 'reviewer_name', 'reviewer_username', 'claimed_at', 'reviewed_at'];
  const body = csvText(headers, bundle.rows); res.setHeader('Content-Type', 'text/csv; charset=utf-8'); res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(bundle.dataset.original_name.replace(/\.csv$/i, '') + '-review.csv')}"`); res.send(body);
});
app.get('/api/admin/backup', authRequired, adminRequired, (req, res) => {
  db.exec('PRAGMA wal_checkpoint(TRUNCATE);'); res.download(DB_PATH, `review-backup-${new Date().toISOString().slice(0, 10)}.sqlite`);
});
app.post('/api/admin/import-legacy', authRequired, adminRequired, (req, res) => {
  try {
    const { dataset_id, rows } = req.body || {}; if (!dataset_id || !Array.isArray(rows)) throw new Error('请提供 dataset_id 和 rows 数组。');
    const dataset = db.prepare('SELECT * FROM datasets WHERE id=?').get(dataset_id); if (!dataset) throw new Error('目标批次不存在。');
    let imported = 0; const byKey = new Map(db.prepare('SELECT id,data_json FROM dataset_rows WHERE dataset_id=?').all(dataset_id).map((r) => { const d = parseJson(r.data_json, {}); return [`${keyValue(d, ['main_ticket_number','主工单号'])}|${keyValue(d, ['similar_ticket_number','关联工单号'])}`, r.id]; }));
    for (const item of rows) {
      const data = item.data || item; const key = `${keyValue(data, ['main_ticket_number','主工单号'])}|${keyValue(data, ['similar_ticket_number','关联工单号'])}`; const id = byKey.get(key); if (!id) continue;
      const conclusion = clean(item.review_conclusion || item.reviewConclusion); if (!['ai_error','human_error','uncertain'].includes(conclusion)) continue;
      const note = String(item.review_note || item.reviewNote || ''); const timestamp = item.reviewed_at || now(); const reviewerName = item.reviewer_name || '离线导入'; const reviewerUsername = item.reviewer_username || 'legacy-import';
      db.prepare(`INSERT INTO review_results(dataset_id,row_id,review_status,review_conclusion,review_note,reviewer_id,reviewer_name,reviewer_username,claimed_at,reviewed_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(dataset_id,row_id) DO UPDATE SET review_status='completed', review_conclusion=excluded.review_conclusion, review_note=excluded.review_note, reviewer_name=excluded.reviewer_name, reviewer_username=excluded.reviewer_username, reviewed_at=excluded.reviewed_at, updated_at=excluded.updated_at`).run(dataset_id, id, 'completed', conclusion, note, req.user.id, reviewerName, reviewerUsername, item.claimed_at || timestamp, timestamp, now());
      logEvent(dataset_id, id, 'legacy_import', req.user.id, { source: 'offline' }); imported += 1;
    }
    res.json({ imported });
  } catch (error) { res.status(400).json({ error: error.message || '导入失败。' }); }
});

app.use(express.static(join(ROOT, 'public')));
app.get('/{*splat}', (req, res, next) => { if (req.path.startsWith('/api/')) return next(); res.sendFile(join(ROOT, 'public', 'index.html')); });
app.use((error, req, res, next) => { if (error?.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: `文件过大，不能超过 ${MAX_UPLOAD_MB} MB。` }); console.error(error); if (res.headersSent) return next(error); res.status(500).json({ error: '服务端发生错误，请查看日志。' }); });
const server = app.listen(PORT, HOST, () => console.log(`Fault ticket review service listening on http://${HOST}:${PORT}`));
function shutdown() { try { server.close(); db.close(); } finally { process.exit(0); } }
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);

app.get('/api/datasets/:id/facets', authRequired, activeDataset, (req, res) => {
  const datasetId = req.dataset.id;
  const distinct = (field) => db.prepare('SELECT DISTINCT '+field+' AS value FROM dataset_rows WHERE dataset_id=? AND '+field+" IS NOT NULL AND "+field+"<>'' ORDER BY value").all(datasetId).map(x=>x.value);
  const reviewers = db.prepare("SELECT CASE WHEN rr.reviewer_id IS NULL THEN '__unassigned__' ELSE rr.reviewer_id END AS id, CASE WHEN rr.reviewer_id IS NULL THEN '\u5F85\u9886\u53D6' ELSE COALESCE(rr.reviewer_name, rr.reviewer_username, '\u672A\u77E5\u5BA1\u6838\u4EBA') END AS name, COALESCE(rr.reviewer_username, '') AS username, COUNT(dr.id) AS count FROM dataset_rows dr LEFT JOIN review_results rr ON rr.dataset_id=dr.dataset_id AND rr.row_id=dr.id WHERE dr.dataset_id=? GROUP BY CASE WHEN rr.reviewer_id IS NULL THEN '__unassigned__' ELSE rr.reviewer_id END, CASE WHEN rr.reviewer_id IS NULL THEN '\u5F85\u9886\u53D6' ELSE COALESCE(rr.reviewer_name, rr.reviewer_username, '\u672A\u77E5\u5BA1\u6838\u4EBA') END, COALESCE(rr.reviewer_username, '') ORDER BY CASE WHEN rr.reviewer_id IS NULL THEN 1 ELSE 0 END, name").all(datasetId);
  const originalCounts = new Map();
  db.prepare('SELECT data_json FROM dataset_rows WHERE dataset_id=?').all(datasetId).forEach((row) => { const name = originalReviewerForData(parseJson(row.data_json, {})) || '__unassigned__'; originalCounts.set(name, (originalCounts.get(name) || 0) + 1); });
  const original_reviewers = [...originalCounts.entries()].map(([id, count]) => ({ id, name: id === '__unassigned__' ? '未填写' : id, count })).sort((a, b) => Number(a.id === '__unassigned__') - Number(b.id === '__unassigned__') || a.name.localeCompare(b.name, 'zh-CN'));
  res.json({ ai_judgment: distinct('ai_judgment'), human_judgment: distinct('human_judgment'), business_group: distinct('main_business_group'), ai_route: distinct('ai_route'), reviewers, original_reviewers });
});
app.post('/api/datasets/:id/rows/:rowId/assign', authRequired, adminRequired, activeDataset, (req, res) => {
  const row = getRow(req.dataset.id, req.params.rowId); if (!row) return res.status(404).json({ error: '工单不存在。' });
  const user = db.prepare("SELECT * FROM users WHERE id=? AND status='active'").get(req.body?.user_id); if (!user) return res.status(400).json({ error: '目标复核人不存在或未启用。' });
  const timestamp = now(); const previous = reviewFor(req.dataset.id, row.id);
  db.prepare(`INSERT INTO review_results(dataset_id,row_id,review_status,review_conclusion,review_note,reviewer_id,reviewer_name,reviewer_username,claimed_at,reviewed_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(dataset_id,row_id) DO UPDATE SET review_status=CASE WHEN review_results.review_status='completed' THEN review_results.review_status ELSE 'in_progress' END, reviewer_id=excluded.reviewer_id, reviewer_name=excluded.reviewer_name, reviewer_username=excluded.reviewer_username, claimed_at=COALESCE(review_results.claimed_at,excluded.claimed_at), updated_at=excluded.updated_at`).run(req.dataset.id,row.id,previous?.review_status||'in_progress',previous?.review_conclusion||null,previous?.review_note||null,user.id,user.display_name,user.username,previous?.claimed_at||timestamp,previous?.reviewed_at||null,timestamp);
  logEvent(req.dataset.id,row.id,'assign',req.user.id,{assigned_to:user.id}); res.json({ ok:true, review:publicReview(reviewFor(req.dataset.id,row.id)) });
});
