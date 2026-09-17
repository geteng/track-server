'use strict';

/**
 * 小程序端 API（挂载于 /api/mp）
 *
 * 面向「穿搭师 CA」视角的只读 + 跟进任务接口。
 * 设计约定：
 *   1. 角色在服务端固定为 ca，不接受 / 不解析任何 role 参数（v1 无鉴权下的最低限防护）
 *   2. 不下发 L1 被动行为派生字段（viewedSkus / behaviorCount / scoreDetails / timeline）
 *   3. 信号标签与建议话术由服务端用完整数据生成后下发，避免 CA 端话术退化
 *   4. 用户意图计算全表实时计算，加 30 秒缓存
 */

const express = require('express');
const intentEngine = require('./intent-engine');

const CACHE_TTL = 30 * 1000; // 意图计算结果缓存时长
const DEFAULT_SIZE = 20;
const MAX_SIZE = 50;
const VALID_STATUS = ['pending', 'done', 'canceled', 'all'];

module.exports = function createMpApi(db) {
  const router = express.Router();

  /* ================= 工具函数 ================= */

  /** 解析整数参数并限制取值范围 */
  function intParam(v, def, min, max) {
    const n = parseInt(v, 10);
    if (isNaN(n)) return def;
    return Math.min(Math.max(n, min), max);
  }

  /**
   * 意图计算缓存：getAllUsers 为全表实时计算，30 秒内复用结果。
   * 计算失败且存在旧缓存时降级返回旧数据，保证小程序端可用性。
   */
  let cache = { at: 0, users: null };
  function getUsers(cb) {
    if (cache.users && Date.now() - cache.at < CACHE_TTL) return cb(null, cache.users);
    intentEngine.getAllUsers((err, users) => {
      if (err) {
        if (cache.users) return cb(null, cache.users);
        return cb(err);
      }
      cache = { at: Date.now(), users };
      cb(null, users);
    });
  }

  /** 跟进任务映射（统一字段命名，去掉内部字段） */
  function mapFollowUp(f) {
    if (!f) return null;
    return {
      id: f.id,
      user_key: f.user_key,
      display_name: f.display_name,
      plan_time: f.plan_time || '',
      note: f.note || '',
      owner: f.owner || '',
      status: f.status,
      created_at: f.created_at,
    };
  }

  /**
   * 信号标签：仅使用 CA 可见字段（L2 主动动作派生 + 活跃天数），
   * 不使用 viewedSkus 等 L1 被动行为派生字段。
   */
  function buildSignals(u) {
    const s = [];
    if (u.isHeatingUp) s.push('⚡ 正在升温');
    if (u.collectedLooks > 0) s.push(`收藏 ${u.collectedLooks}`);
    if (u.openDays >= 3) s.push(`累计 ${u.openDays} 天活跃`);
    if (!s.length) s.push('近 48h 活跃');
    return s;
  }

  /**
   * 建议话术：服务端用完整数据生成后下发。
   * 涉及 L1 被动行为的线索只给定性描述，不下发具体数量，避免向 CA 暴露明细。
   */
  function buildSuggestions(u) {
    const list = [];
    if (u.isHeatingUp) {
      list.push(`【主动联系】${u.displayName} 正在升温（加速 ×${u.momentum}），今天联系转化概率最高，建议优先微信沟通。`);
    }
    if (u.collectedLooks > 0) {
      list.push(`【回访收藏】她收藏了 ${u.collectedLooks} 件 Look，可以提醒优惠活动或帮她对比款式。`);
    }
    if (u.viewedSkus > 0) {
      list.push('【尺码跟进】她近期浏览了多个商品，可以主动确认尺码并给出搭配建议。');
    }
    if (u.openDays >= 3) {
      list.push(`【持续活跃】累计 ${u.openDays} 天打开，活跃度较高，可趁热推进一次沟通。`);
    }
    if (!list.length) {
      list.push(`【初步接触】${u.displayName} 意向分 ${u.score}，可以先做一次轻量触达，了解她的穿搭偏好。`);
    }
    return list.slice(0, 3);
  }

  /** 用户对象映射：只下发 CA 可见字段 */
  function mapUser(u, followUp) {
    return {
      key: u.key,
      displayName: u.displayName,
      priority: u.priority,
      score: u.score,
      momentum: u.momentum,
      isHeatingUp: !!u.isHeatingUp,
      todayScore: u.todayScore,
      lastActive: u.lastActive,
      collectedLooks: u.collectedLooks,
      openDays: u.openDays,
      signals: buildSignals(u),
      followUp: mapFollowUp(followUp),
    };
  }

  /** Tab 过滤，与现有 intent/users 接口口径一致 */
  function filterByTab(list, tab) {
    if (tab === 'hot') return list.filter((x) => (x.u.isHeatingUp || x.u.todayScore > 0) && x.u.priority >= 40);
    if (tab === 'followup') return list.filter((x) => x.fu);
    return list;
  }

  /** 查询待跟进任务并按下标归集到用户 */
  function loadPendingFollowUps(cb) {
    db.all(`SELECT * FROM follow_up WHERE status = 'pending' ORDER BY created_at DESC`, [], cb);
  }

  /* ================= 1. 首页聚合 ================= */
  router.get('/overview', (req, res) => {
    getUsers((err, users) => {
      if (err) return res.status(500).json({ code: -1, msg: err.message });

      loadPendingFollowUps((e2, fus) => {
        if (e2) return res.status(500).json({ code: -1, msg: e2.message });
        const pending = fus || [];
        const fuByUser = {};
        pending.forEach((f) => { if (!fuByUser[f.user_key]) fuByUser[f.user_key] = f; });

        const withFu = users.map((u) => ({ u, fu: fuByUser[u.key] || null }));

        // 3 个数字（本周转化率恒为 0，CA 端不下发）
        const summary = {
          hotUsers: users.filter((u) => u.isHeatingUp && u.priority >= 40).length,
          pendingFollowUps: pending.length,
        };

        // 今日重点 Top 6
        const hotTop = filterByTab(withFu, 'hot')
          .sort((a, b) => (b.u.priority || 0) - (a.u.priority || 0))
          .slice(0, 6)
          .map((x) => mapUser(x.u, x.fu));

        // 今日行动摘要（纯文案，供小程序直接展示）
        const hot = users.filter((u) => u.isHeatingUp).sort((a, b) => b.priority - a.priority)[0];
        const rising = users.filter((u) => u.momentum >= 1.5 && u.todayScore > 0).sort((a, b) => b.momentum - a.momentum)[0];
        const actionSummary = [];
        if (hot) actionSummary.push(`【${hot.displayName}】正在升温，今日意向分 ${hot.todayScore}，建议今天优先联系。`);
        if (rising) actionSummary.push(`【${rising.displayName}】加速最快（Momentum ×${rising.momentum}），适合主动推送穿搭。`);
        if (!actionSummary.length) actionSummary.push('今日暂无重点用户，可在「全部会员」中浏览。');

        res.json({
          code: 0,
          data: {
            summary,
            hotTop,
            actionSummary,
            myFollowUps: pending.slice(0, 5).map(mapFollowUp),
          },
        });
      });
    });
  });

  /* ================= 2. 用户列表 ================= */
  router.get('/users', (req, res) => {
    const tab = req.query.tab || 'hot';
    const page = intParam(req.query.page, 1, 1, 100000);
    const size = intParam(req.query.size, DEFAULT_SIZE, 1, MAX_SIZE);
    const keyword = (req.query.keyword || '').trim().toLowerCase();

    getUsers((err, users) => {
      if (err) return res.status(500).json({ code: -1, msg: err.message });

      loadPendingFollowUps((e2, fus) => {
        if (e2) return res.status(500).json({ code: -1, msg: e2.message });
        const fuByUser = {};
        (fus || []).forEach((f) => { if (!fuByUser[f.user_key]) fuByUser[f.user_key] = f; });

        let all = users.map((u) => ({ u, fu: fuByUser[u.key] || null }));
        if (keyword) all = all.filter((x) => String(x.u.displayName || '').toLowerCase().includes(keyword));

        // 三个 Tab 的计数（不受当前 tab 影响，一次给全）
        const tabCounts = {
          hot: filterByTab(all, 'hot').length,
          followup: filterByTab(all, 'followup').length,
          all: all.length,
        };

        const filtered = filterByTab(all, tab)
          .sort((a, b) => (b.u.priority || 0) - (a.u.priority || 0));

        const total = filtered.length;
        const paged = filtered.slice((page - 1) * size, page * size);

        res.json({
          code: 0,
          data: {
            list: paged.map((x) => mapUser(x.u, x.fu)),
            total,
            page,
            size,
            hasMore: page * size < total,
            tab,
            tabCounts,
          },
        });
      });
    });
  });

  /* ================= 3. 用户详情 ================= */
  router.get('/user/detail', (req, res) => {
    const key = req.query.key;
    if (!key) return res.status(400).json({ code: -1, msg: '缺少 key 参数' });

    intentEngine.getUserDetail(key, (err, u) => {
      if (err) return res.status(500).json({ code: -1, msg: err.message });
      if (!u) return res.status(404).json({ code: -1, msg: '未找到该用户行为数据' });

      db.all(`SELECT * FROM follow_up WHERE user_key = ? ORDER BY created_at DESC`, [u.key], (e2, fus) => {
        if (e2) return res.status(500).json({ code: -1, msg: e2.message });
        res.json({
          code: 0,
          data: {
            ...mapUser(u, null),
            suggestions: buildSuggestions(u),
            followUps: (fus || []).map(mapFollowUp),
          },
        });
      });
    });
  });

  /* ================= 4. 跟进任务列表 ================= */
  router.get('/follow-ups', (req, res) => {
    const status = req.query.status || 'pending';
    if (!VALID_STATUS.includes(status)) {
      return res.status(400).json({ code: -1, msg: `status 取值须为 ${VALID_STATUS.join(' / ')}` });
    }
    const page = intParam(req.query.page, 1, 1, 100000);
    const size = intParam(req.query.size, DEFAULT_SIZE, 1, MAX_SIZE);
    const offset = (page - 1) * size;

    const where = status === 'all' ? '' : ' WHERE status = ?';
    const listSql = `SELECT * FROM follow_up${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`;
    const countSql = `SELECT COUNT(*) AS c FROM follow_up${where}`;
    const listParams = status === 'all' ? [size, offset] : [status, size, offset];
    const countParams = status === 'all' ? [] : [status];

    db.get(countSql, countParams, (e1, row) => {
      if (e1) return res.status(500).json({ code: -1, msg: e1.message });
      const total = (row && row.c) || 0;
      db.all(listSql, listParams, (e2, rows) => {
        if (e2) return res.status(500).json({ code: -1, msg: e2.message });
        res.json({
          code: 0,
          data: {
            list: (rows || []).map(mapFollowUp),
            total,
            page,
            size,
            hasMore: page * size < total,
          },
        });
      });
    });
  });

  /* ================= 5. 创建跟进任务 ================= */
  router.post('/follow-ups', (req, res) => {
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

  /* ================= 6. 更新跟进任务状态 ================= */
  router.post('/follow-ups/:id/status', (req, res) => {
    const id = parseInt(req.params.id, 10);
    const { status } = req.body || {};
    if (!id || !['done', 'canceled'].includes(status)) {
      return res.status(400).json({ code: -1, msg: '参数错误：status 须为 done 或 canceled' });
    }
    db.run(`UPDATE follow_up SET status = ?, updated_at = ? WHERE id = ?`, [status, Date.now(), id], function (err) {
      if (err) return res.status(500).json({ code: -1, msg: err.message });
      if (!this.changes) return res.status(404).json({ code: -1, msg: '跟进任务不存在' });
      res.json({ code: 0, msg: 'ok' });
    });
  });

  /* ================= 7. 删除跟进任务 ================= */
  router.delete('/follow-ups/:id', (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ code: -1, msg: '参数错误' });
    db.run(`DELETE FROM follow_up WHERE id = ?`, [id], function (err) {
      if (err) return res.status(500).json({ code: -1, msg: err.message });
      if (!this.changes) return res.status(404).json({ code: -1, msg: '跟进任务不存在' });
      res.json({ code: 0, msg: 'ok' });
    });
  });

  return router;
};
