/* ============================================================
   airU 销售工作台 · 单页应用脚本
   视图：今日概览 / 用户列表 / 用户详情（共用地址 /sales，靠 # 路由切换）
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
// 任何接口返回 401 都说明会话失效，直接回登录页，不在前端保留数据
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

// 视图间跳转（只改 # 片段，主路径永远是 /sales）
const go = (hash) => { if (location.hash === hash) route(); else location.hash = hash; };

/* ================= 路由 ================= */
let currentView = 'overview';

/* ================= 顶部 Header 文案（随视图切换） ================= */
const HEADER_META = {
  overview: { title: () => `早安，${(currentUser && currentUser.name) || ''}`, sub: '今日待办建议优先跟进' },
  users: { title: () => '客户列表', sub: '算法优先级实时排序' },
  user: { title: () => '客户详情', sub: '' },
};
function setHeader(view) {
  const meta = HEADER_META[view] || HEADER_META.overview;
  const t = $('pageTitle');
  const s = $('pageSub');
  const b = $('pageBadge');
  if (t) t.textContent = meta.title();
  if (s) s.textContent = meta.sub;
  // 「N 位高升温客户」徽章只在概览出现，数值由 Overview.refresh 填充
  if (b) {
    if (view !== 'overview') b.textContent = '';
    b.style.display = view === 'overview' ? '' : 'none';
  }
}

function parseHash() {
  const raw = location.hash.replace(/^#/, '') || '/';
  const qi = raw.indexOf('?');
  const path = qi >= 0 ? raw.slice(0, qi) : raw;
  const query = new URLSearchParams(qi >= 0 ? raw.slice(qi + 1) : '');
  if (path === '/users') return { view: 'users', query };
  if (path === '/user') return { view: 'user', query };
  return { view: 'overview', query };
}

function route() {
  const { view, query } = parseHash();
  currentView = view;

  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + view));

  // 导航高亮：详情归属「用户列表」
  const navActive = view === 'user' ? 'users' : view;
  document.querySelectorAll('.nav-links a[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === navActive));

  setHeader(view);
  window.scrollTo(0, 0);

  if (view === 'overview') Overview.activate();
  else if (view === 'users') Users.activate(query.get('tab'));
  else UserDetail.activate(query.get('key'));
}

window.addEventListener('hashchange', route);

/* ================= 角色应用 ================= */
function applyRole() {
  const meta = ROLE_META[currentRole];

  // 顶部固定展示当前视角（登录后由服务端决定，页面内不可切换）
  const tag = $('roleTag');
  if (tag) {
    tag.textContent = meta.label;
    tag.setAttribute('data-role', currentRole);
  }
  const nameEl = $('userName');
  if (nameEl) nameEl.textContent = currentUser ? (currentUser.name || '') : '';
  const avatarEl = $('sfAvatar');
  if (avatarEl) avatarEl.textContent = (currentUser && currentUser.name) ? currentUser.name.trim()[0] : '—';

  // 「行为日志」入口：仅开发者可见
  document.body.setAttribute('data-role', currentRole);

  const banner = $('roleBanner');
  if (banner) banner.innerHTML = `<span class="lv">当前视角：${meta.label}</span> 可见数据：<b>${meta.scope}</b> · ${meta.hint}`;

  // 经营指标（仅开发者 / 老板娘可见）
  const bizVisible = currentRole !== 'ca';
  const convCard = $('statConversionCard');
  if (convCard) convCard.style.display = bizVisible ? '' : 'none';
  const statsRow = $('statsRow');
  if (statsRow) statsRow.classList.toggle('cols-2', !bizVisible);

  // 开发者专属调试面板
  const levelSection = $('levelSection');
  if (levelSection) levelSection.style.display = currentRole === 'developer' ? '' : 'none';
}

// 退出登录：清掉服务端 HttpOnly 会话后回到登录页
$('logoutBtn').addEventListener('click', async () => {
  try {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
  } catch (e) { /* 忽略网络异常，仍然跳转 */ }
  toLogin();
});

function refreshCurrent() {
  if (currentView === 'overview') Overview.refresh();
  else if (currentView === 'users') Users.refresh();
  else if (currentView === 'user') UserDetail.refresh();
}

/* ================= 时钟 ================= */
function tick() {
  const t = $('nowText');
  if (!t) return;
  const d = new Date();
  const week = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'][d.getDay()];
  t.textContent = `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${week}`;
}
setInterval(tick, 1000);
tick();

/* ================= 弹窗通用行为 ================= */
function openMask(id) { $(id).classList.add('show'); }
function closeMask(id) { $(id).classList.remove('show'); }

document.querySelectorAll('.modal-mask').forEach((mask) => {
  mask.addEventListener('click', (e) => {
    if (e.target === mask || e.target.dataset.close === mask.id) mask.classList.remove('show');
  });
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') document.querySelectorAll('.modal-mask.show').forEach((m) => m.classList.remove('show'));
});

/* ================= 全局路由委托（磁贴 / 卡片 / 链接） ================= */
document.addEventListener('click', (e) => {
  const routeEl = e.target.closest('[data-route]');
  if (routeEl) { e.preventDefault(); go(routeEl.dataset.route); return; }
  const link = e.target.closest('a[href^="#/"]');
  if (link) { e.preventDefault(); go(link.getAttribute('href')); }
});

/* ================= 预约跟进（列表 / 详情共用弹窗） ================= */
let fuTarget = null;

function openFollowUp(key, name) {
  fuTarget = { key, name };
  $('fuTarget').textContent = name ? `用户：${name}` : '';
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

/* ============================================================
   视图一：今日概览
   ============================================================ */
const Overview = (() => {
  let loaded = false;

  function scoreBadge(p) {
    if (p >= 100) return '<span class="score-badge score-hot">🔥 高意向</span>';
    if (p >= 60) return '<span class="score-badge score-warm">高意向</span>';
    return '';
  }

  function userCardHTML(u) {
    const signals = [];
    if (u.isHeatingUp) signals.push('<span class="signal-tag key">⚡ 正在升温</span>');
    if (u.collectedLooks > 0) signals.push(`<span class="signal-tag">收藏 ${u.collectedLooks}</span>`);
    if (u.viewedSkus > 0) signals.push(`<span class="signal-tag">浏览商品 ${u.viewedSkus}</span>`);
    if (!signals.length) signals.push('<span class="signal-tag">近 48h 活跃</span>');

    const routeTo = `#/user?key=${encodeURIComponent(u.key)}`;
    return `<div class="user-card" data-route="${routeTo}">
      ${scoreBadge(u.priority)}
      <div class="u-head">
        <div class="avatar">${esc(u.displayName[0])}</div>
        <div>
          <div class="u-name">${esc(u.displayName)}</div>
          <div class="u-score">${esc(u.aid || '—')}${u.behaviorCount ? ' · ' + u.behaviorCount + ' 次行为' : ''}</div>
        </div>
      </div>
      <div class="signals">${signals.join('')}</div>
      <div class="u-metrics">
        <div class="m"><div class="v" style="color:var(--primary)">${u.score}</div><div class="k">意向分</div></div>
        <div class="m"><div class="v">×${u.momentum}</div><div class="k">加速</div></div>
        <div class="m"><div class="v" style="color:var(--red)">${u.priority}</div><div class="k">优先级</div></div>
      </div>
      <div class="u-actions">
        <button class="btn btn-primary btn-sm" data-route="${routeTo}">查看工作台</button>
      </div>
    </div>`;
  }

  async function refresh() {
    try {
      // 不带 role 参数：角色由服务端登录会话决定
      const [hotRes, summaryRes, fuRes, levelRes] = await Promise.all([
        apiFetch('/api/intent/users?tab=hot&size=6'),
        apiFetch('/api/intent/action-summary'),
        apiFetch('/api/follow-ups?status=all'),
        currentRole === 'developer' ? apiFetch('/api/intent/level-stats') : Promise.resolve({ data: null }),
      ]);

      const hotList = hotRes.data.list || [];
      const summary = hotRes.data.summary || {};
      const followUps = fuRes.data || [];

      // 3 个数字磁贴
      $('statHot').textContent = summary.hotUsers ?? hotList.length;
      $('statHotDetail').innerHTML = hotList.length ? `Top: <span>${esc(hotList[0].displayName)}</span>（优先级 ${hotList[0].priority}）` : '';
      $('statFollowUp').textContent = summary.pendingFollowUps ?? followUps.filter((f) => f.status === 'pending').length;
      const pending = followUps.filter((f) => f.status === 'pending');
      $('statFollowUpDetail').innerHTML = pending.length ? `最近: <span>${esc(pending[0].display_name)}</span>` : '';
      $('statConversion').innerHTML = '—';

      // 今日行动摘要
      const items = summaryRes.data.items || [];
      $('summaryList').innerHTML = items.length
        ? items.map((it, i) => {
            const href = it.key ? `#/user?key=${encodeURIComponent(it.key)}` : '#/users?tab=all';
            return `<a class="summary-item" href="${href}"><div class="num">${i + 1}</div><div class="text">${it.text}</div></a>`;
          }).join('')
        : '<div class="empty-state">暂无摘要</div>';

      // 今日重点
      $('hotCount').textContent = `共 ${hotRes.data.total} 位`;

      // 顶部徽章：高升温客户数（仅概览视图显示）
      const badge = $('pageBadge');
      if (badge && currentView === 'overview') {
        const n = hotRes.data.total ?? hotList.length;
        badge.textContent = n ? `${n} 位高升温客户` : '';
      }
      $('hotGrid').innerHTML = hotList.length
        ? hotList.map(userCardHTML).join('')
        : '<div class="empty-state">当前没有正在升温的高意向用户<br>可在「全部会员」中浏览</div>';

      // 数据层级分布（开发者视角）
      if (currentRole === 'developer' && levelRes && levelRes.data) {
        $('levelGrid').innerHTML = levelRes.data.stats.map((s) => `
          <div class="level-card">
            <span class="lv-code lv-${s.code}">${s.code}</span>
            <div class="lv-name">${esc(s.name)}</div>
            <div class="lv-desc">${esc(s.desc)}</div>
            <div class="lv-count">${Number(s.count || 0).toLocaleString()} <small>条</small></div>
            <div class="lv-flag">CA 可见：${s.caVisible ? '<span class="yes">是</span>' : '<span class="no">否</span>'}${s.needConsent ? ' · 需用户授权' : ''}</div>
          </div>`).join('');
      }
    } catch (err) {
      console.error(err);
      $('summaryList').innerHTML = '<div class="empty-state">加载失败：' + esc(err.message) + '</div>';
    }
  }

  function activate() {
    if (!loaded) { loaded = true; refresh(); }
  }

  return { activate, refresh };
})();

/* ============================================================
   视图二：用户列表
   ============================================================ */
const Users = (() => {
  const TAB_META = { hot: '今日重点', followup: '待跟进', all: '全部会员' };
  const PAGE_SIZE = 20;
  let curTab = 'hot';
  let curPage = 1;

  function renderTabs() {
    document.querySelectorAll('#userTabs .tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === curTab));
  }

  function pill(p) {
    if (p >= 100) return `<span class="pill pill-red">🔥 ${p}</span>`;
    if (p >= 60) return `<span class="pill pill-amber">${p}</span>`;
    if (p >= 30) return `<span class="pill pill-blue">${p}</span>`;
    return `<span class="pill pill-gray">${p}</span>`;
  }

  function rowHTML(u) {
    const signals = [];
    if (u.isHeatingUp) signals.push('<span class="pill pill-red">⚡ 升温</span>');
    if (u.todayScore > 0) signals.push(`<span class="pill pill-blue">近48h ${Math.round(u.todayScore)}分</span>`);
    if (!signals.length) signals.push('<span class="pill pill-gray">—</span>');

    const fu = u.followUp
      ? `<span class="fu-tag">📌 ${esc(u.followUp.plan_time)}</span>`
      : '<span class="pill pill-gray">未预约</span>';

    return `<tr data-key="${esc(u.key)}" data-name="${esc(u.displayName)}">
      <td>
        <div class="user-cell">
          <div class="avatar-sm">${esc(u.displayName[0])}</div>
          <div class="u">
            <span class="u-name">${esc(u.displayName)}</span>
            <span class="u-id">${esc((u.uid || u.aid || '').slice(0, 16))}</span>
          </div>
        </div>
      </td>
      <td class="col-hide-mobile">${u.score}</td>
      <td class="col-hide-mobile">×${u.momentum}</td>
      <td class="col-hide-mobile"><div class="score-cell">${pill(u.priority)}<div class="score-bar-wrap"><div class="score-bar" style="width:${Math.min(100, u.priority)}%"></div></div></div></td>
      <td>${signals.join('')}</td>
      <td class="col-hide-mobile">${u.behaviorCount}</td>
      <td class="col-hide-mobile">${fu}</td>
      <td>
        <div class="row-actions">
          <button class="btn btn-sm btn-primary" data-action="followup">预约跟进</button>
          <button class="btn btn-sm btn-outline" data-action="detail">详情</button>
        </div>
      </td>
    </tr>`;
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
      $('tableBody').innerHTML = list.length
        ? list.map(rowHTML).join('')
        : '<tr><td colspan="8"><div class="empty-state">「' + TAB_META[curTab] + '」暂无用户</div></td></tr>';

      const totalPages = Math.max(1, Math.ceil(total / size));
      $('pageInfo').textContent = `第 ${page} / ${totalPages} 页 · 共 ${total} 位用户`;
    } catch (err) {
      console.error(err);
      $('tableBody').innerHTML = '<tr><td colspan="9"><div class="empty-state">加载失败：' + esc(err.message) + '</div></td></tr>';
    }
  }

  function activate(tab) {
    if (tab && TAB_META[tab]) curTab = tab;
    curPage = 1;
    renderTabs();
    refresh();
  }

  function setPage(delta) {
    curPage = Math.max(1, curPage + delta);
    refresh();
  }

  return { activate, refresh, setPage };
})();

// Tab 切换 → 同步到 hash，由路由统一驱动
$('userTabs').addEventListener('click', (e) => {
  const btn = e.target.closest('.tab');
  if (!btn) return;
  go('#/users?tab=' + btn.dataset.tab);
});

// 表格行 / 行内按钮
$('tableBody').addEventListener('click', (e) => {
  const tr = e.target.closest('tr[data-key]');
  if (!tr) return;
  const key = tr.dataset.key;
  const name = tr.dataset.name;
  const act = e.target.closest('[data-action]');
  if (act && act.dataset.action === 'followup') { openFollowUp(key, name); return; }
  go('#/user?key=' + encodeURIComponent(key));
});

// 分页
document.querySelectorAll('[data-page]').forEach((btn) => {
  btn.addEventListener('click', () => {
    Users.setPage(Number(btn.dataset.page));
  });
});

/* ============================================================
   视图三：用户详情
   ============================================================ */
const UserDetail = (() => {
  let curKey = '';
  let userData = null;

  function openGate() {
    $('userRoot').innerHTML = `
      <div class="key-gate-wrap">
        <div class="key-gate">
          <div class="kg-icon">🔎</div>
          <div class="kg-title">查询用户详情</div>
          <div class="kg-sub">
            请输入要查看的用户 <b>key</b>，或直接在地址栏带上参数访问<br>
            <span class="mono">/sales#/user?key=xxxx</span>
          </div>
          <div class="kg-form">
            <input class="kg-input" id="keyInput" type="text" autocomplete="off" spellcheck="false" placeholder="请输入用户 key，例如 e46092e8-8c66-4208-add3-80e062b6a774">
            <button class="btn btn-primary" data-action="gate-go">查询</button>
          </div>
          <div class="kg-hint">提示：也可以从「用户列表」点击任一用户直接进入</div>
        </div>
      </div>`;
    const input = $('keyInput');
    if (input) {
      input.focus();
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitGate(); });
    }
  }

  function submitGate() {
    const input = $('keyInput');
    if (!input) return;
    const v = input.value.trim();
    if (!v) { input.focus(); return; }
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
    // 详情视图把顶部标题换成客户名，更贴近设计稿的详情页头部
    const hdTitle = $('pageTitle');
    if (hdTitle) hdTitle.textContent = u.displayName || '客户详情';
    const hdSub = $('pageSub');
    if (hdSub) hdSub.textContent = '客户详情 · 意向快照与跟进建议';

    const signals = [];
    if (u.isHeatingUp) signals.push('<span class="pill pill-red">⚡ 正在升温</span>');

    const suggestions = buildSuggestions(u).map((s, i) =>
      `<div class="suggest-item"><div class="s-label">建议 ${i + 1}</div><div class="s-text">${esc(s)}</div></div>`
    ).join('');

    const details = (u.scoreDetails || []).map((d) =>
      `<div class="detail-row"><span class="d-label">${esc(d.label)}</span><span class="d-event">${esc(d.event)}</span><span class="d-point">+${d.point}</span></div>`
    ).join('') || '<div class="empty-state">暂无评分明细</div>';

    // 行为时间线：仅「开发者」视角渲染该模块，老板娘 / 穿搭师视角整块隐藏
    const canViewTimeline = currentRole === 'developer';
    const timeline = canViewTimeline ? (u.timeline || []).map((t) => {
      const extraStr = Object.keys(t.extra || {}).length
        ? `<div class="tl-extra">${Object.entries(t.extra).map(([k, v]) => `${esc(k)}: ${esc(typeof v === 'object' ? JSON.stringify(v) : v)}`).join(' · ')}</div>`
        : '';
      return `<div class="tl-item"><div class="tl-time">${esc(t.formattedTime)}</div><div class="tl-event">${esc(t.event)}${t.eventMsg ? `<span class="tag">${esc(t.eventMsg)}</span>` : ''}</div>${extraStr}</div>`;
    }).join('') : '';

    const fus = u.followUps || [];
    const fuHTML = fus.length ? fus.map((f) => {
      const st = f.status === 'pending' ? '<span class="fu-status fu-pending">待跟进</span>'
        : f.status === 'done' ? '<span class="fu-status fu-done">已完成</span>'
        : '<span class="fu-status fu-canceled">已取消</span>';
      const act = f.status === 'pending'
        ? `<div style="display:flex;gap:6px;">${st}<button class="btn btn-sm btn-outline" data-action="fu-status" data-id="${f.id}" data-status="done">完成</button><button class="btn btn-sm btn-outline" data-action="fu-status" data-id="${f.id}" data-status="canceled">取消</button></div>`
        : st;
      return `<div class="fu-item"><div><div class="fu-info">📌 ${esc(f.plan_time || '未设时间')}${f.note ? ` · ${esc(f.note)}` : ''}</div><div class="fu-plan">${fmtFullTime(f.created_at)} 创建</div></div>${act}</div>`;
    }).join('') : '<div class="empty-state">暂无跟进记录，点击右上角「预约跟进」</div>';

    $('userRoot').innerHTML = `
      <a class="back-link" href="#/users">← 返回列表</a>

      <!-- 用户头部 -->
      <div class="user-hero">
        <div class="u-info">
          <div class="avatar-lg">${esc(u.displayName[0])}</div>
          <div>
            <div style="display:flex;align-items:center;gap:10px;">
              <span class="u-name-lg">${esc(u.displayName)}</span>
              ${signals.join('')}
            </div>
            <div class="u-id-lg">${esc(u.uid || '')} · ${esc(u.aid || '')}</div>
            <div class="u-tags">
              <span class="pill pill-red">意向分 ${u.score}</span>
              <span class="pill pill-red">优先级 ${u.priority}</span>
              <span class="pill pill-green">加速 ×${u.momentum}</span>
              <span class="pill pill-green">${u.behaviorCount} 次行为</span>
              <span class="pill pill-green">${u.openDays} 天活跃</span>
            </div>
          </div>
        </div>
        <div class="u-actions">
          <button class="btn btn-green" data-action="gen">🎨 制作下一套穿搭</button>
          <button class="btn btn-primary" data-action="followup">📌 预约跟进</button>
        </div>
      </div>

      <!-- 指标 -->
      <div class="metrics-row">
        <div class="metric-card"><div class="mk">意向分 IntentScore</div><div class="mv hot">${u.score}</div><div class="md">Σ W×F×R</div></div>
        <div class="metric-card"><div class="mk">意向加速 Momentum</div><div class="mv">×${u.momentum}</div><div class="md">近 48h 活跃窗口</div></div>
        <div class="metric-card"><div class="mk">综合优先级</div><div class="mv">${u.priority}</div><div class="md">IntentScore × Momentum</div></div>
      </div>

      <!-- 双栏 -->
      <div class="grid-2">
        <div>
          ${canViewTimeline ? `<div class="card" style="margin-bottom:20px;">
            <div class="card-title">📜 行为时间线 <span class="sub">最近 50 条</span></div>
            <div class="timeline" style="max-height:420px;overflow-y:auto;">${timeline || '<div class="empty-state">暂无行为记录</div>'}</div>
          </div>` : ''}
          <div class="card">
            <div class="card-title">🧮 评分明细 <span class="sub">IntentScore = Σ(W×F×R)</span></div>
            <div style="max-height:300px;overflow-y:auto;">${details}</div>
          </div>
        </div>
        <div>
          <div class="card" style="margin-bottom:20px;">
            <div class="card-title">💬 建议话术</div>
            ${suggestions}
          </div>
          <div class="card">
            <div class="card-title">📌 跟进记录</div>
            ${fuHTML}
          </div>
        </div>
      </div>`;
  }

  async function load() {
    if (!curKey) { openGate(); return; }
    $('userRoot').innerHTML = '<div class="loading"><div class="spinner"></div>加载用户数据…</div>';
    try {
      const json = await apiFetch(`/api/intent/user?key=${encodeURIComponent(curKey)}`);
      if (json.code !== 0 || !json.data) throw new Error(json.msg || '未找到用户');
      userData = json.data;
      render(json.data);
    } catch (err) {
      $('userRoot').innerHTML = `<div class="empty-state">加载失败：${esc(err.message)}<div style="margin-top:16px;"><button class="btn btn-outline" data-action="gate">重新输入 key</button></div></div>`;
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

  function activate(key) {
    if (key) curKey = key;
    load();
  }

  function refresh() { if (curKey) load(); }

  // 详情视图内的动作委托
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

  function getData() { return userData; }

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
    looks.push(`<div class="item">🎨 方案 ${i + 1}：${itemsArr.join(' + ')}<br><span style="color:var(--green);font-weight:600;">参考价 ¥${total.toLocaleString()}</span></div>`);
  }
  $('genResult').innerHTML = `<div class="gen-result"><div style="font-size:12px;color:var(--text-muted);margin-bottom:6px;">基于【${esc(u.displayName)}】的收藏/浏览偏好生成：</div>${looks.join('')}<div style="padding-top:8px;color:var(--text-muted);font-size:12px;">💡 可微调后通过企业微信发送给用户</div></div>`;
});

/* ================= 启动 =================
   先确认登录会话，再按会话角色渲染；未登录直接进入登录页，不加载任何用户数据 */
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

  // 定时刷新（仅刷新当前视图）
  let tickCount = 0;
  setInterval(() => {
    tickCount++;
    if (currentView === 'overview') Overview.refresh();
    else if (currentView === 'users' && tickCount % 2 === 0) Users.refresh();
  }, 30000);
}

bootstrap();
