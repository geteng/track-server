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

/* ============ 行为权重表 W v2.0（纯 C 端 · 纯 v0.3 埋点）============
 * 依据：doc/Intent权重表-C端v0.3-v2.0.md
 *   w   ：基础权重（仅 role=user 生效，role=ca / guest 恒 0）
 *   cap ：单日最多计入条数（缺省 = 不封顶，用于抑制"刷首页"刷分）
 *   f   ：频次折减（缺省 1；浏览 0.6 / 浅点击 0.8 / 主动 1.0）
 *   warn：C 端入口待确认（v0.3 标 both 但主要发生在 CA 生产流程）
 * 不在表内的事件一律计 0 —— 包括全部 CA 运营事件与 v0.2 遗留事件。
 */
const BEHAVIOR_WEIGHTS = {
  // ── 转化 ──
  click_buy:                  { w: 80, label: '点击购买' },
  // ── 强意向 ──
  try_on_click:               { w: 25, label: '发起 AI 试穿' },
  tryon_result_save:          { w: 25, label: '保存试穿结果' },
  tryon_share:                { w: 18, label: '分享试穿结果' },
  view_price_size:            { w: 18, label: '查看价格/尺码', cap: 3 },
  // ── 深度投入 ──
  model_generate_submit:      { w: 20, label: '提交生成数字人' },
  look_watch_complete:        { w: 20, label: '完整观看试穿结果', cap: 2 },
  outfit_diy_save:            { w: 18, label: '保存搭配', warn: 'C端入口待确认' },
  model_face_upload:          { w: 15, label: '上传面部照' },
  model_body_upload:          { w: 15, label: '上传全身照' },
  activity_detail_click:      { w: 15, label: '查看活动详情', cap: 3 },
  video_play_70:              { w: 15, label: '播放至 70%', cap: 2 },
  result_collect_click:       { w: 15, label: '收藏生成结果' },
  model_create_click:         { w: 12, label: '创建/重新生成分身', cap: 3 },
  register_submit:            { w: 12, label: '提交注册', cap: 2 },
  ootd_create_outfit:         { w: 12, label: '创建 OOTD', warn: 'CA侧为主' },
  item_select_confirm:        { w: 12, label: '确认选择单品', warn: 'CA侧为主' },
  outfit_diy_open:            { w: 12, label: '开始 DIY 搭配', cap: 3, warn: 'CA侧为主' },
  // ── 主动互动 ──
  result_feedback_submit:     { w: 12, label: '提交我的意见', cap: 2 },
  profile_edit_save:          { w: 10, label: '保存画像字段' },
  ootd_invite_click:          { w: 10, label: '邀请加入搭配库', cap: 2 },
  ootd_look_add_click:        { w: 10, label: '分类内添加搭配', warn: 'CA侧为主' },
  item_category_add:          { w: 10, label: '分类补充单品', warn: 'CA侧为主' },
  outfit_ai_match_click:      { w: 10, label: '点击 AI 搭配', warn: 'CA侧为主' },
  register_click:             { w: 8,  label: '点击立即注册', cap: 2 },
  home_banner_click:          { w: 8,  label: '点击首页 Banner', cap: 3 },
  mine_menu_my_model:         { w: 8,  label: '查看我的数字形象', cap: 3 },
  profile_edit_open:          { w: 8,  label: '编辑画像字段', cap: 3 },
  avatar_set_default:         { w: 8,  label: '设为默认形象', cap: 2 },
  outfit_diy_add_item:        { w: 8,  label: '补充画布单品', warn: 'CA侧为主' },
  sku_detail_view:            { w: 8,  label: '浏览单品详情', cap: 3, f: 0.8 },
  look_detail_view:           { w: 8,  label: '浏览搭配详情', cap: 3, f: 0.8 },
  consent_grant:              { w: 8,  label: '授权 L3 画像', cap: 1 },
  tryon_video_play:           { w: 8,  label: '播放试穿结果', cap: 3, f: 0.8 },
  // ── 中轻互动 ──
  mine_menu_try_record:       { w: 6,  label: '点击 AI 试衣记录', cap: 2 },
  mine_menu_style_profile:    { w: 6,  label: '点击穿搭档案', cap: 2 },
  mine_menu_wardrobe:         { w: 6,  label: '点击我的衣橱', cap: 2 },
  try_record_item_tap:        { w: 6,  label: '回看试衣结果', cap: 3, f: 0.8 },
  wardrobe_item_tap:          { w: 6,  label: '浏览衣橱单品', cap: 3, f: 0.8 },
  gen_record_item_tap:        { w: 6,  label: '查看生成结果', cap: 3, f: 0.8 },
  sku_tryon_result_tap:       { w: 6,  label: '单品反查试穿', cap: 3, f: 0.8 },
  mine_login_success:         { w: 6,  label: '登录成功', cap: 1 },
  mine_login_click:           { w: 5,  label: '点击登录', cap: 2 },
  home_carousel_look_tap:     { w: 5,  label: '点击轮播搭配', cap: 3, f: 0.8 },
  home_look_tap:              { w: 5,  label: '浏览搭配瀑布流', cap: 3, f: 0.8 },
  profile_page_view:          { w: 5,  label: '进入穿搭档案', cap: 2, f: 0.6 },
  gen_record_view:            { w: 5,  label: '进入生成记录', cap: 3, f: 0.6 },
  gen_record_card_tap:        { w: 5,  label: '查看记录卡片', cap: 3, f: 0.8 },
  result_detail_view:         { w: 5,  label: '查看结果详情', cap: 3, f: 0.8 },
  avatar_view:                { w: 5,  label: '查看数字分身', cap: 2, f: 0.8 },
  look_reason_view:           { w: 5,  label: '浏览推荐理由', cap: 2, f: 0.8 },
  gen_reason_view:            { w: 5,  label: '浏览推荐理由', cap: 2, f: 0.8 },
  empty_go_browse:            { w: 5,  label: '空态去逛逛', cap: 2 },
  register_agreement_toggle:  { w: 5,  label: '勾选注册协议', cap: 1 },
  settings_avatar_update:     { w: 5,  label: '更新头像', cap: 1 },
  settings_qrcode_update:     { w: 5,  label: '更新联系二维码', cap: 1 },
  collect_item_tap:           { w: 5,  label: '浏览收藏项', cap: 3, f: 0.8 },
  // ── 浏览 ──
  wardrobe_page_view:         { w: 4,  label: '进入我的衣橱', cap: 2, f: 0.6 },
  ootd_page_view:             { w: 4,  label: '进入搭配库', cap: 2, f: 0.6 },
  avatar_identity_view:       { w: 4,  label: '进入 AI 数字形象', cap: 2, f: 0.6 },
  page_view:                  { w: 3,  label: '打开页面', cap: 5, f: 0.6 },
  mine_page_view:             { w: 3,  label: '进入我的', cap: 3, f: 0.6 },
  login_page_view:            { w: 3,  label: '进入登录页', cap: 2, f: 0.6 },
  login_register_view:        { w: 3,  label: '进入注册页', cap: 2, f: 0.6 },
  settings_page_view:         { w: 3,  label: '进入账号设置', cap: 2, f: 0.6 },
  activity_card_view:         { w: 3,  label: '浏览活动卡片', cap: 3, f: 0.6 },
  ootd_category_view:         { w: 3,  label: '浏览搭配分类', cap: 3, f: 0.6 },
  collect_list_view:          { w: 3,  label: '进入收藏列表', cap: 2, f: 0.6 },
  result_feedback_open:       { w: 3,  label: '打开意见反馈', cap: 2, f: 0.8 },
  avatar_switch:              { w: 3,  label: '切换分身', cap: 2, f: 0.8 },
  avatar_tab_switch:          { w: 3,  label: '切换数字身份', cap: 2, f: 0.8 },
  settings_account_name_edit: { w: 3,  label: '修改账户名', cap: 1 },
  outfit_diy_swap:            { w: 3,  label: '换品', cap: 3, f: 0.8, warn: 'CA侧为主' },
  home_carousel_switch:       { w: 2,  label: '轮播切换', cap: 3, f: 0.6 },
  home_filter_switch:         { w: 2,  label: '灵感筛选切换', cap: 3, f: 0.6 },
  home_scroll_depth:          { w: 2,  label: '浏览到第 N 屏', cap: 2, f: 0.6 },
  agreement_view:             { w: 2,  label: '查看协议', cap: 1, f: 0.8 },
  mine_settings:              { w: 2,  label: '打开设置', cap: 2, f: 0.8 },
  try_record_filter_switch:   { w: 2,  label: '试衣记录筛选', cap: 2, f: 0.6 },
  try_record_tab_switch:      { w: 2,  label: '我的 Tab 切换', cap: 2, f: 0.6 },
  register_field_fill:        { w: 2,  label: '填写注册字段', cap: 4, f: 0.8 },
  register_to_login_click:    { w: 2,  label: '注册页返回登录', cap: 1, f: 0.8 },
  wardrobe_category_switch:   { w: 2,  label: '切换衣橱分类', cap: 2, f: 0.6 },
  item_select_toggle:         { w: 2,  label: '勾选/取消单品', cap: 5, f: 0.6 },
  ootd_tab_switch:            { w: 2,  label: '搭配库 Tab 切换', cap: 2, f: 0.6 },
  sku_detail_tab_switch:      { w: 2,  label: '单品 Tab 切换', cap: 2, f: 0.6 },
  ootd_setting_click:         { w: 2,  label: '搭配库设置', cap: 1, f: 0.8 },
  outfit_diy_remove:          { w: 2,  label: '移除画布单品', cap: 3, f: 0.8 },
  outfit_diy_layout:          { w: 2,  label: '一键排版', cap: 3, f: 0.8 },
  gen_record_filter_switch:   { w: 2,  label: '筛选生成结果', cap: 2, f: 0.6 },
  result_detail_tab_switch:   { w: 2,  label: '结果详情 Tab 切换', cap: 2, f: 0.6 },
  model_sample_view:          { w: 2,  label: '查看建模示例图', cap: 2, f: 0.8 },
  // ── 被动触达：CA 发起、服务端记在客户 uid 上（v0.3 §7.3）──
  tryon_generate_complete:    { w: 8,  label: 'AI试穿结果已生成', cap: 3, passive: true },
};

/* 按 step 区分权重的事件 */
const STEP_WEIGHTS = {
  wardrobe_upload: { click: { w: 5, label: '点击上传单品', cap: 3 }, done: { w: 15, label: '上传单品成功' } },
};

/* 负向事件 */
const NEGATIVE_EVENTS = {
  sku_delete:         { w: -5, label: '删除单品' },
  item_select_cancel: { w: -2, label: '放弃选择' },
};

/* 分层信号集（用于「高意向 / 今日重点」判定，见权重表文档 §五） */
const STRONG_EVENTS = [
  'click_buy', 'try_on_click', 'tryon_result_save', 'tryon_share', 'result_collect_click',
  'result_feedback_submit', 'model_generate_submit', 'model_face_upload', 'model_body_upload',
  'view_price_size', 'look_watch_complete',
];
const MEDIUM_EVENTS = [
  'wardrobe_upload', 'model_create_click', 'profile_edit_save', 'consent_grant', 'register_submit',
  'activity_detail_click', 'video_play_70', 'mine_menu_my_model', 'tryon_generate_complete',
];

/**
 * 角色门控：只有 C 端用户行为进入 Intent 评分
 * - 显式 role=ca（老师运营动作）/ role=guest（游客）→ 不计分
 * - CA 代客操作（extra 带 actorUid / customerId）→ 不计分
 * - 历史数据不带 role（库里现有 3 万条均无 role）→ 默认按 user 处理，
 *   此时「只算 C 端」依赖第二道防线：CA 专属事件不在 W 表内，自然计 0
 */
function isClientSide(extra, log) {
  const role = (extra && extra.role) || (log && log.role);
  if (role && role !== 'user') return false;
  if (extra && (extra.actorUid || extra.customerId)) return false;
  return true;
}

/** 取事件权重定义（含 step 分流） */
function weightOf(evt, extra) {
  const stepDef = STEP_WEIGHTS[evt];
  if (stepDef) {
    const step = (extra && extra.step) || 'done';
    return stepDef[step] || stepDef.done || null;
  }
  return BEHAVIOR_WEIGHTS[evt] || NEGATIVE_EVENTS[evt] || null;
}


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
  const dailyOpens = {};         // 每天是否打开（计算连续打开天数）
  const points = [];             // { ts, point } 已计分条目，供窗口加速分复用（保证与主分一致）
  const capCounter = {};         // `${dayKey}|${event}` -> 当日已计入条数
  const strongHits = new Set();  // 近 48h 命中的强信号事件
  const mediumHits = new Set();  // 近 48h 命中的中信号事件

  // 收集商品相关（收藏数 / 浏览商品数，用于信号标签与跟进话术）
  const viewedSkus = new Set();
  const collectedLooks = new Set();

  // 按时间升序处理：保证 cap「当日取前 N 条」结果稳定
  const sorted = [...logs].sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

  for (const log of sorted) {
    const evt = log.event;
    const ts = log.timestamp || 0;
    const dayKey = new Date(ts).toISOString().slice(0, 10);
    const extra = parseExtra(log.extra);

    // 【角色门控】仅 C 端用户行为计分：role=ca / guest、CA 代客操作全部跳过
    if (!isClientSide(extra, log)) continue;

    const ageDays = Math.max(0, (now - ts) / DAY);

    // 时间衰减因子 R：越近分数越高（7 天内线性衰减，7 天后按指数衰减）
    const R = ageDays <= 7 ? (1 - ageDays / 14) : Math.exp(-(ageDays - 7) / 14);
    if (R <= 0.02) continue;

    const def = weightOf(evt, extra);
    if (!def) continue;

    // 【单日上限 cap】超出部分计 0，抑制「反复刷首页」刷分
    if (def.cap) {
      const ck = `${dayKey}|${evt}`;
      capCounter[ck] = (capCounter[ck] || 0) + 1;
      if (capCounter[ck] > def.cap) continue;
    }

    const F = def.f != null ? def.f : 1;   // 频次折减
    const point = def.w * F * R;
    score += point;
    points.push({ ts, point });
    scoreDetails.push({ event: evt, label: def.label, weight: def.w, level: dataLevels.levelOf(evt), recency: Math.round(R * 100) / 100, point: Math.round(point * 10) / 10, time: ts });

    // 近 48h 信号命中（用于「高意向 / 今日重点」分层）
    if (now - ts <= 48 * 3600 * 1000) {
      if (STRONG_EVENTS.includes(evt)) strongHits.add(evt);
      if (MEDIUM_EVENTS.includes(evt)) mediumHits.add(evt);
    }

    // 打开天数统计（page_view / *_page_view）
    if (evt === 'page_view' || evt.endsWith('_page_view')) dailyOpens[dayKey] = true;

    // 商品收集
    if (evt === 'wardrobe_item_tap' || evt === 'view_price_size' || evt === 'sku_detail_view') {
      const sku = extra.sku || extra.goodsId || extra.itemId || extra.skuId || `SKU-${ts % 9973}`;
      viewedSkus.add(String(sku));
    }
    if (evt === 'result_collect_click' || evt === 'collect_item_tap') {
      const look = extra.lookId || extra.resultId || extra.styleId || `LOOK-${ts % 9973}`;
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

  // 窗口分直接复用主循环中已按「角色门控 + cap + F + R」算出的得分，保证口径一致
  const scoreOf = (start, end) => points
    .filter(p => p.ts >= start && p.ts < end)
    .reduce((acc, p) => acc + p.point, 0);

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
    scoredCount: points.length,               // 真正计入评分的行为数（门控 + cap 后）
    openDays,
    viewedSkus: viewedSkus.size,
    collectedLooks: collectedLooks.size,
    scoreDetails: scoreDetails.sort((a, b) => b.time - a.time).slice(0, 15),
    todayScore: Math.round(todayScore * 10) / 10,
    // —— 分层信号（供「高意向 / 今日重点」判定）——
    strongSignals: [...strongHits],
    mediumSignals: [...mediumHits],
    tier: strongHits.size ? 'S' : (mediumHits.size >= 2 || isHeatingUp ? 'A' : ''),
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
