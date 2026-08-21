const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

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

/* ============ Dashboard 页面 ============ */

app.get('/userBehavior', (req, res) => {
  const htmlPath = path.join(__dirname, 'public', 'dashboard.html');
  if (fs.existsSync(htmlPath)) {
    res.sendFile(htmlPath);
  } else {
    res.status(404).send('Dashboard 文件未找到，请检查 public/dashboard.html');
  }
});

/* ============ 启动 ============ */
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ 埋点服务运行在 http://0.0.0.0:${PORT}`);
  console.log(`   健康检查:   GET  /api/health`);
  console.log(`   埋点上报:   POST /api/track`);
  console.log(`   日志查询:   GET  /api/behavior-log/list`);
  console.log(`   事件枚举:   GET  /api/behavior-log/events`);
  console.log(`   日志详情:   GET  /api/behavior-log/:id`);
  console.log(`   Dashboard:  GET  /userBehavior`);
});
