/* 视图渲染：菜单 / 详情 / 购物车 / 结算 / 订单 / 门店选择 */
'use strict';

/* ================= 基础 UI 工具 ================= */
const UI = {
  toast(msg, type = '') {
    const root = $('#toast-root');
    const el = document.createElement('div');
    el.className = 'toast' + (type ? ' ' + type : '');
    el.textContent = msg;
    root.appendChild(el);
    setTimeout(() => el.remove(), 2600);
  },
  modal(html) {
    const root = $('#modal-root');
    // 重复打开（如门店选择器状态刷新）先解绑旧监听，避免累积
    if (this._unbindKeys) { this._unbindKeys(); this._unbindKeys = null; }
    if (!root.querySelector('.modal-mask')) this._lastFocus = document.activeElement;
    root.innerHTML = `<div class="modal-mask"><div class="modal-box" role="dialog" aria-modal="true" tabindex="-1">${html}</div></div>`;
    const mask = root.firstElementChild;
    mask.addEventListener('click', (e) => { if (!e.target.closest('.modal-box')) UI.closeModal(); });
    // 键盘无障碍：Esc 关闭 + Tab 焦点圈定
    this._unbindKeys = dialogKeys(mask, () => UI.closeModal());
    (mask.querySelector('button:not([disabled]), input:not([disabled])') || mask.querySelector('.modal-box')).focus?.();
    return mask;
  },
  closeModal() {
    if (this._unbindKeys) { this._unbindKeys(); this._unbindKeys = null; }
    const root = $('#modal-root');
    if (!root.querySelector('.modal-mask')) return;   // 无打开中的模态框：不重复清空/不误移焦点
    root.innerHTML = '';
    this._lastFocus?.focus?.();                        // 焦点还给打开前的触发元素
  },
  btnLoading(btn, text) {
    btn.dataset.rawText = btn.dataset.rawText || btn.innerHTML;
    btn.innerHTML = `⏳ ${text || '处理中'}`;
    btn.disabled = true;
  },
  btnRestore(btn) {
    if (btn.dataset.rawText) btn.innerHTML = btn.dataset.rawText;
    btn.disabled = false;
  },
  /** 手动触发一次全量渲染（用于草稿类状态变更） */
  refresh() { Views.render(Store.state); },
};

/** 导航 */
function go(route) { location.hash = '#/' + route; }

/** 解析差价字符串："+ ¥1" → 1；"- ¥1.5" → -1.5 */
function parseDiff(s) {
  const m = String(s || '').match(/([+-])?\s*¥?\s*([\d.]+)/);
  if (!m) return 0;
  const v = parseFloat(m[2]) || 0;
  return m[1] === '-' ? -v : v;
}

/** 商品估价：随单购类商品未随单购卡时按原价结算（与 MCP 实际计费一致） */
function estimateUnitPrice(item) {
  if (!item) return 0;
  const dt = item.discountType || '';
  if (dt.includes('随单购')) return parseFloat(item.originalPrice ?? item.currentPrice) || 0;
  return parseFloat(item.currentPrice) || 0;
}

/** 定制摘要文本 */
function summarizeLine(line) {
  const parts = [];
  if (line.rounds) for (const r of line.rounds) parts.push(r.choiceName);
  const modNames = [];
  const collect = (mods) => (mods || []).filter((m) => m.selected).forEach((m) => modNames.push(m.itemName));
  collect(line.mods);
  if (line.rounds) line.rounds.forEach((r) => collect(r.mods));
  let text = parts.join(' + ');
  if (modNames.length) text += (text ? ' · ' : '') + modNames.join('、');
  return text;
}

/* ================= 商品详情草稿（选配轮次 + 特调） ================= */
const Draft = {
  d: null,

  /** 打开详情：menuItem 来自菜单，detail 来自 MCP */
  open(menuItem, detail) {
    const rounds = [];
    const itemMods = [];
    for (const r of detail.rounds || []) {
      const choice = (r.choices || []).find((c) => c.isDefault) || (r.choices || [])[0];
      if (!choice) continue;
      rounds.push({
        roundId: r.id, roundName: r.name, minQuantity: r.minQuantity, maxQuantity: r.maxQuantity,
        choiceCode: choice.code, choiceName: choice.name,
        diffPrice: parseDiff(choice.diffPrice),
        mods: buildMods(choice.modification, `r${r.id}`),
      });
    }
    if (detail.supportModify && detail.modification) {
      itemMods.push(...buildMods(detail.modification, 'item'));
    }
    this.d = {
      code: detail.code || menuItem.code,
      name: detail.name || menuItem.name,
      image: detail.image || menuItem.image,
      basePrice: estimateUnitPrice(menuItem),
      originalPrice: parseFloat(menuItem.originalPrice ?? menuItem.currentPrice) || 0,
      menuCurrentPrice: parseFloat(menuItem.currentPrice) || 0,
      discountType: menuItem.discountType || null,
      qty: 1,
      rounds,
      mods: itemMods,
      _detail: detail,
    };
    return this.d;
  },

  setRoundChoice(roundId, choiceCode) {
    const d = this.d;
    if (!d) return;
    const found = d._detail?.rounds?.find((r) => r.id === roundId)?.choices?.find((c) => c.code === choiceCode);
    if (!found) return;
    const r = d.rounds.find((x) => x.roundId === roundId);
    r.choiceCode = found.code;
    r.choiceName = found.name;
    r.diffPrice = parseDiff(found.diffPrice);
    r.mods = buildMods(found.modification, `r${roundId}`);
  },

  toggleMod(groupId, idx) {
    const d = this.d;
    if (!d) return;
    const allMods = [...d.mods, ...d.rounds.flatMap((r) => r.mods)];
    const group = allMods.filter((m) => m.groupId === groupId);
    const target = group[idx];
    if (!target || target.mandatory) return;
    const maxValues = group[0].maxValues;
    if (!target.selected && maxValues === 1) {
      group.forEach((m, i) => { if (i !== idx) m.selected = false; });
    }
    target.selected = !target.selected;
  },

  unitPrice() {
    const d = this.d;
    if (!d) return 0;
    return d.basePrice + d.rounds.reduce((s, r) => s + (r.diffPrice || 0), 0);
  },

  /** 生成购物车行 */
  buildCartLine() {
    const d = this.d;
    const line = {
      code: d.code, name: d.name, image: d.image,
      basePrice: d.basePrice, originalPrice: d.originalPrice,
      qty: d.qty, unitPrice: this.unitPrice(),
      rounds: d.rounds.map((r) => ({ ...r, mods: r.mods.map((m) => ({ ...m })) })),
      mods: d.mods.map((m) => ({ ...m })),
      withOrderNote: !!(d.discountType && d.discountType.includes('随单购')),
    };
    line.note = summarizeLine(line);
    return line;
  },
};

/** 把 MCP modification 结构转为可编辑的特调草稿 */
function buildMods(modification, groupPrefix) {
  const out = [];
  (modification?.items || []).forEach((item, gi) => {
    const gid = `${groupPrefix}g${gi}`;
    const values = item.values || [];
    const mandatory = item.minValues >= 1 && item.maxValues === 1 && values.length === 1;
    values.forEach((v, vi) => {
      if (!v.selectedKey) return;
      const selected = v.selectedQuantity > 0;
      out.push({
        groupId: gid, idx: vi, maxValues: item.maxValues, minValues: item.minValues,
        itemCode: v.code, itemName: v.name, price: v.price || 0,
        key: selected ? v.selectedKey : (v.unselectedKey || v.selectedKey),
        selected, mandatory,
        qty: v.selectedQuantity || 1,
      });
    });
    if (mandatory) out.filter((m) => m.groupId === gid).forEach((m) => { m.selected = true; });
  });
  return out;
}

/* ================= 视图渲染 ================= */
const Views = {
  render(state) {
    this.renderHeader(state);
    const route = state.ui.route;
    if (route === 'cart') this.renderCartPage(state);
    else if (route === 'checkout') CheckoutCtrl.render(state);
    else if (route === 'orders') { $('#view-root').dataset.view = 'orders'; this.renderOrders(state); }
    else this.renderMenu(state);
    this.renderCartRail(state);
    this.renderNav(state);
    if (state.ui.detailCode) this.renderDetailModal(state);
    else if ($('#modal-root .modal-mask') && !state.ui.storePickerOpen) UI.closeModal();
    if (state.ui.storePickerOpen) this.renderStorePicker(state);
  },

  /* ---------- 顶部 ---------- */
  renderHeader(state) {
    const pill = $('#store-pill-text');
    const place = state.geo && state.geo.place;
    const label = place ? place.shortLabel
      : state.store ? state.store.storeName.replace(/^麦当劳/, '')
      : '选择门店';
    pill.textContent = label.length > 12 ? label.slice(0, 12) + '…' : label;
    const badge = $('#mode-badge');
    if (state.mode === 'live') {
      badge.textContent = '⚡ 实时模式';
      badge.className = 'mode-badge live';
      badge.title = '已连接麦当劳 MCP：实时门店 / 实时菜单 / 真实领券 / 真实下单';
    } else {
      badge.textContent = '⚠ 后端未连接';
      badge.className = 'mode-badge offline';
      badge.title = '未连接真实后端，无法获取门店与菜单';
    }
  },

  renderNav(state) {
    $$('#bottom-nav a, #bottom-nav button').forEach((el) => {
      el.classList.toggle('active', el.dataset.route === state.ui.route);
    });
    const badge = $('#cart-badge');
    const count = Store.cartCount();
    badge.hidden = count === 0;
    badge.textContent = count > 99 ? '99+' : count;
  },

  /* ---------- 菜单（局部刷新，避免输入失焦） ---------- */
  renderMenu(state) {
    const root = $('#view-root');
    if (!state.menu) {
      root.dataset.view = 'menu-loading';
      root.innerHTML = `<div class="menu-grid">${Array.from({ length: 8 }, () => `
        <div class="product-card"><div class="skeleton" style="aspect-ratio:1"></div>
        <div class="p-body"><div class="skeleton" style="height:14px;width:70%"></div>
        <div class="skeleton" style="height:14px;width:40%"></div></div></div>`).join('')}</div>`;
      return;
    }
    if (root.dataset.view !== 'menu') {
      root.dataset.view = 'menu';
      root.innerHTML = `
        <section class="menu-hero">
          <h1>${isBreakfastTime() ? '早安，来份热早餐 ☀️' : '今天想吃点什么？🍔'}</h1>
          <p>${state.store ? esc(state.store.storeName) : '请选择门店'} · ${isBreakfastTime() ? '早餐' : '午/晚餐'}时段 · 支持语音点餐与优惠券自动领取</p>
          <div class="hero-quick">
            <button data-action="quick-search" data-kw="巨无霸">🍔 巨无霸</button>
            <button data-action="quick-search" data-kw="随心配">✨ 1+1随心配</button>
            <button data-action="quick-search" data-kw="薯条">🍟 薯条</button>
            <button data-action="quick-search" data-kw="麦旋风">🍦 麦旋风</button>
            <button data-action="quick-search" data-kw="安格斯">🥩 安格斯</button>
          </div>
        </section>
        <div class="search-bar">
          <span>🔍</span>
          <input id="menu-search" type="search" placeholder="搜索餐品，或点右侧麦克风语音点餐" value="${esc(state.ui.search)}" />
          <button class="search-mic" data-action="open-voice" title="语音搜索">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="9" y="2" width="6" height="12" rx="3"></rect><path d="M5 10v1a7 7 0 0 0 14 0v-1"></path><path d="M12 18v4"></path></svg>
          </button>
        </div>
        <div class="cat-row" id="cat-row"></div>
        <div id="menu-grid-root"></div>`;
      const input = $('#menu-search');
      input.addEventListener('input', debounce((e) => Store.setSearch(e.target.value), 250));
      input.addEventListener('search', (e) => Store.setSearch(e.target.value));
    }
    this.updateCatRow(state);
    this.updateMenuGrid(state);
  },

  updateCatRow(state) {
    const row = $('#cat-row');
    if (!row) return;
    const { menu, ui } = state;
    const chips = ['全部', ...menu.categories.map((c) => c.name.replace(/\n/g, ''))];
    row.innerHTML = chips.map((c) => `<button class="cat-chip ${c === ui.category && !ui.search.trim() ? 'active' : ''}" data-action="pick-category" data-cat="${esc(c)}">${esc(c)}</button>`).join('');
  },

  updateMenuGrid(state) {
    const gridRoot = $('#menu-grid-root');
    if (!gridRoot) return;
    const { menu, ui } = state;
    const kw = ui.search.trim();
    let categories = menu.categories;
    if (kw) {
      const hits = [];
      for (const [code, item] of Object.entries(menu.meals)) {
        if (item.name.includes(kw) || (item.discountType || '').includes(kw)) hits.push({ code, tags: [] });
      }
      categories = [{ name: `搜索“${kw}”`, meals: hits }];
    } else if (ui.category !== '全部' && menu.categories.some((c) => c.name === ui.category)) {
      categories = menu.categories.filter((c) => c.name === ui.category);
    }
    gridRoot.innerHTML = categories.map((cat) => {
      const items = cat.meals.map((m) => menu.meals[m.code]).filter(Boolean);
      if (!items.length) return '';
      return `
      <section>
        <h2 class="menu-section-title">${esc(cat.name.replace(/\n/g, ''))}</h2>
        <div class="menu-grid">
          ${items.map((item) => this.productCard(item)).join('')}
        </div>
      </section>`;
    }).join('') || `<div class="empty-state"><div class="empty-emoji">🔍</div><p>没有找到「${esc(kw)}」相关餐品，换个关键词试试</p></div>`;
  },

  productCard(item) {
    const tags = (item.tags || []).slice(0, 2);
    const est = estimateUnitPrice(item);
    const origin = parseFloat(item.originalPrice ?? item.currentPrice) || 0;
    const showOrigin = origin > est && !(item.discountType || '').includes('随单购');
    const kcal = Store.state.nutrition[item.name];
    return `
      <article class="product-card" data-action="open-detail" data-code="${item.code}">
        <div class="p-img"><img src="${esc(item.image)}" alt="${esc(item.name)}" loading="lazy" onerror="this.style.opacity=0" /></div>
        <div class="p-body">
          <h3 class="p-name">${esc(item.name)}</h3>
          <div class="p-tags">
            ${tags.map((t) => `<span class="chip ${t.includes('上新') ? 'chip-red' : t.includes('人气') ? 'chip-yellow' : ''}">${esc(t)}</span>`).join('')}
            ${kcal ? `<span class="chip chip-green">${kcal.energyKcal} kcal</span>` : ''}
          </div>
          <div class="p-price-row">
            <div>
              <span class="p-price"><small>¥</small>${fmtMoney(est)}</span>
              ${showOrigin ? `<span class="p-origin">¥${fmtMoney(origin)}</span>` : ''}
            </div>
            <button class="p-add" data-action="quick-add" data-code="${item.code}" title="加入购物车">+</button>
          </div>
        </div>
      </article>`;
  },

  /* ---------- 购物车（桌面侧栏 / 移动页面） ---------- */
  cartListHTML(state) {
    if (!state.cart.length) {
      return `<div class="empty-state"><div class="empty-emoji">🛒</div><p>购物车是空的<br />去菜单挑几样吧</p></div>`;
    }
    return state.cart.map((line) => `
      <div class="cart-item">
        <img src="${esc(line.image)}" alt="" onerror="this.style.opacity=0" />
        <div class="ci-body">
          <div class="ci-name">${esc(line.name)}</div>
          ${line.note ? `<div class="ci-opt">${esc(line.note)}</div>` : ''}
          ${line.withOrderNote ? `<div class="ci-opt" style="color:#c2410c">未随单购卡，按原价结算</div>` : ''}
          <div class="ci-row">
            <span class="ci-price">¥${fmtMoney(line.unitPrice * line.qty)}</span>
            <span class="qty-ctrl">
              <button data-action="qty-dec" data-line="${line.lineId}">−</button>
              <span class="qty-num">${line.qty}</span>
              <button data-action="qty-inc" data-line="${line.lineId}">+</button>
            </span>
          </div>
        </div>
      </div>`).join('');
  },

  renderCartRail(state) {
    const rail = $('#cart-rail');
    // 购物车路由下主区域已渲染完整购物车页，侧栏再渲染一份会造成双份 UI（桌面端实测复现）；
    // 移动端侧栏本就隐藏。其余路由（菜单/结算）保留侧栏购物车摘要。
    if (window.innerWidth < 1024 || state.ui.route === 'cart') { rail.innerHTML = ''; return; }
    rail.innerHTML = `
      <div class="cart-head">
        <h2>🛒 购物车<span class="cart-count">${Store.cartCount()} 件</span></h2>
        ${state.cart.length ? `<button class="cart-clear" data-action="clear-cart">清空</button>` : ''}
      </div>
      <div class="cart-list">${this.cartListHTML(state)}</div>
      ${state.cart.length ? `
      <div class="cart-foot">
        <div class="cart-summary-row"><span>商品原价</span><span>¥${fmtMoney(Store.cartOriginal())}</span></div>
        <div class="cart-summary-row total"><span>预估合计</span><span class="cart-total-price">¥${fmtMoney(Store.cartSubtotal())}</span></div>
        <button class="btn btn-primary btn-block btn-lg" data-action="goto" data-route="checkout">去结算</button>
        <p class="cart-hint">结算时自动核价 · 优惠券优先领取</p>
      </div>` : ''}`;
  },

  renderCartPage(state) {
    $('#view-root').dataset.view = 'cart';
    $('#view-root').innerHTML = `
      <div class="checkout-wrap">
        <div class="checkout-card" style="padding:0;overflow:hidden">
          <div class="cart-head">
            <h2>🛒 购物车<span class="cart-count">${Store.cartCount()} 件</span></h2>
            ${state.cart.length ? `<button class="cart-clear" data-action="clear-cart">清空</button>` : ''}
          </div>
          <div class="cart-list">${this.cartListHTML(state)}</div>
          ${state.cart.length ? `
          <div class="cart-foot">
            <div class="cart-summary-row"><span>商品原价</span><span>¥${fmtMoney(Store.cartOriginal())}</span></div>
            <div class="cart-summary-row total"><span>预估合计</span><span class="cart-total-price">¥${fmtMoney(Store.cartSubtotal())}</span></div>
            <button class="btn btn-primary btn-block btn-lg" data-action="goto" data-route="checkout">去结算</button>
            <p class="cart-hint">结算时自动核价 · 优惠券优先领取</p>
          </div>` : `<div style="padding:20px"><button class="btn btn-yellow btn-block" data-action="goto" data-route="menu">去点餐</button></div>`}
        </div>
      </div>`;
  },

  /* ---------- 商品详情弹层 ---------- */
  renderDetailModal(state) {
    const menuItem = state.menu?.meals[state.ui.detailCode];
    if (!menuItem) { UI.closeModal(); Store.closeDetail(); return; }
    const draftOk = Draft.d && Draft.d.code === state.ui.detailCode;

    if (!draftOk) {
      // 首次打开：骨架屏 + 异步加载详情
      UI.modal(`<div class="skeleton" style="height:340px"></div>`);
      const box = $('#modal-root .modal-box');
      Api.getMealDetail(state.store.storeCode, menuItem.code).then((detail) => {
        if (Store.state.ui.detailCode !== menuItem.code) return;
        Draft.open(menuItem, detail);
        this.paintDetail(state);
      }).catch((e) => {
        box.innerHTML = `<div class="empty-state"><div class="empty-emoji">😥</div><p>${esc(e.message)}</p>
          <button class="btn btn-ghost" data-action="close-modal" style="margin-top:12px">关闭</button></div>`;
      });
      return;
    }
    this.paintDetail(state);
  },

  paintDetail(state) {
    const box = $('#modal-root .modal-box');
    if (!box) return;
    const menuItem = state.menu?.meals[state.ui.detailCode];
    const d = Draft.d;
    if (!menuItem || !d) return;
    const kcal = state.nutrition[menuItem.name];
    const est = Draft.unitPrice();
    box.innerHTML = `
      <img class="detail-img" src="${esc(menuItem.image)}" alt="${esc(menuItem.name)}" onerror="this.style.opacity=0" />
      <div class="detail-body">
        <div class="detail-name">${esc(menuItem.name)}
          ${(menuItem.tags || []).slice(0, 2).map((t) => `<span class="chip ${t.includes('上新') ? 'chip-red' : 'chip-yellow'}">${esc(t)}</span>`).join('')}
        </div>
        <div class="detail-price-row">
          <span class="detail-price"><small>¥</small>${fmtMoney(est)}</span>
          ${parseFloat(menuItem.originalPrice) > est ? `<span class="detail-origin">¥${fmtMoney(menuItem.originalPrice)}</span>` : ''}
        </div>
        ${kcal ? `<span class="detail-kcal">约 ${kcal.energyKcal} kcal · 蛋白 ${kcal.protein}g · 脂肪 ${kcal.fat}g</span>` : ''}
        ${menuItem.discountType && menuItem.discountType.includes('随单购')
          ? `<p class="detail-desc" style="color:#c2410c">⚠️ 菜单价 ¥${fmtMoney(menuItem.currentPrice)} 为随单购卡专享价；本单不加购卡时将按原价 ¥${fmtMoney(menuItem.originalPrice)} 结算。</p>`
          : `<p class="detail-desc">${esc((menuItem.tags || []).join(' · ') || '麦当劳经典产品，现点现做。')}</p>`}

        ${(d.rounds || []).map((r) => {
          const rawRound = d._detail.rounds.find((x) => x.id === r.roundId);
          return `
          <div class="round-group">
            <div class="round-title">${esc(r.roundName)} <span class="round-badge">${r.minQuantity >= 1 ? '必选' : '可选'}</span></div>
            <div class="round-choices">
              ${(rawRound?.choices || []).map((c) => `
                <div class="round-choice ${c.code === r.choiceCode ? 'selected' : ''}" data-action="pick-round" data-round="${r.roundId}" data-code="${esc(c.code)}">
                  <span class="rc-radio"></span>
                  <span class="rc-name">${esc(c.name)}${c.supportModify ? '<span class="chip" style="margin-left:6px">可特调</span>' : ''}</span>
                  <span class="rc-diff">${esc(c.diffPrice || '+ ¥0')}</span>
                </div>`).join('')}
            </div>
            ${r.mods.length ? modsHTML(r.mods, esc(r.choiceName) + ' · 特调') : ''}
          </div>`;
        }).join('')}

        ${d.mods.length ? `<div class="round-group"><div class="round-title">特调选项</div>${modsHTML(d.mods, '本单品 · 特调')}</div>` : ''}
      </div>
      <div class="detail-foot">
        <span class="qty-ctrl">
          <button data-action="draft-qty" data-n="-1">−</button>
          <span class="qty-num">${d.qty}</span>
          <button data-action="draft-qty" data-n="1">+</button>
        </span>
        <button class="btn btn-primary btn-lg" data-action="detail-add">加入购物车 · ¥${fmtMoney(est * d.qty)}</button>
      </div>`;
    box.scrollTop = 0;
  },

  /* ---------- 门店选择 ---------- */
  renderStorePicker(state) {
    const geo = state.geo;
    const stores = state.stores;
    // 签名一致则跳过重渲染：避免输入框失焦、雷达图重绘闪烁
    // 签名需覆盖定位状态、搜索条件与门店列表，避免输入框失焦、雷达图重绘闪烁
    const sig = [
      geo.status, geo.place ? geo.place.label : '', geo.error ? geo.error.code : '',
      geo.note || '', stores.length, state.store ? state.store.storeCode : '',
      state.storeRef ? state.storeRef.label : '',
      state.mode,
      state.storeRef ? (state.storeRef.keyword || '') + (state.storeRef.city || '') : '',
    ].join('|');
    if (this._pickerSig === sig && $('#modal-root .modal-mask')) return;
    this._pickerSig = sig;

    UI.modal(`
      <div class="detail-body store-picker-body">
        <div class="detail-name">📍 选择门店</div>
        <p class="detail-desc" id="store-picker-desc">${this._storePickerDesc(state)}</p>
        ${this._geoPanelHTML(state)}
        ${geo.note ? `<p class="geo-note">⚠️ ${esc(geo.note)}</p>` : ''}
        ${this._storeManualHTML(state)}
        ${this._storeRadarHTML(state)}
        <div class="round-choices store-list">
          ${stores.length ? stores.map((s, i) => `
            <div class="round-choice ${state.store && s.storeCode === state.store.storeCode ? 'selected' : ''}" data-action="pick-store" data-code="${s.storeCode}">
              <span class="rc-radio"></span>
              <span class="rc-name">${i + 1}. ${esc(s.storeName)}<br /><small style="color:var(--ink-3);font-weight:400">${esc(s.address || '')} · ${s.businessStartTime || ''}-${s.businessEndTime || ''}</small></span>
              <span class="store-status ${storeStatusInfo(s).cls}">${storeStatusInfo(s).label}</span>
              ${s.distance != null ? `<span class="store-dist">${formatDistance(s.distance)}</span>` : ''}
            </div>`).join('')
          : `<div class="empty-state" style="padding:24px 0"><div class="empty-emoji">🏪</div><p>暂无门店数据<br />请定位或手动搜索</p></div>`}
        </div>
        <button class="btn btn-ghost btn-block" data-action="close-modal" style="margin-top:16px">取消</button>
      </div>`);
  },

  _storePickerDesc(state) {
    const geo = state.geo;
    const n = state.stores.length;
    const ref = state.storeRef || {};
    if (n === 0) return '暂无门店数据，请定位或手动搜索';
    if (geo.status === 'success' && ref.located) {
      return `已按「${esc(ref.label || '当前位置')}」由近到远排序 · 共 ${n} 家门店（数据来自麦当劳实时查询）`;
    }
    if (ref.label) {
      return `相对「${esc(ref.label)}」排序 · 共 ${n} 家门店（数据来自麦当劳实时查询）`;
    }
    return `附近 ${n} 家门店（数据来自麦当劳实时查询）`;
  },

  /** 定位面板：按钮 / 进行中 / 成功 / 异常（拒绝、不可用、超时、不安全上下文） */
  _geoPanelHTML(state) {
    const geo = state.geo;
    const locateBtn = `<button class="btn btn-primary btn-block geo-locate-btn" data-action="locate-me" type="button" ${geo.status === 'locating' ? 'disabled' : ''}>
      ${geo.status === 'locating' ? '<span class="geo-spinner"></span> 正在定位…' : '📍 定位到当前位置'}
    </button>`;

    if (geo.status === 'idle') {
      return `<div class="geo-panel">
        ${locateBtn}
        <p class="geo-hint">授权定位后，将按您的真实位置由近到远排序门店</p>
      </div>`;
    }
    if (geo.status === 'locating') {
      return `<div class="geo-panel">
        ${locateBtn}
        <p class="geo-hint">首次定位可能需要几秒，请允许浏览器获取位置权限…</p>
      </div>`;
    }
    if (geo.status === 'success') {
      const p = geo.position || {};
      const place = geo.place;
      const acc = p.accuracy != null ? ` · 精度 ${formatAccuracy(p.accuracy)}` : '';
      return `<div class="geo-panel">
        ${place ? `<div class="geo-chip"><span>📍</span><span class="geo-chip-label">${esc(place.label)}</span><span class="geo-chip-acc">${acc.replace(' · ', '')}</span></div>`
        : `<div class="geo-alert warn"><b>已获取位置${acc}</b>，但无法解析所在地址。<br />请手动输入城市与位置关键词搜索门店。</div>`}
        <div class="geo-actions">
          <button class="btn btn-ghost btn-sm" data-action="retry-locate" type="button">🔄 重新定位</button>
        </div>
      </div>`;
    }
    // error
    const e = geo.error || {};
    const guide = {
      DENIED: '请点击浏览器地址栏左侧的「位置 / 锁形」图标，将本站位置权限改为「允许」后重试。',
      INSECURE: '浏览器仅在 HTTPS 或 localhost 下提供定位能力，请更换访问方式。',
      UNSUPPORTED: '请更换现代浏览器，或使用手动搜索。',
    }[e.code] || '';
    return `<div class="geo-panel">
      <div class="geo-alert error">
        <b>${esc(e.reason || '定位失败')}</b>
        ${e.hint ? `<br />${esc(e.hint)}` : ''}
        ${guide ? `<br /><span class="geo-guide">${guide}</span>` : ''}
      </div>
      <div class="geo-actions">
        <button class="btn btn-ghost btn-sm" data-action="retry-locate" type="button">🔄 重试定位</button>
        <span class="geo-hint">或使用下方手动搜索</span>
      </div>
    </div>`;
  },

  /** 手动搜索兜底（定位失败/拒绝时始终可用） */
  _storeManualHTML(state) {
    const ref = state.storeRef || {};
    const city = ref.city || '北京市';
    const kw = ref.keyword || '国贸';
    return `<div class="store-manual">
      <div class="store-manual-title">🔎 手动搜索门店</div>
      <div class="store-manual-row">
        <input class="store-input" id="manual-city" type="text" placeholder="城市" value="${esc(city)}" />
        <input class="store-input" id="manual-kw" type="text" placeholder="位置关键词，如 国贸" value="${esc(kw)}" />
        <button class="btn btn-primary btn-sm" data-action="manual-store-search" type="button">搜索</button>
      </div>
    </div>`;
  },

  /** 距离雷达：用户/参考点居中，门店按实际距离等比分布在同心圆上（方向为示意） */
  _storeRadarHTML(state) {
    const stores = state.stores.filter((s) => s.distance != null).slice(0, 10);
    if (!stores.length) return '';
    const max = Math.max(...stores.map((s) => s.distance), 1);
    const cx = 152, cy = 100, R = 76, rMin = 16;
    const geo = state.geo;
    // 雷达中心标签：定位成功用定位点简称，否则用参考点（搜索关键词/当前门店所在城市）
    const centerLabel = geo.status === 'success' && geo.place ? geo.place.shortLabel
      : (state.storeRef && state.storeRef.label) || (state.store ? state.store.storeName.replace(/^麦当劳/, '') : '参考点');
    const rings = [0.5, 1].map((k) => {
      const r = rMin + (R - rMin) * k;
      const label = formatDistance(max * k);
      return `<circle cx="${cx}" cy="${cy}" r="${r.toFixed(1)}" fill="none" stroke="#e3e3e3" stroke-width="1" stroke-dasharray="3 4" />
        <text x="${cx + 4}" y="${(cy - r - 3).toFixed(1)}" font-size="9" fill="#8a8a8a">${label}</text>`;
    }).join('');
    const dots = stores.map((s, i) => {
      const ang = (hashAngle(s.storeCode || s.storeName || String(i)) * Math.PI) / 180;
      const r = rMin + (R - rMin) * (s.distance / max);
      const x = cx + r * Math.cos(ang);
      const y = cy + r * Math.sin(ang);
      const selected = state.store && s.storeCode === state.store.storeCode;
      const color = s.businessStatus === false ? '#b5b5b5' : (selected ? '#da291c' : '#f5b800');
      return `<line x1="${cx}" y1="${cy}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}" stroke="#f0c9c6" stroke-width="1" />
        <circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${selected ? 9 : 7.5}" fill="${color}" stroke="#ffffff" stroke-width="1.5" />
        <text x="${x.toFixed(1)}" y="${(y + 3.2).toFixed(1)}" font-size="8.5" font-weight="700" fill="#ffffff" text-anchor="middle">${i + 1}</text>`;
    }).join('');
    return `<div class="store-radar">
      <div class="store-radar-title">距离示意 <span>（半径按实际距离等比 · 方向为示意）</span></div>
      <svg viewBox="0 0 304 200" role="img" aria-label="门店距离示意图">
        <circle cx="${cx}" cy="${cy}" r="${R}" fill="#fafafa" stroke="#ececec" />
        ${rings}
        ${dots}
        <circle cx="${cx}" cy="${cy}" r="11" fill="#1f1f1f" />
        <circle cx="${cx}" cy="${cy}" r="11" fill="none" stroke="#ffffff" stroke-width="2" />
        <text x="${cx}" y="${cy + 3.5}" font-size="8" font-weight="700" fill="#ffffff" text-anchor="middle">我</text>
        <text x="${cx}" y="${cy + 26}" font-size="9.5" font-weight="600" fill="#4d4d4d" text-anchor="middle">${esc(centerLabel.length > 10 ? centerLabel.slice(0, 10) + '…' : centerLabel)}</text>
      </svg>
    </div>`;
  },

  /* ---------- 订单列表 ---------- */
  renderOrders(state) {
    $('#view-root').innerHTML = `
      <div class="checkout-wrap">
        <h2 class="menu-section-title">📋 我的订单</h2>
        ${state.orders.length ? state.orders.map((o) => `
          <div class="order-card">
            <div class="oc-head">
              <span class="oc-store">${esc(o.storeName || '麦当劳')}</span>
              <span class="oc-status">${esc(o.status || '已完成')}</span>
            </div>
            <div class="oc-items">${o.items.map((i) => `${esc(i.name)} ×${i.qty}`).join('<br />')}</div>
            <div class="oc-foot">
              <span class="oc-time">${esc(o.time || '')} · ${esc(o.takeWay || '')}</span>
              <span class="oc-total">¥${fmtMoney(o.total)}</span>
            </div>
          </div>`).join('')
        : `<div class="empty-state"><div class="empty-emoji">🧾</div><p>还没有订单<br />点一笔试试吧</p></div>`}
      </div>`;
  },
};

/** 营业状态：优先用后端布尔 businessStatus，缺失则按时段推算；临近打烊 30 分钟内提示 */
function storeStatusInfo(store) {
  const toMin = (t) => {
    const [h, m] = String(t || '0:0').split(':').map((x) => parseInt(x, 10) || 0);
    return h * 60 + m;
  };
  const now = new Date();
  const mins = now.getHours() * 60 + now.getMinutes();
  const start = toMin(store.businessStartTime);
  const end = toMin(store.businessEndTime);
  let isOpen;
  if (store.businessStatus === true) isOpen = true;
  else if (store.businessStatus === false) isOpen = false;
  else isOpen = start <= mins && mins <= end;
  if (isOpen) {
    const soon = end - mins <= 30 && end >= mins;
    return { label: soon ? '即将打烊' : '营业中', cls: soon ? 'soon' : 'open' };
  }
  return { label: '暂停营业', cls: 'closed' };
}

/** 特调选项 chips HTML（label：分组标题） */
function modsHTML(mods, label) {
  const groups = {};
  for (const m of mods) {
    (groups[m.groupId] = groups[m.groupId] || []).push(m);
  }
  return Object.entries(groups).map(([gid, list]) => `
    <div class="mod-group">
      <div class="mg-title">${label || esc(list[0].itemName)}${list[0].mandatory ? '（必选）' : list[0].maxValues === 1 ? '（单选）' : '（可多选）'}</div>
      <div class="mod-opts">
        ${list.map((m) => `<button class="mod-opt ${m.selected ? 'selected' : ''}" ${m.mandatory ? 'disabled' : ''} data-action="toggle-mod" data-group="${esc(gid)}" data-idx="${m.idx}">${esc(m.itemName)}</button>`).join('')}
      </div>
    </div>`).join('');
}
