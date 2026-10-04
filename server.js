/**
 * SJK全球特殊保护组织 - 多人协同服务器
 * 技术栈: Express + Socket.IO + SQLite
 * 
 * 功能: 实时聊天、论坛、任务系统、消息系统
 * 启动: npm install && npm start
 */

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const Database = require('better-sqlite3');
const path = require('path');
const cors = require('cors');

const PORT = process.env.PORT || 3000;
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ==================== 数据库初始化 ====================
const db = new Database(path.join(__dirname, 'sjk.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    display_name TEXT NOT NULL,
    password TEXT NOT NULL,
    role TEXT DEFAULT 'user',
    area TEXT DEFAULT '',
    level INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    author_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    likes INTEGER DEFAULT 0,
    is_announce INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (author_id) REFERENCES accounts(id)
  );

  CREATE TABLE IF NOT EXISTS comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id INTEGER NOT NULL,
    author_id INTEGER NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (post_id) REFERENCES posts(id),
    FOREIGN KEY (author_id) REFERENCES accounts(id)
  );

  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    author_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    reward REAL DEFAULT 0,
    deadline TEXT DEFAULT '',
    status TEXT DEFAULT 'available',
    accepted_by INTEGER,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (author_id) REFERENCES accounts(id)
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_id INTEGER NOT NULL,
    to_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    content TEXT DEFAULT '',
    urgent INTEGER DEFAULT 0,
    read INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (from_id) REFERENCES accounts(id),
    FOREIGN KEY (to_id) REFERENCES accounts(id)
  );

  CREATE TABLE IF NOT EXISTS chat_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel TEXT NOT NULL DEFAULT '总部频道',
    author_id INTEGER NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (author_id) REFERENCES accounts(id)
  );

  CREATE TABLE IF NOT EXISTS announcements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content TEXT NOT NULL,
    updated_by INTEGER,
    updated_at TEXT DEFAULT (datetime('now'))
  );
`);

// 插入默认管理员（如果不存在）
const adminExists = db.prepare('SELECT id FROM accounts WHERE username = ?').get('admin');
if (!adminExists) {
  db.prepare('INSERT INTO accounts (username, display_name, password, role, area, level) VALUES (?, ?, ?, ?, ?, ?)')
    .run('admin', '管理员', '00000', 'admin', '总部', 5);
  db.prepare('INSERT INTO accounts (username, display_name, password, role, area, level) VALUES (?, ?, ?, ?, ?, ?)')
    .run('user1', '测试员', '123456', 'user', '华东', 1);
  console.log('[DB] 默认账号已创建: admin/00000, user1/123456');
}

// 插入默认公告
const annExists = db.prepare('SELECT id FROM announcements LIMIT 1').get();
if (!annExists) {
  db.prepare('INSERT INTO announcements (content) VALUES (?)')
    .run('⚠ 警报：亚洲区第三号鬼域持续扩大，所有人员做好应对准备。');
}

// 在线用户追踪
const onlineUsers = new Map(); // socketId -> { userId, userName }

// ==================== REST API ====================

// 登录
app.post('/api/login', (req, res) => {
  const { employee_id, password } = req.body;
  if (!employee_id || !password) return res.json({ ok: false, msg: '请输入工号和密码' });

  const user = db.prepare('SELECT * FROM accounts WHERE username = ?').get(employee_id);
  if (!user) return res.json({ ok: false, msg: '该账号不存在' });
  if (user.password !== password) return res.json({ ok: false, msg: '密码错误' });

  res.json({ ok: true, user: { id: user.id, username: user.username, display_name: user.display_name, role: user.role, area: user.area, level: user.level } });
});

// 注册
app.post('/api/register', (req, res) => {
  const { username, display_name, password, area } = req.body;
  if (!username || !display_name || !password) return res.json({ ok: false, msg: '请填写完整' });
  if (username.length < 3) return res.json({ ok: false, msg: '用户名至少3位' });

  try {
    const maxUser = db.prepare('SELECT username FROM accounts ORDER BY id DESC LIMIT 1').get();
    let nextNum = 1;
    if (maxUser && maxUser.username.startsWith('user')) {
      nextNum = parseInt(maxUser.username.replace('user', '')) + 1;
    }
    const empId = 'user' + nextNum;

    const result = db.prepare('INSERT INTO accounts (username, display_name, password, role, area) VALUES (?, ?, ?, ?, ?)')
      .run(empId, display_name, password, 'user', area || '');
    res.json({ ok: true, employee_id: empId, user: { id: result.lastInsertRowid, username: empId, display_name, role: 'user', area, level: 1 } });
  } catch (e) {
    res.json({ ok: false, msg: '显示名已存在' });
  }
});

// 获取用户列表
app.get('/api/users', (req, res) => {
  const users = db.prepare('SELECT id, username, display_name, role, area, level FROM accounts').all();
  res.json(users);
});

// ==================== 论坛 API ====================
app.get('/api/posts', (req, res) => {
  const posts = db.prepare(`
    SELECT p.*, a.display_name as author_name, a.area as author_area,
    (SELECT COUNT(*) FROM comments WHERE post_id = p.id) as comment_count
    FROM posts p JOIN accounts a ON p.author_id = a.id
    ORDER BY p.is_announce DESC, p.created_at DESC
  `).all();
  res.json(posts);
});

app.post('/api/posts', (req, res) => {
  const { author_id, title, content, is_announce } = req.body;
  if (!author_id || !title || !content) return res.json({ ok: false, msg: '请填写标题和内容' });
  const result = db.prepare('INSERT INTO posts (author_id, title, content, is_announce) VALUES (?, ?, ?, ?)').run(author_id, title, content, is_announce ? 1 : 0);
  res.json({ ok: true, id: result.lastInsertRowid });
});

app.delete('/api/posts/:id', (req, res) => {
  db.prepare('DELETE FROM comments WHERE post_id = ?').run(req.params.id);
  db.prepare('DELETE FROM posts WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

app.get('/api/posts/:id/comments', (req, res) => {
  const comments = db.prepare(`
    SELECT c.*, a.display_name as author_name
    FROM comments c JOIN accounts a ON c.author_id = a.id
    WHERE c.post_id = ? ORDER BY c.created_at ASC
  `).all(req.params.id);
  res.json(comments);
});

app.post('/api/posts/:id/comments', (req, res) => {
  const { author_id, content } = req.body;
  if (!author_id || !content) return res.json({ ok: false, msg: '请填写评论' });
  db.prepare('INSERT INTO comments (post_id, author_id, content) VALUES (?, ?, ?)').run(req.params.id, author_id, content);
  io.emit('post_updated');
  res.json({ ok: true });
});

// ==================== 任务 API ====================
app.get('/api/tasks', (req, res) => {
  const tasks = db.prepare(`
    SELECT t.*, a.display_name as author_name,
    CASE WHEN t.accepted_by IS NOT NULL THEN (SELECT display_name FROM accounts WHERE id = t.accepted_by) ELSE NULL END as accepted_name
    FROM tasks t JOIN accounts a ON t.author_id = a.id
    ORDER BY t.created_at DESC
  `).all();
  res.json(tasks);
});

app.post('/api/tasks', (req, res) => {
  const { author_id, name, description, reward, deadline } = req.body;
  if (!author_id || !name) return res.json({ ok: false, msg: '请输入任务名称' });
  const result = db.prepare('INSERT INTO tasks (author_id, name, description, reward, deadline) VALUES (?, ?, ?, ?, ?)').run(author_id, name, description || '', reward || 0, deadline || '');
  res.json({ ok: true, id: result.lastInsertRowid });
});

app.post('/api/tasks/:id/accept', (req, res) => {
  const { user_id } = req.body;
  db.prepare('UPDATE tasks SET status = ?, accepted_by = ? WHERE id = ?').run('accepted', user_id, req.params.id);
  io.emit('task_updated');
  res.json({ ok: true });
});

app.delete('/api/tasks/:id', (req, res) => {
  db.prepare('DELETE FROM tasks WHERE id = ?').run(req.params.id);
  io.emit('task_updated');
  res.json({ ok: true });
});

// ==================== 消息 API ====================
app.get('/api/messages/inbox/:userId', (req, res) => {
  const msgs = db.prepare(`
    SELECT m.*, a.display_name as from_name
    FROM messages m JOIN accounts a ON m.from_id = a.id
    WHERE m.to_id = ? ORDER BY m.created_at DESC
  `).all(req.params.userId);
  res.json(msgs);
});

app.get('/api/messages/outbox/:userId', (req, res) => {
  const msgs = db.prepare(`
    SELECT m.*, a.display_name as to_name
    FROM messages m JOIN accounts a ON m.to_id = a.id
    WHERE m.from_id = ? ORDER BY m.created_at DESC
  `).all(req.params.userId);
  res.json(msgs);
});

app.post('/api/messages', (req, res) => {
  const { from_id, to_ids, title, content, urgent } = req.body;
  if (!from_id || !to_ids || !to_ids.length || !title) return res.json({ ok: false, msg: '请填写完整' });
  to_ids.forEach(toId => {
    db.prepare('INSERT INTO messages (from_id, to_id, title, content, urgent) VALUES (?, ?, ?, ?, ?)')
      .run(from_id, toId, title, content || '', urgent ? 1 : 0);
  });
  io.emit('message_updated');
  res.json({ ok: true });
});

app.post('/api/messages/read/:id', (req, res) => {
  db.prepare('UPDATE messages SET read = 1 WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

app.get('/api/messages/unread/:userId', (req, res) => {
  const result = db.prepare('SELECT COUNT(*) as count FROM messages WHERE to_id = ? AND read = 0').get(req.params.userId);
  res.json({ count: result.count });
});

// ==================== 公告 API ====================
app.get('/api/announcement', (req, res) => {
  const ann = db.prepare('SELECT * FROM announcements ORDER BY id DESC LIMIT 1').get();
  res.json(ann || { content: '⚠ 暂无公告' });
});

app.post('/api/announcement', (req, res) => {
  const { content, updated_by } = req.body;
  db.prepare('INSERT INTO announcements (content, updated_by) VALUES (?, ?)').run(content, updated_by);
  io.emit('announcement_updated');
  res.json({ ok: true });
});

// ==================== 频道列表 ====================
const CHANNELS = ['总部频道','亚洲区频道','华北区频道','华南区频道','任务讨论频道','装备交流频道'];
app.get('/api/channels', (req, res) => { res.json(CHANNELS); });

app.get('/api/channels/:channel/messages', (req, res) => {
  const msgs = db.prepare(`
    SELECT c.*, a.display_name as author_name, a.level as author_level, a.area as author_area
    FROM chat_messages c JOIN accounts a ON c.author_id = a.id
    WHERE c.channel = ? ORDER BY c.created_at DESC LIMIT 100
  `).all(req.params.channel).reverse();
  res.json(msgs);
});

// ==================== Socket.IO 实时通信 ====================
io.on('connection', (socket) => {
  console.log('[WS] 连接:', socket.id);

  socket.on('join', (data) => {
    onlineUsers.set(socket.id, { userId: data.userId, userName: data.userName });
    io.emit('online_count', onlineUsers.size);
    console.log('[WS] 加入:', data.userName);
  });

  socket.on('chat_message', (data) => {
    const result = db.prepare('INSERT INTO chat_messages (channel, author_id, content) VALUES (?, ?, ?)')
      .run(data.channel || '总部频道', data.author_id, data.content);
    const msg = db.prepare(`
      SELECT c.*, a.display_name as author_name, a.level as author_level, a.area as author_area
      FROM chat_messages c JOIN accounts a ON c.author_id = a.id WHERE c.id = ?
    `).get(result.lastInsertRowid);
    io.emit('chat_message', msg);
  });

  socket.on('disconnect', () => {
    onlineUsers.delete(socket.id);
    io.emit('online_count', onlineUsers.size);
    console.log('[WS] 断开:', socket.id);
  });
});

// ==================== 启动 ====================
server.listen(PORT, () => {
  console.log(`\n========================================`);
  console.log(`  SJK全球特殊保护组织 - 服务器已启动`);
  console.log(`  地址: http://localhost:${PORT}`);
  console.log(`  数据库: sjk.db`);
  console.log(`========================================\n`);
});
