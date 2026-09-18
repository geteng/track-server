/* ============================================================
   airU 销售工作台 · 单页应用脚本
   视图：概览 / 客户 / 跟进 / 详情 / 我的（共用地址 /sales，靠 # 路由切换）
   ============================================================ */

/* ================= 角色权限（开发者 > 老板娘 > 穿搭师/CA） =================
   角色不再由前端选择：登录后从 /api/auth/me 取得，由服务端会话（partner_access.role）决定 */
const ROLE_META = {
  developer: { label: '开发者', scope: 'L0 - L3 全部层级 + 原始明细 + 调试信息', hint: '可见全部数据与上报调试面板' },
  boss: { label: '老板娘', scope: 'L0 - L3 全部层级（经营视角）', hint: '可见经营指标与全部层级数据' },
  ca: { label: '穿搭师 / CA', scope: '仅 L2 主动动作 + L3 兴趣画像', hint: '看不到用户逐条浏览（L0 / L1 被动行为）' },
};
// 登录前保持最小权限，登录后被会话角色覆盖
let currentRole = 'ca';
let currentUser = null;

/* ================= 带登录态的请求 ================= */
function apiFetch(url, options) {
  return fetch(url, Object.assign({ credentials: 'same-origin' }, options || {})).then(async (r) => {
    if (r.status === 401) {
      location.replace(`/login?from=${encodeURIComponent(location.pathname + location.hash)}`);
      throw new Error('未登录');
    }
    return r.json();
  });
}

function toLogin() {
  location.replace(`/login?from=${encodeURIComponent(location.pathname + location.hash)}`);
}

/* ================= 通用工具 ================= */
const $ = (id) => document.getElementById(id);
const pad2 = (x) => String(x).padStart(2, '0');
const fmtDateTime = (ts) => { const d = new Date(ts); return `${d.getMonth() + 1}月${d.getDate()}日 ${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };
const fmtFullTime = (ts) => { const d = new Date(ts); return `${d.getMonth() + 1}月${d.getDate()}日 ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`; };
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const relTime = (ts) => {
  if (!ts) return '—';
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60000);
  if (m < 1) return '刚刚';
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  return `${Math.floor(h / 24)} 天前`;
};
const greetWord = () => {
  const h = new Date().getHours();
  if (h < 6) return '夜深了';
  if (h < 11) return '早上好';
  if (h < 14) return '中午好';
  if (h < 18) return '下午好';
  return '晚上好';
};

const go = (hash) => { if (location.hash === hash) route(); else location.hash = hash; };

/* ================= 路由 ================= */
let currentView = 'overview';

function parseHash() {
  const raw = location.hash.replace(/^#/, '') || '/';
  const qi = raw.indexOf('?');
  const path = qi >= 0 ? raw.slice(0, qi) : raw;
  const query = new URLSearchParams(qi >= 0 ? raw.slice(qi + 1) : '');
  if (path === '/users') return { view: 'users', query };
  if (path === '/user') return { view: 'user', query };
  if (path === '/followups') return { view: 'followups', query };
  if (path === '/me') return { view: 'me', query };
  return { view: 'overview', query };
}

const VIEW_TITLE = {
  overview: '销售工作台',
  users: '客户列表',
  user: '客户详情',
  followups: '跟进任务',
  me: '我的',
};

function route() {
  const { view, query } = parseHash();
  currentView = view;

  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + view));

  // 底部导航高亮：详情归属「客户」
  const navActive = view === 'user' ? 'users' : view;
  document.querySelectorAll('.tabbar .tab').forEach((a) => a.classList.toggle('active', a.dataset.nav === navActive));

  $('hdrTitle').textContent = VIEW_TITLE[view] || '销售工作台';

  window.scrollTo(0, 0);

  if (view === 'overview') Overview.activate();
  else if (view === 'users') Users.activate(query.get('tab'));
  else if (view === 'user') UserDetail.activate(query.get('key'));
  else if (view === 'followups') FollowUps.activate();
  else if (view === 'me') applyRole();
}

window.addEventListener('hashchange', route);

/* ================= 角色应用 ================= */
function applyRole() {
  const meta = ROLE_META[currentRole] || ROLE_META.ca;
  document.body.setAttribute('data-role', currentRole);

  $('roleTag').textContent = meta.label;
  $('hdrSub').textContent = currentUser ? `${currentUser.name || ''} · ${fmtDateTime(Date.now())}` : fmtDateTime(Date.now());

  const hello = $('greetHello');
  if (hello) hello.textContent = `${greetWord()}${currentUser && currentUser.name ? '，' + currentUser.name : ''}`;

  const meAvatar = $('meAvatar');
  if (meAvatar) {
    meAvatar.textContent = (currentUser && currentUser.name ? currentUser.name[0] : '—');
    $('meName').textContent = (currentUser && currentUser.name) || '未登录';
    $('meRole').textContent = meta.label;
    $('meScope').textContent = `可见数据：${meta.scope}`;
    $('meHint').textContent = meta.hint;
  }
}

async function logout() {
  try { await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' }); } catch (e) { /* 忽略 */ }
  toLogin();
}
$('logoutBtn').addEventListener('click', logout);
$('logoutBtn2').addEventListener('click', logout);

function refreshCurrent() {
  if (currentView === 'overview') Overview.refresh();
  else if (currentView === 'users') Users.refresh();
  else if (currentView === 'user') UserDetail.refresh();
  else if (currentView === 'followups') FollowUps.refresh();
}

setInterval(() => { if (currentView !== 'user') $('hdrSub').textContent = (currentUser ? currentUser.name + ' · ' : '') + fmtDateTime(Date.now()); }, 30000);

/* ================= 弹层通用行为 ================= */
function openMask(id) { $(id).classList.add('show'); document.body.style.overflow = 'hidden'; }
function closeMask(id) { $(id).classList.remove('show'); document.body.style.overflow = ''; }

document.querySelectorAll('.sheet-mask').forEach((mask) => {
  mask.addEventListener('click', (e) => {
    if (e.target === mask || e.target.dataset.close === mask.id) closeMask(mask.id);
  });
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') document.querySelectorAll('.sheet-mask.show').forEach((m) => closeMask(m.id));
});

/* ================= 全局路由委托 ================= */
document.addEventListener('click', (e) => {
  const routeEl = e.target.closest('[data-route]');
  if (routeEl) { e.preventDefault(); go(routeEl.dataset.route); return; }
  const link = e.target.closest('a[href^="#/"]');
  if (link) { e.preventDefault(); go(link.getAttribute('href')); }
});

/* ================= 预约跟进（列表 / 详情共用弹层） ================= */
let fuTarget = null;

function openFollowUp(key, name) {
  fuTarget = { key, name };
  $('fuTarget').textContent = name ? `客户：${name}` : '';
  $('fuOwner').value = '';
  $('fuNote').value = '';
  openMask('fuMask');
}

$('fuSubmit').addEventListener('click', async () => {
  if (!fuTarget) return;
  const payload = {
    user_key: fuTarget.key,
    display_name: fuTarget.name,
    plan_time: $('fuPlanTime').value,
    note: $('fuNote').value,
    owner: $('fuOwner').value,
  };
  try {
    const json = await apiFetch('/api/follow-ups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (json.code === 0) { closeMask('fuMask'); refreshCurrent(); }
    else alert(json.msg || '预约失败');
  } catch (err) { alert('预约失败：' + err.message); }
});

/* ================= 变化胶囊（分数动量） ================= */
function deltaPill(value, suffix) {
  const v = Math.round(value || 0);
  const cls = v > 0 ? 'up' : (v < 0 ? 'down' : 'muted');
  const sign = v > 0 ? '+' : '';
  return `<span class="delta-pill ${cls}">${sign}${v}${suffix || ''}</span>`;
}

function clientRow(u, opts) {
  const href = `#/user?key=${encodeURIComponent(u.key)}`;
  const action = (opts && opts.action) || '';
  const subBits = [];
  subBits.push(`最近活跃 <b>${relTime(u.lastActive)}</b>`);
  if (u.behaviorCount) subBits.push(`<b>${u.behaviorCount}</b> 次行为`);
  if (u.followUp && u.followUp.plan_time) subBits.push(`📌 ${esc(u.followUp.plan_time)}`);

  return `<div class="client-row" data-route="${href}" data-key="${esc(u.key)}" data-name="${esc(u.displayName)}">
    <div class="avatar">${esc((u.displayName || '?')[0])}</div>
    <div class="cr-main">
      <div class="cr-name">${esc(u.displayName)}${u.isHeatingUp ? '<span class="tag">升温</span>' : ''}</div>
      <div class="cr-sub">${subBits.join(' · ')}</div>
    </div>
    <div class="cr-right">
      <div class="cr-score">${u.priority}<small>优先级</small></div>
      ${deltaPill(u.todayScore, ' 分')}
    </div>
    ${action}
  </div>`;
}

/* ============================================================
   视图一：概览
   ============================================================ */
const Overview = (() => {
  let loaded = false;

  async function refresh() {
    try {
      const [hotRes, summaryRes, fuRes, allRes, levelRes] = await Promise.all([
        apiFetch('/api/intent/users?tab=hot&size=6'),
        apiFetch('/api/intent/action-summary'),
        apiFetch('/api/follow-ups?status=all'),
        apiFetch('/api/intent/users?tab=all&size=1'),
        currentRole === 'developer' ? apiFetch('/api/intent/level-stats') : Promise.resolve({ data: null }),
      ]);

      const hotList = hotRes.data.list || [];
      const summary = hotRes.data.summary || {};
      const followUps = fuRes.data || [];
      const pending = followUps.filter((f) => f.status === 'pending');

      $('statHot').textContent = summary.hotUsers ?? hotList.length;
      const hotDelta = $('statHotDelta');
      hotDelta.className = 'delta-pill up';
      hotDelta.textContent = `Top ${hotList[0] ? hotList[0].displayName : '—'}`;
      $('statFollowUp').textContent = pending.length;
      const fuDelta = $('statFollowUpDelta');
      fuDelta.className = 'delta-pill ' + (pending.length ? 'warn' : 'muted');
      fuDelta.textContent = pending.length ? '待处理' : '已清空';
      $('statAll').textContent = (allRes.data && allRes.data.total) || '—';

      $('greetSub').textContent = hotList.length
        ? `今天有 ${summary.hotUsers ?? hotList.length} 位客户值得优先联系，最高优先级 ${hotList[0].priority}`
        : '今天暂时没有升温中的客户，可以去「全部会员」里找找';

      // AI 建议
      const items = summaryRes.data.items || [];
      $('summaryList').innerHTML = items.length
        ? items.slice(0, 3).map((it, i) => {
            const href = it.key ? `#/user?key=${encodeURIComponent(it.key)}` : '#/users?tab=all';
            return `<div class="ai-item" data-route="${href}">
              <div class="ai-num">${i + 1}</div>
              <div class="ai-text">${esc(it.text)}</div>
              <div class="ai-go">›</div>
            </div>`;
          }).join('')
        : '<div class="empty">暂无建议，先看看客户列表</div>';

      // 优先联系
      $('hotList').innerHTML = hotList.length
        ? hotList.map((u) => clientRow(u)).join('')
        : '<div class="empty">当前没有正在升温的高意向客户<br>可在「全部会员」中浏览</div>';

      // 数据层级分布（开发者）
      if (currentRole === 'developer' && levelRes && levelRes.data) {
        $('levelGrid').innerHTML = levelRes.data.stats.map((s) => `
          <div class="level-card">
            <span class="lv-code">${s.code}</span>
            <div class="lv-name">${esc(s.name)}</div>
            <div class="lv-desc">${esc(s.desc)}</div>
            <div class="lv-count">${Number(s.count || 0).toLocaleString()} <small>条</small></div>
            <div class="lv-flag">CA 可见：${s.caVisible ? '是' : '否'}${s.needConsent ? ' · 需授权' : ''}</div>
          </div>`).join('');
      }
    } catch (err) {
      console.error(err);
      $('summaryList').innerHTML = '<div class="empty">加载失败：' + esc(err.message) + '</div>';
    }
  }

  function activate() { if (!loaded) { loaded = true; refresh(); } }
  return { activate, refresh };
})();

/* ============================================================
   视图二：客户列表
   ============================================================ */
const Users = (() => {
  const TAB_META = { hot: '今日重点', followup: '待跟进', all: '全部会员' };
  const PAGE_SIZE = 30;
  let curTab = 'hot';
  let curPage = 1;
  let hasMore = false;
  let cache = [];

  function renderSeg() {
    document.querySelectorAll('#userTabs .seg').forEach((t) => t.classList.toggle('active', t.dataset.tab === curTab));
  }

  function paint(list) {
    cache = list || cache;
    const kw = (($('searchInput') && $('searchInput').value) || '').trim().toLowerCase();
    const src = list || [];
    const shown = kw ? src.filter((u) => (u.displayName || '').toLowerCase().indexOf(kw) >= 0) : src;
    const action = `<button class="icon-round" data-action="followup" aria-label="预约跟进">
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>
    </button>`;
    $('userList').innerHTML = shown.length
      ? shown.map((u) => clientRow(u, { action })).join('')
      : `<div class="empty">${kw ? '没有匹配的客户' : '「' + TAB_META[curTab] + '」暂无客户'}</div>`;
  }

  async function refresh() {
    try {
      const [mainRes, hotRes, fuRes, allRes] = await Promise.all([
        apiFetch(`/api/intent/users?tab=${curTab}&page=${curPage}&size=${PAGE_SIZE}`),
        apiFetch('/api/intent/users?tab=hot&size=1'),
        apiFetch('/api/intent/users?tab=followup&size=1'),
        apiFetch('/api/intent/users?tab=all&size=1'),
      ]);

      $('cnt-hot').textContent = hotRes.data.total;
      $('cnt-followup').textContent = fuRes.data.total;
      $('cnt-all').textContent = allRes.data.total;

      const { list, total, page, size } = mainRes.data;
      cache = list || [];
      hasMore = page * size < total;

      paint(cache);
      $('loadMore').style.display = hasMore ? '' : 'none';
      $('pageInfo').textContent = `共 ${total} 位 · 已显示 ${page * size > total ? total : page * size} 位`;
    } catch (err) {
      console.error(err);
      $('userList').innerHTML = '<div class="empty">加载失败：' + esc(err.message) + '</div>';
    }
  }

  function activate(tab) {
    if (tab && TAB_META[tab]) curTab = tab;
    curPage = 1;
    cache = [];
    renderSeg();
    refresh();
  }

  function nextPage() { curPage += 1; refresh(); }

  function filter() { paint(cache); }

  return { activate, refresh, nextPage, filter };
})();

$('userTabs').addEventListener('click', (e) => {
  const btn = e.target.closest('.seg');
  if (!btn) return;
  go('#/users?tab=' + btn.dataset.tab);
});

$('searchInput').addEventListener('input', () => Users.filter());

$('userList').addEventListener('click', (e) => {
  const row = e.target.closest('.client-row');
  if (!row) return;
  if (e.target.closest('[data-action="followup"]')) {
    e.preventDefault();
    e.stopPropagation();
    openFollowUp(row.dataset.key, row.dataset.name);
  }
});

$('loadMore').addEventListener('click', () => Users.nextPage());

/* ============================================================
   视图三：跟进任务
   ============================================================ */
const FollowUps = (() => {
  let loaded = false;

  async function refresh() {
    try {
      const json = await apiFetch('/api/follow-ups?status=all');
      const list = json.data || [];
      const pending = list.filter((f) => f.status === 'pending');
      const rest = list.filter((f) => f.status !== 'pending');

      $('fuSummary').textContent = `待处理 ${pending.length} · 已结束 ${rest.length}`;

      const card = (f) => {
        const statusTag = f.status === 'pending'
          ? '<span class="delta-pill warn">待跟进</span>'
          : (f.status === 'done' ? '<span class="delta-pill up">已完成</span>' : '<span class="delta-pill muted">已取消</span>');
        const actions = f.status === 'pending'
          ? `<div class="tc-actions">
              <button class="btn-ghost btn-sm" data-fu-done="${f.id}">完成</button>
              <button class="btn-ghost btn-sm" data-fu-cancel="${f.id}">取消</button>
             </div>`
          : '';
        return `<div class="task-card" data-route="#/user?key=${encodeURIComponent(f.user_key)}">
          <div class="tc-time">${esc(f.plan_time || '未设时间')}</div>
          <div class="tc-desc">${esc(f.display_name || '未命名客户')}${f.note ? ' · ' + esc(f.note) : ''}</div>
          <div class="tc-src"><span>负责人 ${esc(f.owner || '未指派')} · ${fmtFullTime(f.created_at)}</span>${statusTag}</div>
          ${actions}
        </div>`;
      };

      $('fuList').innerHTML = list.length
        ? (pending.length ? pending.map(card).join('') : '') + (rest.length ? rest.map(card).join('') : '')
        : '<div class="empty">还没有跟进任务<br>去客户列表里点「＋」预约一个</div>';
    } catch (err) {
      $('fuList').innerHTML = '<div class="empty">加载失败：' + esc(err.message) + '</div>';
    }
  }

  function activate() { refresh(); loaded = true; }
  return { activate, refresh };
})();

$('fuList').addEventListener('click', async (e) => {
  const done = e.target.closest('[data-fu-done]');
  const cancel = e.target.closest('[data-fu-cancel]');
  if (!done && !cancel) return;
  e.preventDefault();
  e.stopPropagation();
  const id = (done || cancel).dataset.fuDone || (done || cancel).dataset.fuCancel;
  const status = done ? 'done' : 'canceled';
  try {
    const json = await apiFetch(`/api/follow-ups/${id}/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    });
    if (json.code === 0) FollowUps.refresh(); else alert(json.msg || '操作失败');
  } catch (err) { alert('操作失败：' + err.message); }
});

/* ============================================================
   视图四：客户详情
   ============================================================ */
const UserDetail = (() => {
  let curKey = '';
  let userData = null;

  function openGate() {
    $('userRoot').innerHTML = `
      <div class="card">
        <div class="card-title">查询客户详情</div>
        <div class="field">
          <label>客户 key</label>
          <textarea id="keyInput" rows="2" placeholder="例如 e46092e8-8c66-4208-add3-80e062b6a774"></textarea>
        </div>
        <button class="btn-primary block" data-action="gate-go">查询</button>
        <div class="kv muted" style="margin-top:12px;">也可以从「客户」列表点任意一位直接进入</div>
      </div>`;
    const input = $('keyInput');
    if (input) {
      input.focus();
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitGate(); });
    }
  }

  function submitGate() {
    const v = ($('keyInput').value || '').trim();
    if (!v) return;
    go('#/user?key=' + encodeURIComponent(v));
  }

  function buildSuggestions(u) {
    const list = [];
    const base = `【${u.displayName}】意向分 ${u.score}，最近 ${u.behaviorCount} 次行为`;
    if (u.isHeatingUp) list.push(`【主动联系】${u.displayName} 正在升温（加速 ×${u.momentum}），今天联系转化概率最高，建议优先微信沟通。`);
    if (u.collectedLooks > 0) list.push(`【回访收藏】她收藏了 ${u.collectedLooks} 件 Look，可以提醒优惠活动或帮她对比款式。`);
    if (u.viewedSkus > 0) list.push(`【尺码跟进】她查看了 ${u.viewedSkus} 个商品，可以主动确认尺码并给出搭配建议。`);
    if (!list.length) list.push(`【初步接触】${base}，可以先做一次轻量触达，了解她的穿搭偏好。`);
    return list.slice(0, 3);
  }

  function render(u) {
    const suggestions = buildSuggestions(u).map((s, i) =>
      `<div class="ai-item"><div class="ai-num">${i + 1}</div><div class="ai-text">${esc(s)}</div></div>`
    ).join('');

    const details = (u.scoreDetails || []).map((d) =>
      `<div class="bd-row"><span class="bd-label">${esc(d.label)}</span><span class="bd-event">${esc(d.event)}</span><span class="bd-point">+${d.point}</span></div>`
    ).join('') || '<div class="empty">暂无评分明细</div>';

    const canViewTimeline = currentRole === 'developer';
    const timeline = canViewTimeline ? (u.timeline || []).map((t) => {
      const extraStr = Object.keys(t.extra || {}).length
        ? `<div class="tl-extra">${Object.entries(t.extra).map(([k, v]) => `${esc(k)}: ${esc(typeof v === 'object' ? JSON.stringify(v) : v)}`).join(' · ')}</div>`
        : '';
      return `<div class="tl-item"><div class="tl-time">${esc(t.formattedTime)}</div><div class="tl-event">${esc(t.event)}${t.eventMsg ? ` · ${esc(t.eventMsg)}` : ''}</div>${extraStr}</div>`;
    }).join('') : '';

    const fus = u.followUps || [];
    const fuHTML = fus.length ? fus.map((f) => {
      const tag = f.status === 'pending' ? '<span class="delta-pill warn">待跟进</span>'
        : f.status === 'done' ? '<span class="delta-pill up">已完成</span>'
        : '<span class="delta-pill muted">已取消</span>';
      const act = f.status === 'pending'
        ? `<div class="tc-actions">${tag}<button class="btn-ghost btn-sm" data-action="fu-status" data-id="${f.id}" data-status="done">完成</button><button class="btn-ghost btn-sm" data-action="fu-status" data-id="${f.id}" data-status="canceled">取消</button></div>`
        : tag;
      return `<div class="task-card" style="margin-bottom:8px;">
        <div class="tc-time">${esc(f.plan_time || '未设时间')}</div>
        <div class="tc-desc">${esc(f.note || '跟进任务')}</div>
        <div class="tc-src"><span>${fmtFullTime(f.created_at)} 创建${f.owner ? ' · ' + esc(f.owner) : ''}</span>${act}</div>
      </div>`;
    }).join('') : '<div class="empty">暂无跟进记录</div>';

    $('userRoot').innerHTML = `
      <a class="back-link" href="#/users">‹ 返回客户列表</a>

      <div class="detail-hero">
        <div class="avatar avatar-lg">${esc((u.displayName || '?')[0])}</div>
        <div style="flex:1;min-width:0;">
          <div class="dh-name">${esc(u.displayName)}${u.isHeatingUp ? '<span class="dh-tag hot">升温中</span>' : ''}</div>
          <div class="dh-id">${esc(u.uid || u.key || '')}${u.aid ? ' · ' + esc(u.aid) : ''}</div>
          <div class="dh-tags">
            <span class="dh-tag">活跃 ${u.openDays} 天</span>
            <span class="dh-tag">${u.behaviorCount} 次行为</span>
            ${u.collectedLooks ? `<span class="dh-tag good">收藏 ${u.collectedLooks}</span>` : ''}
            ${u.viewedSkus ? `<span class="dh-tag">浏览 ${u.viewedSkus} 件</span>` : ''}
          </div>
        </div>
      </div>

      <div class="score-row">
        <div class="sr-main">
          <div class="sr-label">AI 意向分</div>
          <div class="sr-value">${u.score}</div>
          ${deltaPill(u.todayScore, ' 近48h')}
        </div>
        <div class="sr-cell"><div class="k">加速</div><div class="v">×${u.momentum}</div></div>
        <div class="sr-cell"><div class="k">优先级</div><div class="v">${u.priority}</div></div>
        <div class="sr-cell"><div class="k">最近活跃</div><div class="v">${relTime(u.lastActive)}</div></div>
      </div>

      <div class="detail-block card">
        <div class="card-title">AI 建议话术</div>
        ${suggestions}
      </div>

      <div class="detail-block card">
        <div class="card-title">跟进记录</div>
        ${fuHTML}
      </div>

      <div class="detail-block card">
        <div class="card-title">评分明细</div>
        <div class="breakdown">${details}</div>
      </div>

      ${canViewTimeline ? `<div class="detail-block card">
        <div class="card-title">行为时间线 <span class="link muted">最近 50 条</span></div>
        <div class="timeline">${timeline || '<div class="empty">暂无行为记录</div>'}</div>
      </div>` : ''}

      <div class="detail-actions">
        <button class="btn-primary" data-action="followup">预约跟进</button>
        <button class="btn-ghost" data-action="gen">生成穿搭</button>
      </div>`;
  }

  async function load() {
    if (!curKey) { openGate(); return; }
    $('userRoot').innerHTML = '<div class="skeleton-line"></div><div class="skeleton-line short"></div>';
    try {
      const json = await apiFetch(`/api/intent/user?key=${encodeURIComponent(curKey)}`);
      if (json.code !== 0 || !json.data) throw new Error(json.msg || '未找到客户');
      userData = json.data;
      render(json.data);
    } catch (err) {
      $('userRoot').innerHTML = `<div class="empty">加载失败：${esc(err.message)}<div style="margin-top:16px;"><button class="btn-ghost" data-action="gate">重新输入 key</button></div></div>`;
    }
  }

  async function setFuStatus(id, status) {
    try {
      const json = await apiFetch(`/api/follow-ups/${id}/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      });
      if (json.code === 0) load(); else alert(json.msg || '操作失败');
    } catch (err) { alert('操作失败：' + err.message); }
  }

  function activate(key) { if (key) curKey = key; load(); }
  function refresh() { if (curKey) load(); }
  function getData() { return userData; }

  $('userRoot').addEventListener('click', (e) => {
    const act = e.target.closest('[data-action]');
    if (!act) return;
    const a = act.dataset.action;
    if (a === 'gate') openGate();
    else if (a === 'gate-go') submitGate();
    else if (a === 'gen') { $('genResult').innerHTML = ''; openMask('genMask'); }
    else if (a === 'followup' && userData) openFollowUp(userData.key, userData.displayName);
    else if (a === 'fu-status') setFuStatus(Number(act.dataset.id), act.dataset.status);
  });

  return { activate, refresh, getData };
})();

/* ================= 生成穿搭（详情专属） ================= */
$('genSubmit').addEventListener('click', () => {
  const u = UserDetail.getData();
  if (!u) return;
  const style = $('genStyle').value;
  const count = parseInt($('genCount').value, 10) || 3;

  const items = [
    ['通勤', ['米色西装', '直筒西裤', '真丝衬衫'], ['通勤外套', '阔腿裤', '针织内搭']],
    ['休闲', ['oversize 卫衣', '直筒牛仔裤', '帆布鞋'], ['基础 T 恤', '休闲裤', '运动鞋']],
    ['约会', ['碎花连衣裙', '针织开衫', '小方包'], ['收腰连衣裙', '蕾丝上衣', '半身裙']],
    ['度假', ['亚麻衬衫', '阔腿裤', '草帽'], ['印花长裙', '吊带背心', '凉鞋']],
    ['根据用户偏好', ['针织衫', '半身裙', '乐福鞋'], ['衬衫', '牛仔裤', '小白鞋']],
  ];
  const chosen = items.find((i) => i[0] === style) || items[4];

  const looks = [];
  for (let i = 0; i < count; i++) {
    const itemsArr = chosen[1].map((it, j) => `${it} ${chosen[2][j % chosen[2].length]}`);
    const total = 1280 + 980 + 560 + i * 160;
    looks.push(`<div class="task-card" style="margin-bottom:8px;"><div class="tc-time">方案 ${i + 1}</div><div class="tc-desc">${itemsArr.join(' + ')}</div><div class="tc-src"><span>参考价</span><span class="delta-pill up">¥${total.toLocaleString()}</span></div></div>`);
  }
  $('genResult').innerHTML = `<div style="margin-top:8px;"><div class="kv muted" style="margin-bottom:8px;">基于【${esc(u.displayName)}】的收藏 / 浏览偏好生成</div>${looks.join('')}</div>`;
});

/* ================= 启动 ================= */
async function bootstrap() {
  try {
    const res = await fetch('/api/auth/me', { credentials: 'same-origin' });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.code !== 0) return toLogin();
    currentUser = json.data.user || null;
    currentRole = json.data.role;
    if (!ROLE_META[currentRole]) currentRole = 'ca';
  } catch (err) {
    return toLogin();
  }

  applyRole();
  route();

  setInterval(() => {
    if (currentView === 'overview') Overview.refresh();
    else if (currentView === 'followups') FollowUps.refresh();
  }, 30000);
}

bootstrap();
