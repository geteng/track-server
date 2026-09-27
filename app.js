const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const intentEngine = require('./intent-engine');
const dataLevels = require('./data-levels');
const createMpApi = require('./mp-api');
const partnerAuth = require('./partner-auth');
const createAiApi = require('./ai-api');

const app = express();
const PORT = 3000;

/* ============ 中间件 ============ */
app.use(cors());
/* ============ 上报体格式容错中间件 ============
   背景：部分客户端（小程序 uploadFile / H5 FormData / 部分 SDK）会用
   multipart/form-data 或 application/x-www-form-urlencoded 上报埋点，
   而下面那行 json 中间件把 type 配成了通配符，会对所有 content-type 强行 JSON.parse，
   遇到 "------WebKitFormBoundary..." 直接抛 SyntaxError 返回 400，
   导致这部分埋点一条都进不了库（线上实测约占上报量的 1/5）。
   做法：json 中间件之前先识别这两种格式并自行宽松解析，写回 req.body；
        其余格式（application/json、text/plain 等）原样交给 express.json。 */
function parseLooseFormBody(raw, contentType) {
  const ctLower = String(contentType).toLowerCase(); // 类型判断用小写
  // 1) x-www-form-urlencoded：a=1&b=2
  if (ctLower.indexOf('application/x-www-form-urlencoded') === 0) {
    const out = {};
    new URLSearchParams(raw).forEach((v, k) => { out[k] = v; });
    return out;
  }
  // 2) multipart/form-data：按 boundary 切段，取每段 name="xxx" 对应的值
  const bm = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  if (bm) {
    const boundary = '--' + (bm[1] || bm[2]).trim();
    const out = {};
    raw.split(boundary).forEach((part) => {
      if (!part || part.replace(/[\r\n-]/g, '') === '') return;
      const sep = part.indexOf('\r\n\r\n');
      if (sep < 0) return;
      const nm = /name="([^"]+)"/i.exec(part.slice(0, sep));
      if (!nm) return;
      out[nm[1]] = part.slice(sep + 4).replace(/\r\n$/, '').trim();
    });
    return out;
  }
  // 3) 兜底：既无 boundary 也不是标准格式，按 querystring 尽力解析
  const out = {};
  try {
    new URLSearchParams(raw).forEach((v, k) => { out[k] = v; });
  } catch (_) { /* 解析不了就返回空对象，交由路由判断缺字段 */ }
  return out;
}

app.use((req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  const rawCt = String(req.headers['content-type'] || '');
  const ct = rawCt.toLowerCase(); // boundary 大小写敏感，判断用小写、提取用原始值
  if (ct.indexOf('multipart/form-data') !== 0 && ct.indexOf('application/x-www-form-urlencoded') !== 0) {
    return next(); // 交给 express.json 处理
  }
  const chunks = [];
  let size = 0;
  let tooBig = false;
  req.on('data', (chunk) => {
    size += chunk.length;
    if (size > 256 * 1024) { tooBig = true; chunks.length = 0; return; } // 超限后只丢弃不再缓存，避免撑大内存
    chunks.push(chunk);
  });
  req.on('end', () => {
    if (tooBig) return res.status(413).json({ code: -1, msg: '请求体过大（上限 256KB）' });
    try {
      req.body = parseLooseFormBody(Buffer.concat(chunks).toString('utf8'), rawCt);
    } catch (e) {
      console.warn('⚠️ 宽松解析上报体失败:', e.message);
      req.body = {};
    }
    req.__looseParsed = true; // 告知下游 json 中间件：请求流已被消费，别再读一次
    next();
  });
  req.on('error', next);
});

// type:'*/*' 确保 sendBeacon 传字符串(text/plain)也能解析。
// 注意：正因为 type 是通配符，若不对已接手的请求放行，它会二次读取已被消费的流而报
// "stream is not readable"，所以这里按 __looseParsed 标记决定是否跳过。
const jsonParser = express.json({ limit: '100kb', type: '*/*' });
app.use((req, res, next) => {
  if (req.__looseParsed) return next();
  return jsonParser(req, res, next);
});

// 请求日志
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} | ${req.method} | ${req.url} | ${req.ip}`);
  next();
});

/* ---- 登录态：解析 HttpOnly 会话 Cookie，挂到 req.session（未登录为 null） ---- */
app.use(partnerAuth.attachSession);

/* ---- 业务数据接口一律要求登录会话（埋点上报 /api/track 保持公开） ----
   角色只来自登录态，不再读取 URL 上的 role 参数，避免越权 */
app.use(['/api/intent', '/api/follow-ups', '/api/consent'], partnerAuth.requireAuth);
/* 行为日志为 L0 / L1 原始明细，仅开发者视角可读取 */
app.use('/api/behavior-log', partnerAuth.requireAuth, partnerAuth.requireRole('developer'));

/* ============ 初始化 SQLite ============ */
const db = new sqlite3.Database('./track.db', (err) => {
  if (err) {
    console.error('数据库连接失败:', err.message);
    process.exit(1);
  }
  console.log('✅ 数据库连接成功 (track.db)');
});

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS behavior_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    aid         TEXT,
    uid         TEXT,
    event       TEXT,
    url         TEXT,
    referrer    TEXT,
    timestamp   INTEGER,
    userAgent   TEXT,
    screen      TEXT,
    eventMsg    TEXT,
    level       TEXT,
    extra       TEXT,
    userName    TEXT
  )`);
  // 兼容旧表：若缺少 uid / eventMsg / level 列则自动补加；补加完成后再建索引 + 回填，避免重启报错
  db.all(`PRAGMA table_info(behavior_log)`, (err, cols) => {
    if (err) return;
    const names = (cols || []).map(c => c.name);
    const tasks = [];
    if (!names.includes('uid')) tasks.push(`ALTER TABLE behavior_log ADD COLUMN uid TEXT`);
    if (!names.includes('eventMsg')) tasks.push(`ALTER TABLE behavior_log ADD COLUMN eventMsg TEXT`);
    if (!names.includes('level')) tasks.push(`ALTER TABLE behavior_log ADD COLUMN level TEXT`);
    if (!names.includes('userName')) tasks.push(`ALTER TABLE behavior_log ADD COLUMN userName TEXT`);
    let i = 0;
    const step = () => {
      if (i < tasks.length) return db.run(tasks[i++], step);
      db.run(`CREATE INDEX IF NOT EXISTS idx_bl_ts     ON behavior_log(timestamp)`);
      db.run(`CREATE INDEX IF NOT EXISTS idx_bl_aid    ON behavior_log(aid)`);
      db.run(`CREATE INDEX IF NOT EXISTS idx_bl_uid    ON behavior_log(uid)`);
      db.run(`CREATE INDEX IF NOT EXISTS idx_bl_event  ON behavior_log(event)`);
      db.run(`CREATE INDEX IF NOT EXISTS idx_bl_level  ON behavior_log(level)`, () => backfillLevels());
    };
    step();
  });

  // 预约跟进任务表（销售工作台）
  db.run(`CREATE TABLE IF NOT EXISTS follow_up (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    user_key      TEXT,
    display_name  TEXT,
    plan_time     TEXT,
    note          TEXT,
    status        TEXT DEFAULT 'pending',   -- pending / done / canceled
    created_at    INTEGER,
    updated_at    INTEGER
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_fu_status ON follow_up(status)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_fu_key    ON follow_up(user_key)`);
  // 兼容旧表：若缺少 owner 列则自动补加，避免重启报错
  db.all(`PRAGMA table_info(follow_up)`, (err, cols) => {
    if (err) return;
    const names = (cols || []).map(c => c.name);
    if (!names.includes('owner')) db.run(`ALTER TABLE follow_up ADD COLUMN owner TEXT`);
  });

  // 用户授权表（依据《用户行为追踪边界规范》渐进式授权）
  // L3 兴趣画像需要用户授权后 CA 才可见；授权可设有效期（7 天 / 30 天 / 长期）
  db.run(`CREATE TABLE IF NOT EXISTS user_consent (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_key    TEXT,
    scope       TEXT,                 -- 授权范围，如 'L3'
    granted     INTEGER DEFAULT 0,    -- 1 授权 / 0 拒绝或未授权
    duration    TEXT,                 -- '7d' / '30d' / 'long'
    source      TEXT,                 -- 触发来源，如 'collect_look'（收藏后触发的授权）
    granted_at  INTEGER,
    expires_at  INTEGER,              -- 到期时间戳，long 为过大值
    updated_at  INTEGER
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_uc_key   ON user_consent(user_key)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_uc_scope ON user_consent(scope)`);
});

/* ============ 工具函数 ============ */

// UA 解析
function parseUA(ua) {
  if (!ua) return { device: 'Unknown', os: 'Unknown', browser: 'Unknown', browserVersion: '', isCrawler: false };
  let device = 'PC', os = 'Unknown', browser = 'Unknown', browserVersion = '';

  if (/iPhone|iPad|iPod/i.test(ua)) {
    device = /iPad/i.test(ua) ? 'Tablet' : 'Mobile';
    os = 'iOS';
    const m = ua.match(/OS (\d+[._]\d+)/);
    if (m) browserVersion = m[1].replace('_', '.');
  } else if (/Android/i.test(ua)) {
    device = /Mobile/i.test(ua) ? 'Mobile' : 'Tablet';
    os = 'Android';
    const m = ua.match(/Android (\d+[._]\d+)/);
    if (m) browserVersion = m[1].replace('_', '.');
  } else if (/Mac OS X/i.test(ua)) {
    os = 'macOS';
  } else if (/Windows/i.test(ua)) {
    os = 'Windows';
  } else if (/Linux/i.test(ua)) {
    os = 'Linux';
  }

  if (/Edg\//i.test(ua)) {
    browser = 'Edge';
    const m = ua.match(/Edg\/(\d+)/);
    if (m) browserVersion = m[1];
  } else if (/Chrome\//i.test(ua) && !/Chromium/i.test(ua)) {
    browser = 'Chrome';
    const m = ua.match(/Chrome\/(\d+)/);
    if (m) browserVersion = m[1];
  } else if (/Firefox\//i.test(ua)) {
    browser = 'Firefox';
    const m = ua.match(/Firefox\/(\d+)/);
    if (m) browserVersion = m[1];
  } else if (/Safari\//i.test(ua) && !/Chrome/i.test(ua)) {
    browser = 'Safari';
    const m = ua.match(/Version\/(\d+)/);
    if (m) browserVersion = m[1];
  }

  const isCrawler = /bot|crawler|spider|crawling|scrap|slurp|baidu|googlebot|bingbot|yandex|semrush|ahref/i.test(ua);
  return { device, os, browser, browserVersion, isCrawler };
}

// 格式化时间戳
function formatTs(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * 对齐历史数据的层级（启动时执行一次，幂等）
 * ① 回填 level 为空的行；
 * ② 修正与 v0.3 权威层级表不一致的行 —— 否则 CA 端可见性会按旧值判断：
 *    存成 L2 的浏览类事件会泄漏给 CA，存成 L0 的主动动作会让 CA 看不到。
 */
function backfillLevels() {
  db.all(`SELECT id, event FROM behavior_log WHERE level IS NULL OR level = ''`, [], (err, rows) => {
    if (!err && rows && rows.length) {
      const stmt = db.prepare(`UPDATE behavior_log SET level = ? WHERE id = ?`);
      rows.forEach((r) => stmt.run(dataLevels.levelOf(r.event), r.id));
      stmt.finalize(() => console.log(`🔖 已回填 ${rows.length} 条缺失层级的历史数据`));
    }

    const map = dataLevels.EVENT_LEVEL;
    const events = Object.keys(map);
    if (!events.length) return;
    let fixed = 0;
    db.serialize(() => {
      db.run('BEGIN');
      const up = db.prepare(`UPDATE behavior_log SET level = ? WHERE event = ? AND level IS NOT ?`);
      events.forEach((e) => {
        up.run(map[e], e, map[e], function () { fixed += this.changes || 0; });
      });
      up.finalize(() => {
        db.run('COMMIT', () => {
          if (fixed) console.log(`🔖 已按 v0.3 层级表修正 ${fixed} 条历史数据的层级`);
        });
      });
    });
  });
}

// 解析请求角色：只信任登录态（由 partner_access.role 映射而来），
// 不再读取 query / body 中的 role 参数，改 URL 无法扩大权限；
// 这些接口已被 requireAuth 拦截，兜底取最小权限 CA
function resolveRole(req) {
  const role = req.session && req.session.role;
  return dataLevels.ROLES[role] ? role : dataLevels.DEFAULT_ROLE;
}

// 按角色裁剪用户数据：CA 不可见被动行为（L1）派生的字段，只保留主动动作与结论
function sanitizeUserForRole(u, role) {
  if (dataLevels.roleConfig(role).rawDetail) return u; // 开发者 / 老板娘 可见原始数据
  const clone = { ...u };
  clone.viewedSkus = 0;            // 浏览商品数（L1 被动行为）不对 CA 暴露
  clone.behaviorCount = 0;         // 行为总数含被动行为，CA 不展示
  clone.scoreDetails = [];         // 评分明细含被动行为，CA 不展示
  return clone;
}

/* ============ 基础接口 ============ */

// 健康检查
app.get('/api/health', (req, res) => {
  res.json({ code: 0, msg: 'ok', service: 'h5-track-server', time: Date.now() });
});

// 埋点接收（每条上报都必须带「数据权限层级」level，未带则按事件自动推导）
app.post('/api/track', (req, res) => {
  const data = req.body;
  if (!data || !data.event) {
    return res.status(400).json({ code: -1, msg: '字段缺失: event' });
  }
  // 层级：优先使用上报方传入的 level，非法则按事件推导，保证「每个上报都有层级」
  const level = dataLevels.isValidLevel(data.level) ? data.level : dataLevels.levelOf(data.event);

  // extra：宽松解析后的表单值已经是字符串，不必再 stringify 一次（否则会被额外包一层引号）
  const extra = typeof data.extra === 'string' ? data.extra : JSON.stringify(data.extra || {});
  // userName：兼容端上可能使用的几种命名（nickName 来自小程序 getUserProfile 的常见写法）
  const userName = data.userName || data.username || data.nickName || data.nickname || '';
  const insertSql = `INSERT INTO behavior_log (aid, uid, event, url, referrer, timestamp, userAgent, screen, eventMsg, level, extra, userName) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
  const params = [
    data.aid || 'unknown',
    data.uid || '',
    data.event,
    data.url || '',
    data.referrer || '',
    data.timestamp || Date.now(),
    data.userAgent || req.get('User-Agent') || '',
    data.screen || '',
    data.eventMsg || '',
    level,
    extra,
    userName
  ];
  db.run(insertSql, params, (err) => {
    if (err) console.error('❌ 写入失败:', err.message);
    else console.log(`📝 埋点: aid=${data.aid || 'unknown'} uid=${data.uid || '-'} event=${data.event} level=${level}${userName ? ' user=' + userName : ''}`);
  });
  res.status(200).json({ code: 0, msg: 'ok', level });
});

// 数据层级 / 角色定义（供前端渲染权限切换使用）
app.get('/api/levels', (req, res) => {
  res.json({
    code: 0,
    data: {
      levels: dataLevels.LEVELS,
      levelOrder: dataLevels.LEVEL_ORDER,
      roles: dataLevels.ROLES,
      defaultRole: dataLevels.DEFAULT_ROLE,
    },
  });
});

// 旧版查询（保留兼容）
app.get('/api/list', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 100, 500);
  const offset = parseInt(req.query.offset) || 0;
  const aid = req.query.aid;
  let sql = 'SELECT * FROM behavior_log';
  let params = [];
  if (aid) { sql += ' WHERE aid = ?'; params.push(aid); }
  sql += ' ORDER BY timestamp DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);
  db.all(sql, params, (err, rows) => {
    if (err) return res.status(500).json({ code: -1, msg: err.message });
    res.json({ code: 0, count: rows.length, data: rows });
  });
});

// 旧版统计（保留兼容）
app.get('/api/stats', (req, res) => {
  db.all(`SELECT COUNT(*) AS total, COUNT(DISTINCT aid) AS uniqueUsers, COUNT(DISTINCT event) AS eventTypes FROM behavior_log`, [], (err, rows) => {
    if (err) return res.status(500).json({ code: -1, msg: err.message });
    db.all(`SELECT event, COUNT(*) AS count FROM behavior_log GROUP BY event ORDER BY count DESC`, [], (err2, rows2) => {
      if (err2) return res.status(500).json({ code: -1, msg: err2.message });
      res.json({ code: 0, data: { ...rows[0], eventBreakdown: rows2 } });
    });
  });
});

app.get('/api/stats/app', (req, res) => {
  db.all(`SELECT aid, COUNT(*) AS count, COUNT(DISTINCT event) AS eventTypes, MAX(timestamp) AS lastActive FROM behavior_log GROUP BY aid ORDER BY count DESC`, [], (err, rows) => {
    if (err) return res.status(500).json({ code: -1, msg: err.message });
    res.json({ code: 0, data: rows });
  });
});

/* ============ Dashboard 专用接口 ============ */

// 日志分页查询（含筛选 + 统计）
app.get('/api/behavior-log/list', (req, res) => {
  const page = Math.max(parseInt(req.query.page) || 1, 1);
  const size = Math.min(Math.max(parseInt(req.query.size) || 20, 1), 100);
  const { startTime, endTime, event, aid, uid, url, referrer, level } = req.query;

  let where = [];
  let params = [];

  // 数据权限层级过滤：默认「开发者」可见全部层级，其它角色按 allowedLevels 收敛
  const role = resolveRole(req, 'developer');
  const allowed = dataLevels.allowedLevelsFor(role);
  where.push(`level IN (${dataLevels.placeholders(allowed)})`);
  params.push(...allowed);

  if (level && dataLevels.isValidLevel(level) && allowed.includes(level)) { where.push('level = ?'); params.push(level); }
  if (startTime) { where.push('timestamp >= ?'); params.push(parseInt(startTime)); }
  if (endTime) { where.push('timestamp <= ?'); params.push(parseInt(endTime)); }
  if (event) { where.push('event = ?'); params.push(event); }
  if (aid) { where.push('aid = ?'); params.push(aid); }
  if (uid) { where.push('uid = ?'); params.push(uid); }
  if (url) { where.push('url LIKE ?'); params.push(`%${url}%`); }
  if (referrer) { where.push('referrer LIKE ?'); params.push(`%${referrer}%`); }

  const whereClause = where.length > 0 ? 'WHERE ' + where.join(' AND ') : '';
  const offset = (page - 1) * size;

  // 查询列表
  const listSql = `SELECT * FROM behavior_log ${whereClause} ORDER BY timestamp DESC LIMIT ? OFFSET ?`;
  const listParams = [...params, size, offset];

  db.all(listSql, listParams, (err, rows) => {
    if (err) return res.status(500).json({ code: -1, msg: err.message });

    // 查询总数
    db.get(`SELECT COUNT(*) AS total FROM behavior_log ${whereClause}`, params, (err2, countRow) => {
      if (err2) return res.status(500).json({ code: -1, msg: err2.message });

      // 统计信息
      const statsSql = `SELECT
        COUNT(*) AS total,
        COUNT(DISTINCT aid) AS uniqueUsers,
        SUM(CASE WHEN event = 'page_view' THEN 1 ELSE 0 END) AS pvCount
        FROM behavior_log ${whereClause}`;

      db.get(statsSql, params, (err3, statsRow) => {
        if (err3) return res.status(500).json({ code: -1, msg: err3.message });

        // TOP 事件
        const topSql = `SELECT event, COUNT(*) AS count FROM behavior_log ${whereClause} GROUP BY event ORDER BY count DESC LIMIT 5`;
        db.all(topSql, params, (err4, topRows) => {
          if (err4) return res.status(500).json({ code: -1, msg: err4.message });

          // 按小时聚合（趋势图）
          const trendSql = `SELECT
            (timestamp / 3600000) * 3600000 AS hourBucket,
            COUNT(*) AS count
            FROM behavior_log ${whereClause}
            GROUP BY hourBucket
            ORDER BY hourBucket ASC`;

          db.all(trendSql, params, (err5, trendRows) => {
            if (err5) return res.status(500).json({ code: -1, msg: err5.message });

            res.json({
              code: 0,
              data: {
                list: rows,
                total: countRow.total,
                page,
                size,
                stats: {
                  total: statsRow.total,
                  uniqueUsers: statsRow.uniqueUsers,
                  pvCount: statsRow.pvCount,
                  topEvents: topRows
                },
                trend: trendRows
              }
            });
          });
        });
      });
    });
  });
});

// 事件枚举（下拉选择）
app.get('/api/behavior-log/events', (req, res) => {
  db.all(`SELECT DISTINCT event FROM behavior_log ORDER BY event ASC`, [], (err, rows) => {
    if (err) return res.status(500).json({ code: -1, msg: err.message });
    res.json({ code: 0, data: rows.map(r => r.event) });
  });
});

// 单条日志详情
app.get('/api/behavior-log/:id', (req, res) => {
  const id = parseInt(req.query.id || req.params.id);
  if (!id) return res.status(400).json({ code: -1, msg: '缺少 id 参数' });

  db.get(`SELECT * FROM behavior_log WHERE id = ?`, [id], (err, row) => {
    if (err) return res.status(500).json({ code: -1, msg: err.message });
    if (!row) return res.status(404).json({ code: -1, msg: '记录不存在' });

    let extraParsed = {};
    try { extraParsed = JSON.parse(row.extra || '{}'); } catch (e) { /* keep empty */ }

    res.json({
      code: 0,
      data: {
        ...row,
        extraParsed,
        uaParsed: parseUA(row.userAgent),
        formattedTime: formatTs(row.timestamp)
      }
    });
  });
});

/* ============ 销售工作台（Intent / Action Engine） ============ */

// 用户意图列表（3 个 Tab：hot 今日重点 / followup 待跟进 / all 全部会员）
app.get('/api/intent/users', (req, res) => {
  const tab = req.query.tab || 'hot';
  const page = Math.max(parseInt(req.query.page) || 1, 1);
  const size = Math.min(Math.max(parseInt(req.query.size) || 20, 1), 100);
  const role = resolveRole(req, 'ca');

  intentEngine.getAllUsers((err, users) => {
    if (err) return res.status(500).json({ code: -1, msg: err.message });

    // 查询待跟进任务（用于 followup Tab 和标记）
    db.all(`SELECT * FROM follow_up WHERE status = 'pending' ORDER BY created_at DESC`, [], (err2, followUps) => {
      if (err2) return res.status(500).json({ code: -1, msg: err2.message });
      const fuByUser = {};
      followUps.forEach(f => { fuByUser[f.user_key] = f; });

      let list = users.map(u => ({ ...sanitizeUserForRole(u, role), followUp: fuByUser[u.key] || null }));

      switch (tab) {
        case 'hot':     // 今日重点：今天在升温且 Priority 高
          list = list.filter(u => (u.isHeatingUp || u.todayScore > 0) && u.priority >= 40);
          break;
        case 'followup': // 待跟进：有 pending 任务
          list = list.filter(u => u.followUp);
          break;
        case 'all':     // 全部会员
        default:
          break;
      }

      // 排序键：各 Tab 均按综合优先级排序
      const sortKey = 'priority';
      list.sort((a, b) => (b[sortKey] || 0) - (a[sortKey] || 0));

      const total = list.length;
      const paged = list.slice((page - 1) * size, page * size);

      // 汇总（顶部 4 个数字）
      const summary = {
        hotUsers: users.filter(u => u.isHeatingUp && u.priority >= 40).length,                    // 今日高意向
        pendingFollowUps: followUps.length,                                                        // 待跟进任务
        contactedToday: 0,                                                                         // 已联系（由前端提交，暂为 0）
        weekConversionRate: 0,                                                                     // 本周转化
      };

      res.json({ code: 0, data: { list: paged, total, page, size, tab, role, summary } });
    });
  });
});

// 今日行动摘要（自动生成 3 件事）
app.get('/api/intent/action-summary', (req, res) => {
  intentEngine.getAllUsers((err, users) => {
    if (err) return res.status(500).json({ code: -1, msg: err.message });
    const now = Date.now();
    const DAY = 24 * 3600 * 1000;

    // 1. 今天最热的用户（正在升温）
    const hot = users.filter(u => u.isHeatingUp).sort((a, b) => b.priority - a.priority)[0];
    // 2. 加速度最大的用户
    const rising = users.filter(u => u.momentum >= 1.5 && u.todayScore > 0).sort((a, b) => b.momentum - a.momentum)[0];
    const items = [];
    if (hot) items.push({ key: hot.key, text: `【${hot.displayName}】正在升温，今日意向分 ${hot.todayScore}，综合优先级 ${hot.priority}，建议立即联系。` });
    if (rising) items.push({ key: rising.key, text: `【${rising.displayName}】加速最快（Momentum ×${rising.momentum}），近几天从低分快速上升，适合主动推送穿搭。` });
    if (!items.length) items.push({ key: '', text: '今日暂无重点用户，可在"全部会员"中浏览。' });

    res.json({ code: 0, data: { items, generatedAt: now } });
  });
});

// 用户详情（销售工作台数据）
app.get('/api/intent/user', (req, res) => {
  const key = req.query.key || req.query.uid;
  if (!key) return res.status(400).json({ code: -1, msg: '缺少 key 参数' });
  const role = resolveRole(req, 'ca');
  intentEngine.getUserDetail(key, (err, user) => {
    if (err) return res.status(500).json({ code: -1, msg: err.message });
    if (!user) return res.status(404).json({ code: -1, msg: '未找到该用户行为数据' });

    db.all(`SELECT * FROM follow_up WHERE user_key = ? ORDER BY created_at DESC`, [user.key], (err2, fus) => {
      if (err2) return res.status(500).json({ code: -1, msg: err2.message });
      // 行为时间线：仅「开发者」视角下发逐条行为明细；老板娘 / 穿搭师一律返回空数组
      // （前端对应展示「权限不足无法查看」，此处不下发数据，避免前端隐藏后仍可通过接口拿到明细）
      const data = sanitizeUserForRole(user, role);
      data.timeline = (role === 'developer' && Array.isArray(user.timeline)) ? user.timeline : [];
      res.json({ code: 0, data: { ...data, role, followUps: fus } });
    });
  });
});

// 数据层级分布（开发者视角：各层级上报量统计，其他角色 403）
app.get('/api/intent/level-stats', partnerAuth.requirePermission('debug:read'), (req, res) => {
  db.all(`SELECT level, COUNT(*) AS count FROM behavior_log GROUP BY level`, [], (err, rows) => {
    if (err) return res.status(500).json({ code: -1, msg: err.message });
    const map = {};
    rows.forEach(r => { map[r.level || 'L0'] = r.count; });
    const stats = dataLevels.LEVEL_ORDER.map(code => ({
      code,
      name: dataLevels.LEVELS[code].name,
      desc: dataLevels.LEVELS[code].desc,
      caVisible: dataLevels.LEVELS[code].caVisible,
      needConsent: dataLevels.LEVELS[code].needConsent,
      count: map[code] || 0,
    }));
    const total = rows.reduce((a, r) => a + r.count, 0);
    res.json({ code: 0, data: { total, stats } });
  });
});

// 跟进任务列表
app.get('/api/follow-ups', (req, res) => {
  const status = req.query.status || 'pending';
  const sql = status === 'all'
    ? `SELECT * FROM follow_up ORDER BY created_at DESC`
    : `SELECT * FROM follow_up WHERE status = ? ORDER BY created_at DESC`;
  const params = status === 'all' ? [] : [status];
  db.all(sql, params, (err, rows) => {
    if (err) return res.status(500).json({ code: -1, msg: err.message });
    res.json({ code: 0, data: rows });
  });
});

// 创建跟进任务
app.post('/api/follow-ups', (req, res) => {
  const { user_key, display_name, plan_time, note, owner } = req.body || {};
  if (!user_key) return res.status(400).json({ code: -1, msg: '缺少 user_key' });
  const now = Date.now();
  db.run(
    `INSERT INTO follow_up (user_key, display_name, plan_time, note, owner, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
    [user_key, display_name || '', plan_time || '', note || '', owner || '', now, now],
    function (err) {
      if (err) return res.status(500).json({ code: -1, msg: err.message });
      res.json({ code: 0, msg: 'ok', data: { id: this.lastID } });
    }
  );
});

// 更新跟进任务状态（done / canceled）
app.post('/api/follow-ups/:id/status', (req, res) => {
  const id = parseInt(req.params.id);
  const { status } = req.body || {};
  if (!id || !['done', 'canceled'].includes(status)) return res.status(400).json({ code: -1, msg: '参数错误' });
  db.run(`UPDATE follow_up SET status = ?, updated_at = ? WHERE id = ?`, [status, Date.now(), id], (err) => {
    if (err) return res.status(500).json({ code: -1, msg: err.message });
    res.json({ code: 0, msg: 'ok' });
  });
});

// 删除跟进任务
app.delete('/api/follow-ups/:id', (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ code: -1, msg: '参数错误' });
  db.run(`DELETE FROM follow_up WHERE id = ?`, [id], (err) => {
    if (err) return res.status(500).json({ code: -1, msg: err.message });
    res.json({ code: 0, msg: 'ok' });
  });
});

/* ============ 用户授权（渐进式授权） ============ */

// 查询某用户的 L3 画像授权状态
app.get('/api/consent', (req, res) => {
  const userKey = req.query.user_key;
  if (!userKey) return res.status(400).json({ code: -1, msg: '缺少 user_key' });
  db.get(`SELECT * FROM user_consent WHERE user_key = ? AND scope = 'L3' ORDER BY updated_at DESC LIMIT 1`, [userKey], (err, row) => {
    if (err) return res.status(500).json({ code: -1, msg: err.message });
    const active = !!(row && row.granted && (!row.expires_at || row.expires_at > Date.now()));
    res.json({ code: 0, data: { consent: row || null, active } });
  });
});

// 创建 / 更新授权（duration: 7d / 30d / long）
app.post('/api/consent', (req, res) => {
  const { user_key, granted, duration, source } = req.body || {};
  if (!user_key) return res.status(400).json({ code: -1, msg: '缺少 user_key' });
  const now = Date.now();
  const DAY = 24 * 3600 * 1000;
  const dur = duration || 'long';
  const expiresAt = dur === '7d' ? now + 7 * DAY : dur === '30d' ? now + 30 * DAY : now + 100 * 365 * DAY;
  db.get(`SELECT id FROM user_consent WHERE user_key = ? AND scope = 'L3'`, [user_key], (err, row) => {
    if (err) return res.status(500).json({ code: -1, msg: err.message });
    const done = (e2) => {
      if (e2) return res.status(500).json({ code: -1, msg: e2.message });
      res.json({ code: 0, msg: 'ok', data: { granted: granted ? 1 : 0, duration: dur, expiresAt } });
    };
    if (row) {
      db.run(`UPDATE user_consent SET granted = ?, duration = ?, source = ?, granted_at = ?, expires_at = ?, updated_at = ? WHERE id = ?`,
        [granted ? 1 : 0, dur, source || '', now, expiresAt, now, row.id], done);
    } else {
      db.run(`INSERT INTO user_consent (user_key, scope, granted, duration, source, granted_at, expires_at, updated_at) VALUES (?, 'L3', ?, ?, ?, ?, ?, ?)`,
        [user_key, granted ? 1 : 0, dur, source || '', now, expiresAt, now], done);
    }
  });
});

/* ============ 小程序端 API（CA 视角，v1 无鉴权，角色服务端固定 ca） ============ */
// 与 H5 接口并存，互不干扰；详见 doc/小程序接口文档.md
// 小程序 CA 接口必须登录；未登录返回 401，不再对外公开客户意向数据
app.use('/api/mp', partnerAuth.requireAuth, createMpApi(db));

/* ============ AI 对话分析（DeepSeek 包装，免登录） ============ */
// POST /api/ai/chat · GET /api/ai/config；详见 doc/AI对话分析接口文档.md
// 注意：这里刻意不挂 requireAuth，接口对外可直接调用
app.use('/api/ai', createAiApi());

/* ============ 登录（GTT 合作方 · airU 老师账号） ============ */
// POST /api/auth/login · GET /api/auth/me · POST /api/auth/logout · GET /api/auth/config
partnerAuth.registerAuthRoutes(app);

/* ============ 页面 ============ */

const sendHtml = (res, file, name) => {
  const htmlPath = path.join(__dirname, 'public', file);
  if (fs.existsSync(htmlPath)) res.sendFile(htmlPath);
  else res.status(404).send(`${name} 文件未找到，请检查 public/${file}`);
};

// 新版 UI（design1）静态资源：/design1/xxx.html 直接访问
app.use('/design1', express.static(path.join(__dirname, 'public', 'design1')));

// 新版 UI（design2）静态资源：/design2/xxx.html 直接访问
app.use('/design2', express.static(path.join(__dirname, 'public', 'design2')));

// 新版 UI（design3）静态资源：/design3/xxx.html 直接访问
app.use('/design3', express.static(path.join(__dirname, 'public', 'design3')));

// 销售工作台单页应用的静态资源（sales-app.css / sales-app.js）
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

// 根路径：默认进入销售工作台
app.get('/', (req, res) => res.redirect('/sales'));

// 登录页（未登录时的工作台入口）
app.get('/login', (req, res) => {
  // 已登录直接回到目标页
  if (req.session) return res.redirect('/sales');
  sendHtml(res, 'login.html', '登录');
});

app.get('/userBehavior',
  partnerAuth.requireLoginPage,
  partnerAuth.requireRolePage('developer', { title: '「行为日志」包含 L0 / L1 原始被动行为明细，', allowText: '开发者' }),
  (req, res) => sendHtml(res, 'dashboard.html', 'Dashboard'));

/* ---- 销售工作台：单页应用 ----
   今日概览 / 用户列表 / 用户详情合并为一个页面，对外只暴露 /sales，
   三个视图通过 hash 路由切换：#/ 概览 · #/users 列表 · #/user?key= 详情 */
app.get('/sales', partnerAuth.requireLoginPage, (req, res) => sendHtml(res, 'sales-app.html', '销售工作台'));

// 旧地址兼容：301 到单页应用的对应视图
app.get('/sales/users', partnerAuth.requireLoginPage, (req, res) => {
  const tab = req.query.tab ? `?tab=${encodeURIComponent(req.query.tab)}` : '';
  res.redirect(`/sales#/users${tab}`);
});

app.get('/sales/user', partnerAuth.requireLoginPage, (req, res) => {
  const key = req.query.key ? `?key=${encodeURIComponent(req.query.key)}` : '';
  res.redirect(`/sales#/user${key}`);
});

/* 客户对话分析（AI 提取状态）· 免登录页面 */
app.get('/customerChat', (req, res) => sendHtml(res, 'customerChat.html', '客户对话分析'));

/* ============ 启动 ============ */
/* ============ 兜底错误处理（务必注册在所有路由之后） ============
   主要拦截 express.json 解析失败抛出的 SyntaxError。
   以前这类异常会连带打印一整段堆栈刷屏、并让客户端拿到无结构的响应；
   这里统一收敛成一行告警 + 结构化 JSON，便于统计「到底丢了多少上报」。 */
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.parse.failed') {
    console.warn(`⚠️ 请求体解析失败 ${req.method} ${req.originalUrl} content-type=${req.headers['content-type'] || '-'} ${err.message}`);
    return res.status(400).json({ code: -1, msg: '请求体无法解析，请使用 application/json 或表单格式' });
  }
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ code: -1, msg: '请求体过大' });
  }
  console.error('❌ 未处理异常:', err && err.stack ? err.stack.split('\n').slice(0, 3).join(' | ') : err);
  res.status(500).json({ code: -1, msg: '服务端异常' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ 埋点服务运行在 http://0.0.0.0:${PORT}`);
  console.log(`   登录模式:     ${partnerAuth.CONFIG.enabled ? partnerAuth.CONFIG.mode + '（client_id=' + partnerAuth.CONFIG.clientId + '）' : '已关闭'}`);
  console.log(`   登录接口:     POST /api/auth/login · GET /api/auth/me · POST /api/auth/logout`);
  console.log(`   登录页:       GET  /login`);
  console.log(`   健康检查:     GET  /api/health`);
  console.log(`   埋点上报:     POST /api/track`);
  console.log(`   日志查询:     GET  /api/behavior-log/list`);
  console.log(`   事件枚举:     GET  /api/behavior-log/events`);
  console.log(`   日志详情:     GET  /api/behavior-log/:id`);
  console.log(`   意图列表:     GET  /api/intent/users`);
  console.log(`   行动摘要:     GET  /api/intent/action-summary`);
  console.log(`   用户详情:     GET  /api/intent/user?key=`);
  console.log(`   跟进任务:     GET/POST /api/follow-ups`);
  console.log(`   层级定义:     GET  /api/levels`);
  console.log(`   层级分布:     GET  /api/intent/level-stats`);
  console.log(`   用户授权:     GET/POST /api/consent`);
  console.log(`   小程序概览:   GET  /api/mp/overview`);
  console.log(`   小程序列表:   GET  /api/mp/users?tab=hot|followup|all`);
  console.log(`   小程序详情:   GET  /api/mp/user/detail?key=`);
  console.log(`   小程序跟进:   GET/POST /api/mp/follow-ups · POST /api/mp/follow-ups/:id/status · DELETE /api/mp/follow-ups/:id`);
  console.log(`   AI 对话分析:  POST /api/ai/chat · GET /api/ai/config    （免登录）`);
  console.log(`   Dashboard:    GET  /userBehavior`);
  console.log(`   销售工作台:   GET  /sales            （单页应用 #/ 概览 · #/users 列表 · #/user?key= 详情）`);
  console.log(`   旧地址兼容:   GET  /sales/users 与 /sales/user 自动跳转 /sales`);
});
