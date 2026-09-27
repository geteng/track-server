/**
 * 数据权限层级定义（Data Level）
 * 依据：《用户行为追踪边界规范》+《airU 小程序用户上报埋点文档 v0.3》第八章事件字典
 *
 * 核心原则：
 *   - 系统可以记录，但真人 CA 默认不能「看见我在干什么」；
 *   - 只有当用户主动进入「让 CA 帮我」的状态（L2 主动动作）后，CA 才获得相应范围的信息。
 *
 * 4 个层级：
 *   L0 系统运行 —— 打开、页面运行、错误、整体漏斗（CA 不可见）
 *   L1 被动行为 —— 浏览、停留、筛选切换、重复查看（CA 不可见，只作系统排序因素）
 *   L2 主动动作 —— 收藏、试穿、分享、购买、授权（CA 可见）
 *   L3 兴趣画像 —— 风格偏好、商品兴趣、Intent Score（CA 需用户授权后可见）
 *
 * 3 个角色（权限：开发者 > 老板娘 > 穿搭师/CA）：
 *   developer 开发者 —— 全部层级 + 原始明细 + 调试字段
 *   boss      老板娘 —— 全部层级 + 原始明细（经营分析用）
 *   ca        穿搭师 —— 仅 L2 主动动作 + L3 兴趣画像（需授权），看不到 L1 逐条流水
 *
 * v0.3 事件登记：186 个（L0:25  L1:80  L2:81  L3:0）
 * 兜底策略：未登记事件**保守判 L1**（CA 不可见），并打印一次警告提示登记。
 *   理由：v0.3 §11.3 红线 —— 兜底若判 L2，会把 C 端浏览流水泄漏给 CA，属于隐私事故。
 */

'use strict';

/* ============ 层级定义 ============ */
const LEVELS = {
  L0: { code: 'L0', name: '系统运行', desc: '打开、页面运行、错误、整体漏斗', caVisible: false, needConsent: false },
  L1: { code: 'L1', name: '被动行为', desc: '浏览、停留、筛选切换、重复查看', caVisible: false, needConsent: false },
  L2: { code: 'L2', name: '主动动作', desc: '收藏、试穿、分享、购买、授权', caVisible: true, needConsent: false },
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

/* ============ v0.3 事件 → 层级（权威，来自埋点文档第八章）============ */

// —— L0 系统运行 ——
const L0_EVENTS = {
  ca_customer_invite_result: 'L0',
  ca_workbench_view: 'L0',
  consent_prompt_close: 'L0',
  consent_prompt_view: 'L0',
  db_ai_suggestion_show: 'L0',
  db_behavior_summary_show: 'L0',
  db_followup_advice_show: 'L0',
  db_followup_notify_result: 'L0',
  db_history_timeline_show: 'L0',
  db_metric_show: 'L0',
  db_overdue_show: 'L0',
  db_overview_view: 'L0',
  db_rank_refresh_show: 'L0',
  mine_logout_success: 'L0',
  mine_member_grade_show: 'L0',
  model_generate_complete: 'L0',
  ootd_set_first_push_result: 'L0',
  page_view: 'L0',
  register_result: 'L0',
  result_detail_attr_show: 'L0',
  result_review_complete: 'L0',
  result_version_timeline_show: 'L0',
  role_switch: 'L0',
  tryon_notify_show: 'L0',
  tryon_points_preview: 'L0',
};

// —— L1 被动行为（CA 不可见，只作排序因素）——
const L1_EVENTS = {
  activity_card_view: 'L1',
  agreement_view: 'L1',
  avatar_identity_view: 'L1',
  avatar_switch: 'L1',
  avatar_tab_switch: 'L1',
  avatar_view: 'L1',
  ca_customer_detail_open: 'L1',
  ca_customer_manage_view: 'L1',
  ca_customer_profile_view: 'L1',
  collect_item_tap: 'L1',
  collect_list_view: 'L1',
  db_behavior_item_tap: 'L1',
  db_contact_record_tap: 'L1',
  db_customer_card_tap: 'L1',
  db_customer_detail_view: 'L1',
  db_customer_list_view: 'L1',
  db_focus_customer_tap: 'L1',
  db_insight_view: 'L1',
  db_tab_switch: 'L1',
  gen_reason_view: 'L1',
  gen_record_batch_view: 'L1',
  gen_record_card_tap: 'L1',
  gen_record_filter_switch: 'L1',
  gen_record_item_tap: 'L1',
  gen_record_search: 'L1',
  gen_record_tab_switch: 'L1',
  gen_record_view: 'L1',
  home_carousel_look_tap: 'L1',
  home_carousel_switch: 'L1',
  home_filter_switch: 'L1',
  home_look_tap: 'L1',
  home_scroll_depth: 'L1',
  inspiration_category_select: 'L1',
  inspiration_upload_open: 'L1',
  item_select_cancel: 'L1',
  item_select_page_view: 'L1',
  item_select_toggle: 'L1',
  login_page_view: 'L1',
  login_register_view: 'L1',
  look_detail_leave: 'L1',
  look_detail_view: 'L1',
  look_reason_view: 'L1',
  look_watch_complete: 'L1',
  mine_page_view: 'L1',
  mine_settings: 'L1',
  model_sample_view: 'L1',
  ootd_category_view: 'L1',
  ootd_page_view: 'L1',
  ootd_setting_click: 'L1',
  ootd_tab_switch: 'L1',
  outfit_diy_layout: 'L1',
  outfit_diy_remove: 'L1',
  outfit_diy_swap: 'L1',
  profile_page_view: 'L1',
  register_field_fill: 'L1',
  register_to_login_click: 'L1',
  result_detail_tab_switch: 'L1',
  result_detail_view: 'L1',
  result_feedback_open: 'L1',
  result_version_tap: 'L1',
  settings_page_view: 'L1',
  sku_detail_tab_switch: 'L1',
  sku_detail_view: 'L1',
  sku_tryon_result_tap: 'L1',
  try_record_filter_switch: 'L1',
  try_record_item_tap: 'L1',
  try_record_tab_switch: 'L1',
  tryon_customer_search: 'L1',
  tryon_customer_select: 'L1',
  tryon_page_view: 'L1',
  tryon_queue_view: 'L1',
  tryon_step_back: 'L1',
  tryon_submit_done: 'L1',
  tryon_video_close: 'L1',
  tryon_video_play: 'L1',
  video_play_70: 'L1',
  view_price_size: 'L1',
  wardrobe_category_switch: 'L1',
  wardrobe_item_tap: 'L1',
  wardrobe_page_view: 'L1',
};

// —— L2 主动动作（CA 可见）——
const L2_EVENTS = {
  activity_detail_click: 'L2',
  avatar_set_default: 'L2',
  ca_customer_delete: 'L2',
  ca_customer_invite: 'L2',
  ca_customer_pull: 'L2',
  ca_data_backend_click: 'L2',
  ca_home_config_click: 'L2',
  ca_pending_review_click: 'L2',
  ca_workbench_entry_click: 'L2',
  click_buy: 'L2',
  consent_close: 'L2',
  consent_grant: 'L2',
  db_followup_book: 'L2',
  db_followup_complete: 'L2',
  db_followup_reschedule: 'L2',
  empty_go_browse: 'L2',
  home_banner_click: 'L2',
  home_gallery_manage: 'L2',
  inspiration_category_create: 'L2',
  item_category_add: 'L2',
  item_select_confirm: 'L2',
  look_attr_edit: 'L2',
  look_delete: 'L2',
  look_edit_open: 'L2',
  mine_login_click: 'L2',
  mine_login_success: 'L2',
  mine_logout_click: 'L2',
  mine_menu_my_model: 'L2',
  mine_menu_points: 'L2',
  mine_menu_style_profile: 'L2',
  mine_menu_try_record: 'L2',
  mine_menu_wardrobe: 'L2',
  model_body_upload: 'L2',
  model_create_click: 'L2',
  model_face_upload: 'L2',
  model_generate_submit: 'L2',
  model_photo_consent_toggle: 'L2',
  model_photo_remove: 'L2',
  ootd_create_outfit: 'L2',
  ootd_invite_click: 'L2',
  ootd_look_add_click: 'L2',
  ootd_set_first_push: 'L2',
  ootd_storehouse_switch: 'L2',
  outfit_ai_match_click: 'L2',
  outfit_diy_add_item: 'L2',
  outfit_diy_open: 'L2',
  outfit_diy_save: 'L2',
  points_deduct: 'L2',
  profile_edit_open: 'L2',
  profile_edit_save: 'L2',
  register_agreement_toggle: 'L2',
  register_click: 'L2',
  register_submit: 'L2',
  result_adjust_open: 'L2',
  result_adjust_submit: 'L2',
  result_adopt_all: 'L2',
  result_adopt_push: 'L2',
  result_collect_click: 'L2',
  result_feedback_submit: 'L2',
  result_record_delete: 'L2',
  result_review_confirm: 'L2',
  result_review_opinion: 'L2',
  settings_account_name_edit: 'L2',
  settings_avatar_update: 'L2',
  settings_password_set: 'L2',
  settings_qrcode_update: 'L2',
  sku_attr_edit: 'L2',
  sku_delete: 'L2',
  sku_edit_image: 'L2',
  try_on_click: 'L2',
  tryon_generate_complete: 'L2',
  tryon_generate_submit: 'L2',
  tryon_model_switch: 'L2',
  tryon_result_delete: 'L2',
  tryon_result_save: 'L2',
  tryon_scene_set: 'L2',
  tryon_share: 'L2',
  tryon_step_next: 'L2',
  tryon_type_select: 'L2',
  tryon_watermark_set: 'L2',
  wardrobe_upload: 'L2',
};

// —— L3 兴趣画像（CA 需授权后可见）——
const L3_EVENTS = {

};

/** v0.3 全量事件层级表 */
const EVENT_LEVEL = Object.assign({}, L0_EVENTS, L1_EVENTS, L2_EVENTS, L3_EVENTS);

/**
 * v0.2 遗留事件：库里历史数据仍在查询范围，仅用于时间线展示层。
 * 不参与 Intent 评分（权重表 v2.0 只认 v0.3 事件）。
 */
const LEGACY_EVENT_LEVEL = {
  ai_video_generate: 'L2',
  buy_button_click: 'L2',
  click_vip_plan: 'L2',
  consult_full_outfit: 'L2',
  consult_sku: 'L2',
  customize_buy: 'L2',
  customize_collect_look: 'L2',
  customize_consult_close: 'L2',
  customize_consult_open: 'L2',
  customize_consult_save_qr: 'L2',
  customize_page_view: 'L1',
  customize_share: 'L2',
  customize_try_on: 'L2',
  mine_menu_wishlist: 'L2',
  order_create: 'L2',
  share: 'L2',
  subscribe_buy_success: 'L2',
  try_on_video_watch: 'L1',
  tryon_page_view: 'L1',
  tryon_video_watch: 'L1',
  uncollect_look: 'L2',
  wishlist_add: 'L2',
  wishlist_item_detail: 'L1',
  wishlist_page_view: 'L1',
  wishlist_remove: 'L2',
};

/** 已登记事件总数（v0.3 + 遗留） */
const REGISTERED_COUNT = Object.keys(EVENT_LEVEL).length + Object.keys(LEGACY_EVENT_LEVEL).length;

/* ============ 兜底推断（仅用于未登记事件）============ */
// 注意：兜底一律按「看不到更安全」处理 —— 命中主动动作关键词才升 L2，否则 L1。
const L2_PATTERN = /(^|_)(collect|consult|share|buy|order|subscribe|pay|save|submit|confirm|grant|invite|upload|generate_submit|feedback)(_|$)/;
const L0_PATTERN = /(^|_)(ping|error|heartbeat|boot)(_|$)/;

/** 未登记事件告警去重（同一事件只提醒一次） */
const warned = new Set();

function warnUnregistered(event) {
  if (warned.has(event)) return;
  warned.add(event);
  if (process.env.NODE_ENV !== 'test') {
    console.warn(`[data-levels] 事件「${event}」未在层级表中登记，已保守判为 L1（CA 不可见）。请按 v0.3 §11.5 补登记。`);
  }
}

/**
 * 解析事件所属层级。
 * 优先查权威表；未登记事件保守兜底为 L1（绝不默认 L2，避免把浏览流水泄漏给 CA）。
 */
function levelOf(event) {
  if (!event) return 'L0';
  if (EVENT_LEVEL[event]) return EVENT_LEVEL[event];
  if (LEGACY_EVENT_LEVEL[event]) return LEGACY_EVENT_LEVEL[event];
  warnUnregistered(event);
  const e = String(event).toLowerCase();
  if (L0_PATTERN.test(e)) return 'L0';
  if (L2_PATTERN.test(e)) return 'L2';
  return 'L1';
}

/** 该事件是否已在权威表中登记（用于 CI 自检 / 埋点验收） */
function isRegistered(event) {
  return Boolean(EVENT_LEVEL[event]);
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

/** 该层级对 CA 是否可见（需同时满足层级允许与 L3 授权） */
function caVisible(level, hasConsent) {
  if (level === 'L3') return Boolean(hasConsent);
  return Boolean(LEVELS[level] && LEVELS[level].caVisible);
}

/** 生成 SQL IN 占位符，例如 ['L2','L3'] -> '?,?' */
function placeholders(arr) {
  return arr.map(() => '?').join(',');
}

/** 层级分布统计（自检 / 调试用） */
function stats() {
  const dist = {};
  for (const lv of LEVEL_ORDER) dist[lv] = Object.keys({ ...L0_EVENTS, ...L1_EVENTS, ...L2_EVENTS, ...L3_EVENTS }).filter((k) => EVENT_LEVEL[k] === lv).length;
  return { v03: Object.keys(EVENT_LEVEL).length, legacy: Object.keys(LEGACY_EVENT_LEVEL).length, dist };
}

module.exports = {
  LEVELS,
  LEVEL_ORDER,
  ROLES,
  DEFAULT_ROLE,
  EVENT_LEVEL,
  LEGACY_EVENT_LEVEL,
  L0_EVENTS,
  L1_EVENTS,
  L2_EVENTS,
  L3_EVENTS,
  REGISTERED_COUNT,
  levelOf,
  isRegistered,
  isValidLevel,
  roleConfig,
  canSee,
  caVisible,
  allowedLevelsFor,
  placeholders,
  stats,
};
