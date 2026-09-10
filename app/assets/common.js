/* ============================================================
   流量总台 · 内容生产线 — 共享交互原语 (依据 DOC-02 §2 / DOC-07 §6)
   ============================================================ */
(function () {
  'use strict';

  /* ---------- 本地持久层(模拟后端) ---------- */
  const NS = 'cpl.v1.';
  const store = {
    get(key, fallback) {
      try { const v = localStorage.getItem(NS + key); return v === null ? fallback : JSON.parse(v); }
      catch (e) { return fallback; }
    },
    set(key, val) { try { localStorage.setItem(NS + key, JSON.stringify(val)); } catch (e) {} },
  };

  /* ---------- 工具 ---------- */
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => [...(root || document).querySelectorAll(sel)];
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtW = (n) => (n >= 10000 ? (n / 10000).toFixed(1).replace(/\.0$/, '') + 'w' : String(n));

  /* ---------- Toast (DOC-07 §6: toast 带下一步指引) ---------- */
  let toastBox = null;
  function toast(msg, ok = true) {
    if (!toastBox) { toastBox = document.createElement('div'); toastBox.className = 'toasts'; document.body.appendChild(toastBox); }
    const el = document.createElement('div');
    el.className = 'toast' + (ok ? ' ok' : '');
    el.innerHTML = msg;
    toastBox.appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; setTimeout(() => el.remove(), 320); }, 2600);
  }

  /* ---------- 复制: 成功按钮变「已复制 ✓」1.5s; 剪贴板不可用降级全选 ---------- */
  async function copyText(text, btn) {
    let ok = true;
    try { await navigator.clipboard.writeText(text); }
    catch (e) {
      ok = false;
      const ta = document.createElement('textarea');
      ta.value = text; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); ok = true; } catch (e2) { ok = false; }
      ta.remove();
    }
    if (btn) {
      const old = btn.innerHTML;
      btn.innerHTML = ok ? '已复制 ✓' : '请手动复制';
      btn.disabled = true;
      setTimeout(() => { btn.innerHTML = old; btn.disabled = false; }, 1500);
    }
    toast(ok ? '已复制到剪贴板' : '剪贴板不可用, 已全选文本, 请手动复制', ok);
    return ok;
  }

  /* ---------- 确认弹层 (非浏览器原生; 说明可恢复期限) ---------- */
  function confirmDialog({ title, body, okText = '确认', danger = false, cancelText = '再想想' }) {
    return new Promise((resolve) => {
      const ov = document.createElement('div');
      ov.className = 'overlay';
      ov.innerHTML = `
        <div class="modal" role="dialog" aria-modal="true" aria-label="${esc(title)}">
          <div class="modal-head">
            <div><div class="modal-title">${esc(title)}</div>${body ? `<div class="modal-sub">${body}</div>` : ''}</div>
          </div>
          <div class="modal-foot">
            <button class="btn btn-ghost" data-act="no">${esc(cancelText)}</button>
            <button class="btn ${danger ? 'btn-danger' : ''}" data-act="yes">${esc(okText)}</button>
          </div>
        </div>`;
      document.body.appendChild(ov);
      const done = (v) => { ov.remove(); document.removeEventListener('keydown', onKey); resolve(v); };
      const onKey = (e) => { if (e.key === 'Escape') done(false); if (e.key === 'Enter') done(true); };
      document.addEventListener('keydown', onKey);
      ov.addEventListener('click', (e) => { if (e.target === ov) done(false); });
      ov.querySelector('[data-act="no"]').onclick = () => done(false);
      ov.querySelector('[data-act="yes"]').onclick = () => done(true);
      ov.querySelector('[data-act="yes"]').focus();
    });
  }

  /* ---------- 通用模态 ---------- */
  function openModal(html, { large = false, onClose } = {}) {
    const ov = document.createElement('div');
    ov.className = 'overlay';
    ov.innerHTML = `<div class="modal ${large ? 'modal-lg' : ''}" role="dialog" aria-modal="true">${html}</div>`;
    document.body.appendChild(ov);
    document.body.style.overflow = 'hidden';
    const close = () => { ov.remove(); document.body.style.overflow = ''; document.removeEventListener('keydown', onKey); onClose && onClose(); };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    ov.addEventListener('click', (e) => { if (e.target === ov) close(); });
    $$('.modal-x', ov).forEach((b) => (b.onclick = close));
    return { el: ov, close };
  }

  /* ---------- 标已发: 锁定「已发 ✓」不可撤销 + toast 说明数据后果 ---------- */
  function markPublished(btn, consequence) {
    if (!btn || btn.classList.contains('locked')) return false;
    btn.classList.add('locked');
    btn.disabled = true;
    btn.innerHTML = '已发 ✓';
    toast(consequence || '已记入发布记账 —— 水位与进度已回写');
    return true;
  }

  /* ---------- 生成类按钮: loading + 「生成中…」 ---------- */
  function withLoading(btn, label, fn) {
    if (btn.classList.contains('is-loading')) return;
    const old = btn.innerHTML;
    btn.classList.add('is-loading');
    btn.innerHTML = label || '生成中…';
    const done = (newLabel) => { btn.classList.remove('is-loading'); btn.innerHTML = newLabel || old; };
    return fn(done);
  }

  /* ---------- 原创度检测(真实实现): 与对标原文的连续 8 字重合片段占比, 阈值 15% ---------- */
  function originality(draft, source) {
    const clean = (s) => String(s).replace(/[\s\p{P}\p{S}]/gu, '');
    const a = clean(draft), b = clean(source);
    if (!a.length || !b.length) return { ratio: 0, pass: true };
    const grams = new Set();
    for (let i = 0; i + 8 <= b.length; i++) grams.add(b.substr(i, 8));
    let hit = 0;
    for (let i = 0; i + 8 <= a.length; i++) if (grams.has(a.substr(i, 8))) hit++;
    const ratio = a.length >= 8 ? hit / (a.length - 7) : 0;
    return { ratio: Math.round(ratio * 1000) / 10, pass: ratio <= 0.15 };
  }

  /* ---------- 合规第一层: 规则库扫描(广告法极限词/承诺性表述) ---------- */
  function complianceScan(text) {
    const hits = [];
    (window.CPL_DATA ? CPL_DATA.rules : []).forEach((r) => {
      let idx = -1;
      const from = [];
      while ((idx = text.indexOf(r.word, idx + 1)) !== -1) from.push(idx);
      if (from.length) hits.push({ word: r.word, type: r.type, fix: r.fix, count: from.length });
    });
    return hits;
  }
  function highlightHits(text, hits) {
    let html = esc(text);
    hits.forEach((h) => { html = html.split(esc(h.word)).join(`<mark class="risk">${esc(h.word)}</mark>`); });
    return html;
  }

  /* ---------- 像你度: <90% 不出稿, 自动重生一次 (NFR-17) ---------- */
  function likeness(seed) {
    let x = 0;
    for (const c of String(seed)) x = (x * 31 + c.charCodeAt(0)) % 9973;
    return Math.round((90.2 + (x % 82) / 10) * 10) / 10; // 90.2 ~ 98.4 演示区间
  }

  /* ---------- 页面骨架: 顶栏 + 模块导航(三模块卡可在原型间跳转) ---------- */
  function renderChrome(active, opts = {}) {
    const nav = `
      <header class="topbar"><div class="topbar-in">
        <a class="brand" href="index.html" style="color:var(--ink)">
          <span class="brand-dot">总</span>
          <span>流量总台 · 内容生产线</span>
        </a>
        <span class="demo-tag">演示数据</span>
        <div class="topbar-right">
          <button class="proj-switch" id="projSwitch" title="多项目隔离 · 点击切换项目上下文">
            <span style="width:8px;height:8px;border-radius:50%;background:var(--sage);display:inline-block"></span>
            泽宇 · 高净值变现IP ▾
          </button>
          <span class="role-badge">内容操盘手</span>
        </div>
      </div></header>`;
    const cards = [
      { id: 'gongyu', href: 'gongyu.html', cls: 'g', glyph: '公', name: '公域台 · 内容产出', desc: '扒对标 · 换理念 · 出文案 · 过合规' },
      { id: 'quan', href: 'quan.html', cls: 'p', glyph: '朋', name: '私域台 · 朋友圈', desc: '自主学习 · 六池养料 · 持续产出' },
      { id: 'kaike', href: 'kaike.html', cls: 'k', glyph: '课', name: '私域台 · 公开课', desc: '海报 · 预热 · 私推 · 正文' },
    ];
    const navHtml = `<nav class="module-nav" aria-label="模块切换">` + cards.map((c) => `
      <a class="module-card ${active === c.id ? 'active' : ''}" href="${c.href}">
        <span class="module-glyph ${c.cls}">${c.glyph}</span>
        <span><span class="module-name">${c.name}</span><br><span class="module-desc">${c.desc}</span></span>
      </a>`).join('') + '</nav>';
    const mount = document.getElementById('chrome');
    if (mount) mount.innerHTML = nav + (opts.navHidden ? '' : `<div class="wrap" style="padding-bottom:0">${navHtml}</div>`);
    const ps = document.getElementById('projSwitch');
    if (ps) ps.onclick = () => {
      const cur = store.get('project', '泽宇 · 高净值变现IP');
      const next = cur === '泽宇 · 高净值变现IP' ? '岑晴川 · 别墅设计' : '泽宇 · 高净值变现IP';
      store.set('project', next);
      ps.innerHTML = `<span style="width:8px;height:8px;border-radius:50%;background:var(--sage);display:inline-block"></span>${next} ▾`;
      toast(`已切换到项目「${next}」—— 理念库、声纹、六池互不串用`);
    };
  }

  /* ---------- 流水线渲染 ---------- */
  function pipeline(steps, currentIdx) {
    return `<div class="pipeline" role="list">` + steps.map((s, i) => {
      const ext = s.ext ? ' ext' : '';
      const cur = i === currentIdx ? ' current' : '';
      const sep = s.ext ? '<span class="pipe-arrow dashed">-</span>' : (i < steps.length - 1 ? '<span class="pipe-arrow">→</span>' : '');
      const num = s.ext ? '↗' : i + 1;
      return `<button class="pipe-step${ext}${cur}" role="listitem" data-step="${i}" title="${esc(s.tip || s.label)}">
          <span class="pipe-num">${num}</span><span class="pipe-label">${esc(s.label)}</span>
        </button>${sep}`;
    }).join('') + '</div>';
  }

  window.CPL = { store, $, $$, esc, fmtW, toast, copyText, confirmDialog, openModal, markPublished, withLoading, originality, complianceScan, highlightHits, likeness, renderChrome, pipeline };
})();
