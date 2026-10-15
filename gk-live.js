/* ============================================================
   gk-live.js  v2  ——  三层数据：接口 → 本地快照 → 页面内置
   ------------------------------------------------------------
   给 jiuchu.github.io/gkzy/ 用。零依赖、零构建，一个 <script> 就完事。

   接线（只需改你页面里两处）：
     1) 在主脚本之后加：<script src="gk-live.js"></script>
     2) 在 showInfo(k) 的结尾加一行：
          GK.enhance(u, document.querySelector("#sheet .sheet-h"));
        （u 就是 findUni(k) 拿到的那条 DB 数组）

   三层含义：
     T1 实时接口  mnzy.gaokao.cn/api  —— CORS 是 * ，github.io 可直连，无需代理
     T2 本地快照  你仓库里的 gk_data.json —— 接口挂了用它，同源，不限流
     T3 页面内置  你已有的 DB / FEE / MAJ —— 最后兜底，永远不空
   每层都要能单独失败，且失败时页面照常显示。
   ============================================================ */
const GK = (() => {

  /* ---------- 配置：明年 6 月重爬之后只改这两行 ---------- */
  const API = 'https://mnzy.gaokao.cn/api';
  const SNAPSHOT_URL = 'gk_data.json';        // 相对页面路径，放 /gkzy/ 下即可
  const LIVE_TTL_MS = 7 * 864e5;              // 实时结果本地缓存 7 天
  const CODE_TTL_MS = 180 * 864e5;            // 院校代码基本不变，缓存半年
  const LIVE_TIMEOUT_MS = 9000;

  /* 考生口径：湖北 · 历史类 · 再选政治+地理。batch 由调用方按 DB[7] 传，不写死 */
  const CTX = {
    province: '湖北', classify: '历史', subjects: '历史,政治,地理', gradeType: '',
  };
  const BATCH = { zk: '专科批', bk: '本科批' };
  /* 查分数用哪个值不重要（只影响录取概率字段），但必须是合法数字 */
  const PROBE = { score: 435, rank: 58633 };

  const LS_CODE = 'gk_code_v2';
  const LS_LIVE = 'gk_live_v2';

  /* ---------- 小工具 ---------- */
  const enc = o => Object.entries(o)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&');

  /* 'sv' locale 恒为 YYYY-MM-DD 且按本地时区；toISOString 会把凌晨算成前一天 */
  const today = () => new Date().toLocaleDateString('sv');

  const lsget = k => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } };
  const lsset = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };

  async function timed(p, o, ms) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), ms || LIVE_TIMEOUT_MS);
    try {
      const r = await fetch(API + p + '?' + enc(o), { signal: ac.signal });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      /* 注意：这个后端「200 + 空」是常态（踩过两次），空即视为失败 */
      if (j.code !== 200) throw new Error('code ' + j.code + ' ' + (j.msg || ''));
      return j.body;
    } finally { clearTimeout(t); }
  }

  /* ---------- 字段归一：接口用 branches/histories，快照用 majors/history ---------- */
  const norm = g => ({
    group: g.universityMajorGroup || g.group,
    planCount: g.planCount != null ? g.planCount : null,
    majors: (g.branches || g.majors || []).map(b => ({
      code: b.majorCode != null ? b.majorCode : b.code,
      name: b.majorName != null ? b.majorName : b.name,
      remark: b.majorRemarks != null ? b.majorRemarks : (b.remark || ''),
      cost: b.studyCost != null ? b.studyCost : b.cost,
      year: b.studyYear != null ? b.studyYear : b.year,
      plan: b.branchPlanNum != null ? b.branchPlanNum : b.plan,
      property: b.propertyName != null ? b.propertyName : b.property,
    })),
    history: (g.histories || g.history || []).map(h => ({
      year: h.year, minScore: h.minScore, minPlace: h.minPlace, plan: h.recruitCount != null ? h.recruitCount : h.plan,
    })),
  });

  const usable = gs => gs && gs.length &&
    gs.some(g => g.majors.length && g.majors.some(m => m.cost != null && m.cost !== ''));

  /* ============================================================
     T1 实时接口
     ============================================================ */

  /* 第 1 步：校名 -> 院校基码 + zsgkId。列表被硬截 3 条，但任一条都带全码 */
  async function resolve(name, batch) {
    const c = lsget(LS_CODE) || {};
    const key = batch + '|' + name;
    if (c[key] && Date.now() - c[key].at < CODE_TTL_MS) return c[key];

    const bs = BATCH[batch] || batch;
    for (const sc of [PROBE.score, 300, 520, 200, 600]) {
      for (const tp of ['NAN', 'WEN', 'CHONG', 'BAO', 'YI']) {
        let body;
        try {
          body = await timed('/pc/v2/v1/query/recommendPage',
            { ...CTX, batch: bs, score: sc, rank: 1, universityName: name, type: tp });
        } catch (e) { continue; }
        const x = ((body && body.list) || [])
          .find(y => y.universityName && (y.universityName.indexOf(name) >= 0 || name.indexOf(y.universityName) >= 0));
        if (x && x.zsgkId && x.recruitCode && x.universityMajorGroup) {
          const v = {
            base: x.recruitCode.slice(0, -x.universityMajorGroup.length),
            zsgkId: x.zsgkId, total: (body.total || 0) || 0, at: Date.now(),
          };
          c[key] = v; lsset(LS_CODE, c);
          return v;
        }
      }
    }
    return null;
  }
  /* 第 2 步：专业组全码 = 基码 + 两位组号，直接构造（绕开 3 条上限），空组自然返回空 */
  async function probe(name, batch) {
    const r = await resolve(name, batch);
    if (!r) return null;
    const bs = BATCH[batch] || batch;
    /* 组号不连续（湖北民族大学是 01 02 18 20 21 23），构造范围要够宽 */
    const upper = Math.min(30, Math.max(24, (r.total || 0) + 6));
    const out = [];
    for (let i = 1; i <= upper; i++) {
      const g = String(i).padStart(2, '0');
      let body;
      try {
        body = await timed('/pc/v2/v2/query/universityAnalysis', {
          ...CTX, batch: bs, score: PROBE.score, rank: PROBE.rank,
          universityCode: r.base + g, recruitCode: r.base + g,
          universityMajorGroup: g, guid: r.base + g + g, zsgkId: r.zsgkId, universityName: name,
        });
      } catch (e) { continue; }
      const one = body && body[0];
      if (one && (one.branches || []).length) out.push(norm(one));
    }
    return usable(out) ? out : null;
  }

  async function liveGroups(name, batch) {
    const ck = lsget(LS_LIVE) || {}, key = batch + '|' + name;
    const hit = ck[key];
    if (hit && Date.now() - hit.at < LIVE_TTL_MS && usable(hit.groups)) return hit.groups;

    /* 职业大学常同时招本科和专科；DB 里的批次标错了就换一批次再试一次 */
    let g = await probe(name, batch);
    if (!g && BATCH[batch]) g = await probe(name, batch === 'bk' ? 'zk' : 'bk');
    if (!g) return null;
    ck[key] = { at: Date.now(), groups: g }; lsset(LS_LIVE, ck);
    return g;
  }

  /* ============================================================
     T2 本地快照
     两种来源，优先内联：
       window.GK_SNAP —— 单文件部署时把快照直接写进 HTML（可放在本脚本之前）
       gk_data.json   —— 三文件部署时懒加载，HTML 保持轻量（推荐）
     ============================================================ */
  function indexSnap(j) {
    if (!j) return null;
    const rows = Array.isArray(j) ? j : (j.rows || null);
    const at = Array.isArray(j) ? null : (j.at || j.generatedAt || null);
    const m = {};
    (rows || []).forEach(o => {
      if (!o || !o.name || !o.groups) return;
      m[(o.batch || 'zk') + '|' + o.name] = { groups: o.groups.map(norm), at: at };
    });
    return Object.keys(m).length ? { map: m, at: at } : null;
  }

  let snapP = null;
  function snapshot() {
    if (snapP) return snapP;
    if (typeof window !== 'undefined' && window.GK_SNAP) {
      snapP = Promise.resolve(indexSnap(window.GK_SNAP));
      return snapP;
    }
    snapP = fetch(SNAPSHOT_URL).then(r => (r.ok ? r.json() : null)).then(indexSnap)
      .catch(() => null);
    return snapP;
  }

  async function snapGroups(name, batch) {
    const s = await snapshot();
    if (!s) return null;
    const e = s.map[batch + '|' + name];
    return e && usable(e.groups) ? e.groups : null;
  }

  /* ============================================================
     取数：逐层降级，返回 {groups, src, stamp}
     src: 'live' | 'snapshot' | 'inline'
     ============================================================ */
  async function fetchGroups(name, batch) {
    try {
      const g = await liveGroups(name, batch);
      if (g) return { groups: g, src: 'live', stamp: today() };
    } catch (e) { /* 接口挂了，往下走 */ }
    const s = await snapshot();
    const e = s && s.map[batch + '|' + name];
    if (e && usable(e.groups)) return { groups: e.groups, src: 'snapshot', stamp: s.at };
    return null;   /* T3：调用方保留页面内置渲染 */
  }

  /* ============================================================
     渲染
     ============================================================ */
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  /* 学费有 56 条是「待定」这种非数字串，原样显示、不进区间统计 */
  const feeNum = v => { const n = Number(v); return (v == null || v === '' || isNaN(n)) ? null : n; };
  const money = v => (v == null || v === '' ? '—' : (feeNum(v) == null ? String(v) : feeNum(v).toLocaleString('en-US') + ' 元/年'));
  const SRC_NAME = { live: '实时接口', snapshot: '本地快照', inline: '内置数据' };

  const CSS = `
.gk-src{margin:10px 0 2px;font-size:12px;color:#666;display:flex;justify-content:space-between;gap:8px;align-items:center;border-top:1px dashed #e0e3e7;padding-top:9px}
.gk-src b{font-weight:600;color:#0b7a45}
.gk-src.off b{color:#b06a00}
.gk-grp{margin:12px 0 2px}
.gk-grp h4{font-size:13px;margin:0 0 6px;color:#333;font-weight:600}
.gk-t{width:100%;border-collapse:collapse;font-size:12px;table-layout:fixed}
.gk-t th{background:#f4f6f8;padding:5px 6px;text-align:left;font-weight:600;border-bottom:1px solid #e3e6ea}
.gk-t td{padding:5px 6px;border-bottom:1px solid #eef0f3;vertical-align:top;word-break:break-word}
.gk-t td i{display:block;color:#8a8f96;font-style:normal;font-size:11px}
.gk-t td s{display:block;color:#9aa0a6;text-decoration:none;font-size:11px}
.gk-t .fee{color:#0b7a45;font-weight:600}
.gk-t .na{color:#b9bec4}
.gk-load{font-size:12px;color:#8a8f96;margin:10px 0 0}
.gk-years{color:#8a8f96;font-weight:400;font-size:11px}
.gk-note{margin:6px 0 0;color:#8a8f96;font-size:11px;line-height:1.5}
.gk-warn{color:#b06a00}
.gk-hi{color:#b06a00;font-weight:600}
.gk-lo{color:#0a7d43}`;

  function render(gs, src, stamp) {
    const yrs = [...new Set(gs.flatMap(g => g.history.map(h => h.year)))].sort();
    const fees = [...new Set(gs.flatMap(g => g.majors.map(m => feeNum(m.cost)).filter(x => x)))].sort((a, b) => a - b);

    let h = '<div class="gk-src' + (src === 'live' ? '' : ' off') + '">' +
      '<span>数据来源 <b>' + SRC_NAME[src] + '</b>' +
      (stamp ? ' · 截至 ' + esc(String(stamp).slice(0, 10)) : '') +
      ' · ' + gs.length + ' 个专业组</span>' +
      '<span>学费 ' + (fees.length ? money(fees[0]) + (fees.length > 1 ? '—' + money(fees[fees.length - 1]) : '') : '—') + '</span></div>';

    gs.forEach(g => {
      h += '<div class="gk-grp"><h4>' + esc(g.group) + ' 组 · 计划 ' + (g.planCount == null ? '—' : g.planCount) + ' 人 · ' +
        g.majors.length + ' 个专业 <span class="gk-years">' + yrs.join('/') + '</span></h4>' +
        '<table class="gk-t"><tr><th>专业</th><th>学费</th><th>学制</th><th>计划</th>' +
        yrs.map(y => '<th>' + y + '</th>').join('') + '</tr>' +
        g.majors.map(m => '<tr><td>' + esc(m.name) + (m.remark ? '<i>' + esc(m.remark) + '</i>' : '') + '</td>' +
          '<td class="' + (m.cost ? 'fee' : 'na') + '">' + money(m.cost) +
          /* 公办却收到 3 万以上、备注里又没有中外合作/联合培养——源数据可疑，别让他在手机上自己猜 */
          (m.property === '公办' && feeNum(m.cost) >= 30000 && !/中外|合作|联合|国际/.test(m.remark || '')
            ? '<i class="gk-warn">以招生简章为准</i>' : '') + '</td>' +
          '<td>' + esc(m.year || '—') + '</td><td>' + (m.plan || '—') + '</td>' +
          yrs.map(y => {
            const x = g.history.find(k => String(k.year) === String(y));
            return '<td>' + (x && x.minScore != null ? x.minScore + '<s>位次 ' + (x.minPlace == null ? '—' : x.minPlace) + '</s>' : '<span class="na">—</span>') + '</td>';
          }).join('') + '</tr>').join('') +
        '</table></div>';
    });
    return h;
  }

  /* ============================================================
     入口：底座先渲染（你原来的 showInfo 已经渲染完），这里只追加覆盖层
     ============================================================ */
  let token = 0;

  /* ---------- 历年投档线：主站院校页爬下来的，覆盖全部 2991 所，不依赖接口 ---------- */
  const LINES_URL = 'lines.json';
  let linesP = null;
  function linesData() {
    if (linesP) return linesP;
    if (typeof window !== 'undefined' && window.GK_LINES) { linesP = Promise.resolve(window.GK_LINES); return linesP; }
    linesP = fetch(LINES_URL).then(r => (r.ok ? r.json() : null)).catch(() => null);
    return linesP;
  }

  /* 键 = 校名|组号|批次码|升学类型，必须和 gk_lines_export.js 的 lineKey 一致：
     本科批 05 组和专科批 05 组、普通类和中外合作办学的 05 组都不是同一个组 */
  function lineKeyOf(u) {
    const g = String(u[5] || '').replace(/[^0-9L]/g, '').replace(/^L/, '');
    return u[0] + '|' + g + '|' + u[7] + '|' + (u[9] || '');
  }
  function lineHtml(u) {
    const rows = ((typeof window !== 'undefined' && window.__GK_LINES) || {})[lineKeyOf(u)];
    if (!rows || !rows.length) return '';
    const byYear = {};
    rows.forEach(r => { (byYear[r.y] = byYear[r.y] || []).push(r); });
    const ys = Object.keys(byYear).sort((a, b) => b - a).slice(0, 3);
    const cell = r => '<td>' + (r ? r.min + (r.place > 0 ? '<s>位次 ' + r.place + '</s>' : '<s>位次 —</s>')
      : '<span class="na">—</span>') + '</td>';
    const pick = y => byYear[y].reduce((a, b) => (Number(b.min) > Number(a.min) ? b : a), byYear[y][0]);
    const rows3 = [
      ['投档线/位次', r => cell(r)],
      ['批次·类型', r => '<td>' + esc(r.zslx === '普通类' ? r.b : r.b + '·' + r.zslx) + '</td>'],
      ['再选要求', r => '<td>' + esc(r.info || '—') + '</td>'],
    ];
    return '<div class="gk-grp"><h4>历年在湖北（历史类）投档线 <span class="gk-years">平行志愿投档最低分</span></h4>' +
      '<table class="gk-t"><tr><th>年份</th>' + ys.map(y => '<th>' + y + '</th>').join('') + '</tr>' +
      rows3.map(f => '<tr><td>' + f[0] + '</td>' + ys.map(y => f[1](pick(y))).join('') + '</tr>').join('') +
      '</table>' +
      (ys.length < 3 ? '<div class="gk-note">只对齐同一组号的年份。组号由高校每年重新编排，缺的年份多半是这组改了号，不是没招生。</div>' : '') +
      '</div>';
  }

  /* ---------- 校园配置正文：第三方整理的静态快照，本地文件，没有实时层 ---------- */
  const FAC_URL = 'facilities.json';
  let facP = null;
  function facData() {
    if (facP) return facP;
    if (typeof window !== 'undefined' && window.GK_FAC) { facP = Promise.resolve(window.GK_FAC); return facP; }
    facP = fetch(FAC_URL).then(r => (r.ok ? r.json() : null)).catch(() => null);
    return facP;
  }

  /* ---------- 组内专业录取线：主站 score/special，参数 local_type_id=2074 才是历史类 ---------- */
  const SPECIAL_URL = 'special.json';
  let spP = null;
  function specialData() {
    if (spP) return spP;
    if (typeof window !== 'undefined' && window.GK_SPECIAL) { spP = Promise.resolve(window.GK_SPECIAL); return spP; }
    spP = fetch(SPECIAL_URL).then(r => (r.ok ? r.json() : null)).catch(() => null);
    return spP;
  }
  function spHtml(u) {
    const o = ((typeof window !== 'undefined' && window.__GK_SPECIAL) || {})[lineKeyOf(u)];
    if (!o || !o.m || !o.m.length) return '';
    const rows = o.m.map(x => {
      const d = o.line ? x[1][0] - o.line : null;
      return '<tr><td>' + esc(x[0]) + '</td><td>' + x[1][0] +
        (x[1][1] ? '<s>位次 ' + x[1][1] + '</s>' : '<s>位次 —</s>') + '</td><td>' +
        (d === null ? '<span class="na">—</span>'
          : d > 0 ? '<b class="gk-hi">高 ' + d + ' 分</b>' : '<span class="gk-lo">压组线</span>') + '</td></tr>';
    }).join('');
    return '<div class="gk-grp"><h4>组内专业录取线 <span class="gk-years">' + o.y + ' 年 · 最低分 / 位次</span></h4>' +
      '<table class="gk-t"><tr><th>专业</th><th>最低分</th><th>比当年组线</th></tr>' + rows + '</table>' +
      '<div class="gk-note">这是 ' + o.y + ' 年的专业级数据——和上面那张表里的 2024/2025/2026 不是一回事，' +
      '那三列是<b>整个专业组</b>的投档线，这张表才是<b>每个专业各自</b>的最低分。' +
      '「比组线高 N 分」意思是：这个专业要比院校专业组的投档线再多 N 分才录得上——' +
      '<b>进得去组不等于读得到想读的专业</b>，差值越大的专业越容易被调剂走。' +
      (o.line ? '（' + o.y + ' 年组线 ' + o.line + ' 分）' : '（该年组线未公开，差值不算）') + '</div></div>';
  }

  async function enhance(u, host) {
    if (!u || !host) return;
    const name = u[0], batch = u[7];
    if (!document.getElementById('gk-css')) {
      const s = document.createElement('style'); s.id = 'gk-css'; s.textContent = CSS; document.head.appendChild(s);
    }
    const my = ++token;
    const slot = document.createElement('div');
    slot.innerHTML = '<div class="gk-load">正在读取实时数据…</div>';
    host.parentNode.insertBefore(slot, host.nextSibling);

    /* 历年线先挂：本地文件秒出，接口挂了它也在 */
    const lslot = document.createElement('div');
    host.parentNode.insertBefore(lslot, slot);
    const L = await linesData();
    if (my !== token) return;
    if (L) {
      window.__GK_LINES = L;
      lslot.innerHTML = lineHtml(u);
    }
    /* 专业线跟在后面，同一个本地文件通道，接口挂了照样出 */
    const S = await specialData();
    if (my !== token) return;
    if (S) {
      window.__GK_SPECIAL = S;
      lslot.innerHTML = lineHtml(u) + spHtml(u);
    }

    let r = null;
    try { r = await fetchGroups(name, batch); } catch (e) { r = null; }
    if (my !== token) return;                 // 面板已切走，丢弃
    if (!r) {
      slot.innerHTML = '<div class="gk-src off"><span>数据来源 <b>内置数据</b> · 实时接口与本地快照均未返回</span></div>';
      return;
    }
    slot.innerHTML = render(r.groups, r.src, r.stamp);
  }

  return { enhance, fetchGroups, liveGroups, resolve, snapshot, linesData, specialData, facData, CTX, BATCH, SNAPSHOT_URL };
})();
