/**
 * 数据权限层级定义（Data Level）
 * 依据《用户行为追踪边界规范》设计：
 *   - 系统可以记录，但真人 CA 默认不能「看见我在干什么」；
 *   - 只有当用户主动进入「让 CA 帮我」的状态后，CA 才获得相应范围的信息。
 *
 * 4 个层级：
 *   L0 系统运行   —— 打开、页面运行、错误、整体漏斗（CA 不可见）
 *   L1 被动行为   —— 浏览、停留、重复查看（CA 不可见，只作系统排序因素）
 *   L2 主动动作   —— 收藏、喜欢、加入衣橱、帮我搭、咨询、下单（CA 可见）
 *   L3 兴趣画像   —— 风格偏好、商品兴趣、Intent Score（CA 需用户授权后可见）
 *
 * 3 个角色（权限：开发者 > 老板娘 > 穿搭师/CA）：
 *   developer 开发者 —— 全部层级 + 原始明细 + 调试字段
 *   boss      老板娘 —— 全部层级 + 原始明细（经营分析用）
 *   ca        穿搭师 —— 仅 L2 主动动作 + L3 兴趣画像（需授权），看不到 L1 逐条流水
 */

'use strict';

/* ============ 层级定义 ============ */
const LEVELS = {
  L0: { code: 'L0', name: '系统运行', desc: '打开、页面运行、错误、整体漏斗', caVisible: false, needConsent: false },
  L1: { code: 'L1', name: '被动行为', desc: '浏览、停留、重复查看', caVisible: false, needConsent: false },
  L2: { code: 'L2', name: '主动动作', desc: '收藏、喜欢、加入衣橱、帮我搭、咨询、下单', caVisible: true, needConsent: false },
  L3: { code: 'L3', name: '兴趣画像', desc: '风格偏好、商品兴趣、Intent Score', caVisible: true, needConsent: true },
};

const LEVEL_ORDER = ['L0', 'L1', 'L2', 'L3'];

/* ============ 角色定义 ============ */
const ROLES = {
  developer: { code: 'developer', label: '开发者', rank: 3, levels: ['L0', 'L1', 'L2', 'L3'], rawDetail: true, debug: true },
  boss: { code: 'boss', label: '老板娘', rank: 2, levels: ['L0', 'L1', 'L2', 'L3'], rawDetail: true, debug: false },
  ca: { code: 'ca', label: '穿搭师', rank: 1, levels: ['L2', 'L3'], rawDetail: false, debug: false },
};

const DEFAULT_ROLE = 'ca';

/* ============ 事件 → 层级 映射 ============ */
// L0：系统运行 / 打开
// L1：被动行为（浏览、查看、观看、切换）
// L2：主动动作（收藏、咨询、试穿、分享、购买、会员）
const EVENT_LEVEL = {
  // —— L0 ——
  page_view: 'L0',

  // —— L1 被动行为 ——
  customize_page_view: 'L1',
  tryon_page_view: 'L1',
  wardrobe_page_view: 'L1',
  wishlist_page_view: 'L1',
  profile_page_view: 'L1',
  mine_page_view: 'L1',
  wardrobe_category_switch: 'L1',
  wardrobe_item_tap: 'L1',
  wishlist_item_detail: 'L1',
  view_price_size: 'L1',
  tryon_video_watch: 'L1',
  try_on_video_watch: 'L1',
  video_play_70: 'L1',

  // —— L2 主动动作 ——
  customize_collect_look: 'L2',
  wishlist_add: 'L2',
  try_on_click: 'L2',
  customize_try_on: 'L2',
  customize_consult_open: 'L2',
  customize_consult_save_qr: 'L2',
  consult_sku: 'L2',
  consult_full_outfit: 'L2',
  share: 'L2',
  tryon_share: 'L2',
  customize_share: 'L2',
  click_buy: 'L2',
  buy_button_click: 'L2',
  customize_buy: 'L2',
  subscribe_buy_success: 'L2',
  order_create: 'L2',
  click_vip_plan: 'L2',
  mine_menu_wishlist: 'L2',
  ai_video_generate: 'L2',
  model_create_click: 'L2',
  tryon_generate_complete: 'L2',

  // —— L2 主动动作（取消 / 关闭类） ——
  customize_consult_close: 'L2',
  uncollect_look: 'L2',
  wishlist_remove: 'L2',
};

/**
 * 解析事件所属层级。
 * 未登记的事件按关键词兜底推断，保证「每个上报都有层级」。
 */
function levelOf(event) {
  if (!event) return 'L0';
  if (EVENT_LEVEL[event]) return EVENT_LEVEL[event];
  const e = String(event).toLowerCase();
  // 主动动作关键词 → L2
  if (/(collect|wishlist|consult|share|buy|order|subscribe|try_on|tryon|appoint|reserve|like)/.test(e)) return 'L2';
  // 被动行为关键词 → L1
  if (/(page_view|_view|item_tap|detail|price_size|watch|video|switch|scroll|dwell|stay)/.test(e)) return 'L1';
  return 'L0';
}

/** 是否为合法层级码 */
function isValidLevel(code) {
  return LEVEL_ORDER.includes(code);
}

/** 取得角色配置（非法角色回退到默认角色 CA） */
function roleConfig(role) {
  return ROLES[role] || ROLES[DEFAULT_ROLE];
}

/** 某角色是否可见某层级 */
function canSee(role, level) {
  return roleConfig(role).levels.includes(level);
}

/** 某角色允许的层级集合（数组） */
function allowedLevelsFor(role) {
  return roleConfig(role).levels.slice();
}

/** 生成 SQL IN 占位符，例如 ['L2','L3'] -> '?,?' */
function placeholders(arr) {
  return arr.map(() => '?').join(',');
}

module.exports = {
  LEVELS,
  LEVEL_ORDER,
  ROLES,
  DEFAULT_ROLE,
  EVENT_LEVEL,
  levelOf,
  isValidLevel,
  roleConfig,
  canSee,
  allowedLevelsFor,
  placeholders,
};
