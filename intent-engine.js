/**
 * Intent Engine —— 高意向用户评分引擎
 * 基于需求文档《AI 穿搭高意向跟进后台》
 *   IntentScore   = Σ(W × F × R)       高意向评分
 *   Momentum      = 近期加速因子         意向加速分
 *   Priority      = IntentScore × Momentum  综合优先级
 */
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const dataLevels = require('./data-levels');

const db = new sqlite3.Database(path.join(__dirname, 'track.db'), (err) => {
  if (err) console.error('Intent Engine 连接数据库失败:', err.message);
});

/* ============ 行为权重表（对应需求文档 1.2 评分表） ============ */
const BEHAVIOR_WEIGHTS = {
  // —— 打开 / 浏览 ——
  'page_view':              { w: 3,  label: '打开页面' },
  'customize_page_view':    { w: 8,  label: '浏览穿搭定制页' },
  'tryon_page_view':        { w: 8,  label: '浏览试穿页' },
  'wardrobe_page_view':     { w: 6,  label: '浏览衣柜' },
  'wishlist_page_view':     { w: 6,  label: '浏览心愿单' },
  'profile_page_view':      { w: 3,  label: '浏览个人资料' },
  'mine_page_view':         { w: 3,  label: '浏览我的页' },
  'wardrobe_category_switch': { w: 4, label: '切换衣柜分类' },
  // —— 查看商品 / 价格尺码 ——
  'wardrobe_item_tap':      { w: 15, label: '查看商品详情' },
  'wishlist_item_detail':   { w: 15, label: '查看心愿单商品' },
  'view_price_size':        { w: 15, label: '查看价格/尺码' },
  // —— 咨询 ——
  'customize_consult_open': { w: 40, label: '点击咨询穿搭老师' },
  'customize_consult_save_qr': { w: 50, label: '咨询并保存联系方式' },
  'consult_sku':            { w: 50, label: '咨询具体 SKU/尺码' },
  'consult_full_outfit':    { w: 60, label: '咨询整套搭配' },
  // —— 收藏 / 试穿 / 视频 ——
  'customize_collect_look': { w: 25, label: '收藏 Look（加入 Wishlist）' },
  'try_on_click':           { w: 20, label: '点击试穿' },
  'customize_try_on':       { w: 20, label: '试穿虚拟搭配' },
  'tryon_video_watch':      { w: 15, label: '观看 Look 视频' },
  'try_on_video_watch':     { w: 15, label: '观看试穿视频' },
  'video_play_70':          { w: 20, label: '视频播放完成率≥70%' },
  'ai_video_generate':      { w: 25, label: 'AI 穿搭生成' },
  'model_create_click':     { w: 25, label: '生成虚拟模特' },
  'tryon_generate_complete':{ w: 25, label: '试穿生成完成' },
  // —— 分享 ——
  'share':                  { w: 15, label: '分享给朋友' },
  'tryon_share':            { w: 15, label: '分享试穿' },
  'customize_share':        { w: 15, label: '分享定制穿搭' },
  // —— 购买 / 转化 ——
  'click_buy':              { w: 80, label: '点击购买' },
  'buy_button_click':       { w: 80, label: '点击购买按钮' },
  'customize_buy':          { w: 100, label: '购买定制穿搭' },
  'subscribe_buy_success':  { w: 100, label: '购买成功' },
  'order_create':           { w: 100, label: '下单成功' },
  // —— 其他 ——
  'click_vip_plan':         { w: 20, label: '查看会员套餐' },
  'mine_menu_wishlist':     { w: 5,  label: '打开心愿单入口' },
};

// 取消类事件（负分）
const NEGATIVE_EVENTS = {
  'customize_consult_close': { w: -2, label: '关闭咨询' },
  'uncollect_look':          { w: -15, label: '取消收藏' },
  'wishlist_remove':         { w: -15, label: '移除心愿单' },
};

/* ============ 小工具 ============ */

// 从 aid 解析展示名（如 airDemo_cjy -> cjy）
function displayName(uid, aid) {
  const namePool = ['王', '李', '张', '刘', '陈', '杨', '赵', '黄', '周', '吴', '徐', '孙', '马', '朱', '胡', '郭', '何', '高', '林', '罗'];
  let hash = 0;
  const key = uid || aid || 'unknown';
  for (let i = 0; i < key.length; i++) hash = ((hash << 5) - hash + key.charCodeAt(i)) | 0;
  const surname = namePool[Math.abs(hash) % namePool.length];
  // 客户统一按女性称谓展示（原逻辑按 hash 随机取女士/先生）
  const gender = '女士';
  return surname + gender;
}

function normalizeKey(uid, aid) {
  return (uid && uid !== 'unknown') ? uid : (aid || 'unknown');
}

// 解析 extra
function parseExtra(str) {
  try { return JSON.parse(str || '{}'); } catch (e) { return {}; }
}

/* ============ 核心：计算单个用户的意图 ============ */

/**
 * 计算一个用户的意图评分（需要传入该用户的全部行为记录）
 * @param {Array} logs 用户行为记录（含 event/timestamp/extra）
 * @param {Object} opts { now } 当前时间
 */
function computeIntent(logs, opts = {}) {
  const now = opts.now || Date.now();
  const DAY = 24 * 3600 * 1000;

  let score = 0;
  const scoreDetails = [];       // 评分明细（用于前端展示）
  const todayScoreMap = {};      // 每天得分（key: YYYY-MM-DD）
  const dailyOpens = {};         // 每天是否打开（计算连续打开天数）

  // 收集商品相关（收藏数 / 浏览商品数，用于信号标签与跟进话术）
  const viewedSkus = new Set();
  const collectedLooks = new Set();

  for (const log of logs) {
    const evt = log.event;
    const ts = log.timestamp;
    const dayKey = new Date(ts).toISOString().slice(0, 10);
    const extra = parseExtra(log.extra);
    const ageDays = Math.max(0, (now - ts) / DAY);

    // 时间衰减因子 R：越近分数越高（7 天内线性衰减，7 天后按指数衰减）
    const R = ageDays <= 7 ? (1 - ageDays / 14) : Math.exp(-(ageDays - 7) / 14);
    if (R <= 0.02) continue;

    const def = BEHAVIOR_WEIGHTS[evt] || NEGATIVE_EVENTS[evt];
    if (def) {
      const F = evt.startsWith('page_view') ? 0.6 : 1; // 页面浏览类频次折减
      const point = def.w * F * R;
      score += point;
      todayScoreMap[dayKey] = (todayScoreMap[dayKey] || 0) + point;
      scoreDetails.push({ event: evt, label: def.label, weight: def.w, level: dataLevels.levelOf(evt), recency: Math.round(R * 100) / 100, point: Math.round(point * 10) / 10, time: ts });
    }

    // 打开天数统计（page_view / *_page_view）
    if (evt === 'page_view' || evt.endsWith('_page_view')) dailyOpens[dayKey] = true;

    // 商品收集
    if (evt === 'wardrobe_item_tap' || evt === 'wishlist_item_detail' || evt === 'view_price_size') {
      const sku = extra.sku || extra.goodsId || extra.itemId || `SKU-${ts % 9973}`;
      viewedSkus.add(String(sku));
    }
    if (evt === 'customize_collect_look' || evt === 'wishlist_add') {
      const look = extra.lookId || extra.styleId || `LOOK-${ts % 9973}`;
      collectedLooks.add(String(look));
    }
  }

  /* —— 意向加速分 Momentum —— */
  const todayKey = new Date(now).toISOString().slice(0, 10);
  // "今日"使用最近 48 小时活跃窗口（避免凌晨/跨日数据被漏掉）
  const WINDOW = 48 * 3600 * 1000;
  const windowStart = now - WINDOW;
  // 窗口前 4 天作为历史基准（[now-144h, now-48h]）
  const prevStart = windowStart - 4 * DAY;

  const scoreOf = (start, end) => logs
    .filter(l => l.timestamp >= start && l.timestamp < end)
    .reduce((acc, l) => {
      const def = BEHAVIOR_WEIGHTS[l.event] || NEGATIVE_EVENTS[l.event];
      if (!def) return acc;
      const F = l.event.startsWith('page_view') ? 0.6 : 1;
      const ageDays = Math.max(0, (now - l.timestamp) / DAY);
      const R = ageDays <= 7 ? (1 - ageDays / 14) : Math.exp(-(ageDays - 7) / 14);
      return acc + def.w * F * R;
    }, 0);

  const windowScore = scoreOf(windowStart, now);
  const prevDaily = scoreOf(prevStart, windowStart) / 4;

  let momentum = 1;
  let isHeatingUp = false;
  if (prevDaily < 1) {
    // 无历史基准：只要窗口内有活跃就算升温
    isHeatingUp = windowScore > 5;
    momentum = 1;
  } else {
    momentum = Math.min(3, Math.max(1, 1 + (windowScore - prevDaily) / (prevDaily + 5)));
    isHeatingUp = windowScore > prevDaily * 1.5;
  }
  const todayScore = windowScore;

  const priority = score * momentum;

  /* —— 活跃天数 —— */
  const openDays = Object.keys(dailyOpens).length;
  const recent7Opens = Object.keys(dailyOpens).filter(d => d >= new Date(now - 7 * DAY).toISOString().slice(0, 10)).length;
  if (openDays >= 2) { score += 10; scoreDetails.push({ event: '__recent', label: '连续 2 天打开', weight: 10, level: 'L1', recency: 1, point: 10, time: now }); }
  if (recent7Opens >= 3) { score += 15; scoreDetails.push({ event: '__recent', label: '7 天内打开 ≥ 3 天', weight: 15, level: 'L1', recency: 1, point: 15, time: now }); }

  return {
    score: Math.round(score * 10) / 10,
    momentum: Math.round(momentum * 100) / 100,
    priority: Math.round(priority * 10) / 10,
    isHeatingUp,
    lastActive: logs.length ? Math.max(...logs.map(l => l.timestamp)) : 0,
    behaviorCount: logs.length,
    openDays,
    viewedSkus: viewedSkus.size,
    collectedLooks: collectedLooks.size,
    scoreDetails: scoreDetails.sort((a, b) => b.time - a.time).slice(0, 15),
    todayScore: Math.round(todayScore * 10) / 10,
  };
}

/* ============ 对外 API ============ */

/**
 * 获取全部用户意图列表（实时从行为日志计算）
 */
function getAllUsers(cb) {
  db.all(`SELECT aid, uid, event, timestamp, extra, userName FROM behavior_log`, [], (err, rows) => {
    if (err) return cb(err);
    const byUser = {};
    // 真实昵称：key -> { ts, name }，取该用户最近一次上报的 userName
    const realName = new Map();
    for (const r of rows) {
      const key = normalizeKey(r.uid, r.aid);
      if (!byUser[key]) byUser[key] = { key, uid: r.uid, aid: r.aid, logs: [] };
      byUser[key].logs.push(r);
      // 只认带 uid 的上报，避免按 aid（游客）聚合时把不同人的昵称串到一起
      if (r.uid && r.userName) {
        const prev = realName.get(key);
        if (!prev || (r.timestamp || 0) >= prev.ts) realName.set(key, { ts: r.timestamp || 0, name: r.userName });
      }
    }
    const now = Date.now();
    const users = Object.values(byUser).map(u => {
      const intent = computeIntent(u.logs, { now });
      const rn = realName.get(u.key);
      return {
        key: u.key,
        uid: u.uid,
        aid: u.aid,
        // 有真实昵称用真实昵称，没有则回退到「哈希姓氏 + 女士」
        displayName: (rn && rn.name) || displayName(u.uid, u.aid),
        ...intent,
      };
    });
    // 过滤掉无行为量的噪音用户
    const filtered = users.filter(u => u.behaviorCount >= 3);
    cb(null, filtered);
  });
}

/**
 * 获取单用户详情（含行为时间线）
 */
function getUserDetail(key, cb) {
  const lookup = key.includes('%') ? decodeURIComponent(key) : key;
  db.all(`SELECT * FROM behavior_log WHERE uid = ? OR aid = ? ORDER BY timestamp ASC`, [lookup, lookup], (err, rows) => {
    if (err) return cb(err);
    if (!rows.length) return cb(null, null);
    const first = rows[0];
    const intent = computeIntent(rows, { now: Date.now() });
    // rows 按时间升序，取最后一条非空 userName 作为真实昵称
    let realName = '';
    for (const r of rows) {
      if (r.userName) realName = r.userName;
    }
    cb(null, {
      key: normalizeKey(first.uid, first.aid),
      uid: first.uid,
      aid: first.aid,
      displayName: realName || displayName(first.uid, first.aid),
      ...intent,
      timeline: rows.slice(-50).reverse().map(r => ({
        id: r.id,
        event: r.event,
        url: r.url,
        eventMsg: r.eventMsg,
        level: r.level || dataLevels.levelOf(r.event),
        extra: parseExtra(r.extra),
        time: r.timestamp,
        formattedTime: formatTime(r.timestamp),
      })),
    });
  });
}

function formatTime(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

module.exports = { getAllUsers, getUserDetail, computeIntent, displayName, normalizeKey };
