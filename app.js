const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const intentEngine = require('./intent-engine');

const app = express();
const PORT = 3000;

/* ============ 中间件 ============ */
app.use(cors());
// type:'*/*' 确保 sendBeacon 传字符串(text/plain)也能解析
app.use(express.json({ limit: '100kb', type: '*/*' }));

// 请求日志
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} | ${req.method} | ${req.url} | ${req.ip}`);
  next();
});

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
    extra       TEXT
  )`);
  // 兼容旧表：若缺少 uid / eventMsg 列则自动补加；已存在则不执行，避免重启报错
  db.all(`PRAGMA table_info(behavior_log)`, (err, cols) => {
    if (err) return;
    const names = (cols || []).map(c => c.name);
    if (!names.includes('uid')) db.run(`ALTER TABLE behavior_log ADD COLUMN uid TEXT`);
    if (!names.includes('eventMsg')) db.run(`ALTER TABLE behavior_log ADD COLUMN eventMsg TEXT`);
  });
  db.run(`CREATE INDEX IF NOT EXISTS idx_bl_ts     ON behavior_log(timestamp)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_bl_aid    ON behavior_log(aid)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_bl_uid    ON behavior_log(uid)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_bl_event  ON behavior_log(event)`);

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

/* ============ 基础接口 ============ */

// 健康检查
app.get('/api/health', (req, res) => {
  res.json({ code: 0, msg: 'ok', service: 'h5-track-server', time: Date.now() });
});

// 埋点接收
app.post('/api/track', (req, res) => {
  const data = req.body;
  if (!data || !data.event) {
    return res.status(400).json({ code: -1, msg: '字段缺失: event' });
  }
  const insertSql = `INSERT INTO behavior_log (aid, uid, event, url, referrer, timestamp, userAgent, screen, eventMsg, extra) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
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
    JSON.stringify(data.extra || {})
  ];
  db.run(insertSql, params, (err) => {
    if (err) console.error('❌ 写入失败:', err.message);
    else console.log(`📝 埋点: aid=${data.aid || 'unknown'} uid=${data.uid || '-'} event=${data.event}`);
  });
  res.status(200).json({ code: 0, msg: 'ok' });
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
  const { startTime, endTime, event, aid, uid, url, referrer } = req.query;

  let where = [];
  let params = [];

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

// 用户意图列表（4 个 Tab：hot 今日重点 / followup 待跟进 / crosssell 连带机会 / all 全部会员）
app.get('/api/intent/users', (req, res) => {
  const tab = req.query.tab || 'hot';
  const page = Math.max(parseInt(req.query.page) || 1, 1);
  const size = Math.min(Math.max(parseInt(req.query.size) || 20, 1), 100);

  intentEngine.getAllUsers((err, users) => {
    if (err) return res.status(500).json({ code: -1, msg: err.message });

    // 查询待跟进任务（用于 followup Tab 和标记）
    db.all(`SELECT * FROM follow_up WHERE status = 'pending' ORDER BY created_at DESC`, [], (err2, followUps) => {
      if (err2) return res.status(500).json({ code: -1, msg: err2.message });
      const fuByUser = {};
      followUps.forEach(f => { fuByUser[f.user_key] = f; });

      let list = users.map(u => ({ ...u, followUp: fuByUser[u.key] || null }));

      switch (tab) {
        case 'hot':     // 今日重点：今天在升温且 Priority 高
          list = list.filter(u => (u.isHeatingUp || u.todayScore > 0) && u.priority >= 40);
          break;
        case 'followup': // 待跟进：有 pending 任务
          list = list.filter(u => u.followUp);
          break;
        case 'crosssell': // 连带机会：有连带评分
          list = list.filter(u => u.crosssellScore >= 20);
          break;
        case 'all':     // 全部会员
        default:
          break;
      }

      const sortKey = tab === 'hot' ? 'priority' : (tab === 'crosssell' ? 'crosssellScore' : 'priority');
      list.sort((a, b) => (b[sortKey] || 0) - (a[sortKey] || 0));

      const total = list.length;
      const paged = list.slice((page - 1) * size, page * size);

      // 汇总（顶部 6 个数字）
      const now = Date.now();
      const today0 = new Date(now); today0.setHours(0, 0, 0, 0);
      const summary = {
        hotUsers: users.filter(u => u.isHeatingUp && u.priority >= 40).length,                    // 今日高意向
        pendingFollowUps: followUps.length,                                                        // 待跟进任务
        crosssellTotal: users.reduce((a, u) => a + (u.crosssellAmount || 0), 0),                   // 连带机会金额
        contactedToday: 0,                                                                         // 已联系（由前端提交，暂为 0）
        weekConversionRate: 0,                                                                     // 本周转化
        monthCrossSell: users.reduce((a, u) => a + (u.crosssellAmount || 0), 0),                   // 本月连带金额
      };

      res.json({ code: 0, data: { list: paged, total, page, size, tab, summary } });
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
    // 3. 连带机会金额最大
    const cross = users.filter(u => u.crosssellAmount > 0).sort((a, b) => b.crosssellAmount - a.crosssellAmount)[0];

    const items = [];
    if (hot) items.push(`【${hot.displayName}】正在升温，今日意向分 ${hot.todayScore}，综合优先级 ${hot.priority}，建议立即联系。`);
    if (rising) items.push(`【${rising.displayName}】加速最快（Momentum ×${rising.momentum}），近几天从低分快速上升，适合主动推送穿搭。`);
    if (cross) items.push(`【${cross.displayName}】存在连带机会，潜在金额约 ¥${cross.crosssellAmount.toLocaleString()}，可围绕现有兴趣整套推荐。`);
    if (!items.length) items.push('今日暂无重点用户，可在"全部会员"中浏览。');

    res.json({ code: 0, data: { items, generatedAt: now } });
  });
});

// 用户详情（销售工作台数据）
app.get('/api/intent/user', (req, res) => {
  const key = req.query.key || req.query.uid;
  if (!key) return res.status(400).json({ code: -1, msg: '缺少 key 参数' });
  intentEngine.getUserDetail(key, (err, user) => {
    if (err) return res.status(500).json({ code: -1, msg: err.message });
    if (!user) return res.status(404).json({ code: -1, msg: '未找到该用户行为数据' });

    db.all(`SELECT * FROM follow_up WHERE user_key = ? ORDER BY created_at DESC`, [user.key], (err2, fus) => {
      if (err2) return res.status(500).json({ code: -1, msg: err2.message });
      res.json({ code: 0, data: { ...user, followUps: fus } });
    });
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

/* ============ 页面 ============ */

const sendHtml = (res, file, name) => {
  const htmlPath = path.join(__dirname, 'public', file);
  if (fs.existsSync(htmlPath)) res.sendFile(htmlPath);
  else res.status(404).send(`${name} 文件未找到，请检查 public/${file}`);
};

// 根路径：默认进入销售工作台
app.get('/', (req, res) => res.redirect('/sales'));

app.get('/userBehavior', (req, res) => sendHtml(res, 'dashboard.html', 'Dashboard'));

// 销售工作台：首页（6 数字 + 行动摘要 + 今日重点）
app.get('/sales', (req, res) => sendHtml(res, 'sales-dashboard.html', '销售工作台首页'));

// 销售工作台：用户列表（4 个 Tab）
app.get('/sales/users', (req, res) => sendHtml(res, 'sales-users.html', '高意向用户列表'));

// 销售工作台：用户详情（销售工作台）
app.get('/sales/user', (req, res) => sendHtml(res, 'sales-user.html', '用户详情销售工作台'));

/* ============ 启动 ============ */
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ 埋点服务运行在 http://0.0.0.0:${PORT}`);
  console.log(`   健康检查:     GET  /api/health`);
  console.log(`   埋点上报:     POST /api/track`);
  console.log(`   日志查询:     GET  /api/behavior-log/list`);
  console.log(`   事件枚举:     GET  /api/behavior-log/events`);
  console.log(`   日志详情:     GET  /api/behavior-log/:id`);
  console.log(`   意图列表:     GET  /api/intent/users`);
  console.log(`   行动摘要:     GET  /api/intent/action-summary`);
  console.log(`   用户详情:     GET  /api/intent/user?key=`);
  console.log(`   跟进任务:     GET/POST /api/follow-ups`);
  console.log(`   Dashboard:    GET  /userBehavior`);
  console.log(`   销售工作台:   GET  /sales`);
  console.log(`   用户列表:     GET  /sales/users`);
  console.log(`   用户详情页:   GET  /sales/user?key=`);
});
