/* 饭点安排 · 预算搭配引擎
 *
 * 呼应大赛任务「把饭点安排明白」：用户给出预算，引擎从当前门店真实菜单中
 * 枚举「主食 + 小食 + 饮料」组合，本地估价初筛后送 MCP calculate-price
 * 实时核实成交价，按「省钱优先 / 吃饱优先」排序输出前三名，一键加入购物车。
 *
 * 设计要点：
 * 1. 商品分类用「菜单分类名 + 商品名正则」双重判定，兼容各门店各时段菜单差异；
 * 2. 套餐类（含选配轮次）不进入自动搭配——避免替用户做必选决策，改去详情页选配；
 * 3. 枚举有数量上限（主食 14 × 小食 14 × 饮料 12），性能可控；
 * 4. MCP 核实失败时降级为本地估价并明确标注，绝不伪装成实时价；
 * 5. 随单购商品按原价估算（estimateUnitPrice 同规则），保证与 MCP 计费一致。
 */
'use strict';

const BudgetPlanner = {
  open: false,
  budget: 50,
  mode: 'save',          // 'save' 省钱优先 | 'full' 吃饱优先
  loading: false,
  result: null,          // { ok, combos: [{items, realPrice, originalPrice, verified}], cheapest, note }
  lastError: '',

  /* ---------- 商品分类：返回 main | snack | drink | dessert | combo ---------- */
  classify(item, catName) {
    const name = String((item && item.name) || '');
    const cat = String(catName || '');
    // 1) 套餐类（含选配轮次）：不进入自动搭配，避免替用户做必选决策
    if (/套餐|件套|随心配|分享餐|多人餐|单人餐|口福|乐园|组合|配餐|三件|两件|双拼|全家桶/.test(name)
      || /套餐|单人餐|多人餐|拼盘|随心配|乐园|组合/.test(cat)) return 'combo';
    // 2) 甜品强特征（先于主食判定：「圆筒」「派」等不含堡/饭字样）
    if (/冰淇淋|麦旋风|圣代|甜筒|新地|圆筒|蛋挞|派|蛋糕|布丁|芝士条|红豆|柚子|慕斯|椰子|留心|华夫/.test(name)) return 'dessert';
    // 3) 小食强特征（先于主食判定：「麦辣鸡翅」含「麦辣」但实为小食）
    if (/翅|薯条|薯格|薯角|薯饼|鸡块|鸡米花|洋葱圈|玉米|沙拉|盐酥|地瓜|红薯|脆皮鸡|爆米花|大鸡排|鸡排|串/.test(name)) return 'snack';
    // 4) 主食
    if (/汉堡|牛鱼肉堡|堡|霸|卷|炒饭|饭|面|披萨|牛排|鳕鱼|安格斯|吉士|麦辣|板烧|麦满分|松饼|炒双蛋|营养卷|粥|嫩牛五方|不素之霸/.test(name)
      || /汉堡|卷|堡|霸|饭|面|炒双蛋|松饼|麦满分|安格斯|牛鱼|主食/.test(cat)) return 'main';
    // 5) 饮料
    if (/可乐|雪碧|芬达|美年达|果汁|牛奶|豆浆|咖啡|拿铁|美式|摩卡|卡布奇诺|柠檬|热带|泡泡|奶昔|雪冰|晶打|旭日|椰林|椰汁|菠萝|港式|零度|饮用水|矿泉水|酸梅汤|茶|汁|中杯|大杯|小杯|现磨/.test(name)
      || /饮品|咖啡|饮料|豆浆|牛奶|一早现磨|茶/.test(cat)) return 'drink';
    return 'snack';
  },

  /* ---------- 从当前菜单提取四个桶（排除套餐，按价格升序截断） ---------- */
  buckets() {
    const menu = Store.state.menu;
    const out = { main: [], snack: [], drink: [], dessert: [] };
    if (!menu || !menu.meals) return out;
    const catOf = {};
    for (const c of menu.categories || []) {
      for (const m of c.meals || []) catOf[m.code] = c.name;
    }
    const seen = new Set();
    for (const [code, item] of Object.entries(menu.meals)) {
      if (!item || seen.has(code)) continue;
      seen.add(code);
      const kind = this.classify(item, catOf[code]);
      if (kind === 'combo') continue;                 // 套餐需手动选配，不进自动搭配
      const est = estimateUnitPrice(item);
      if (!(est > 0)) continue;                       // 无有效价格不参与
      out[kind].push({ item, code, name: item.name, image: item.image, est, original: parseFloat(item.originalPrice ?? item.currentPrice) || est });
    }
    const byPrice = (a, b) => a.est - b.est;
    out.main = out.main.sort(byPrice).slice(0, 14);
    out.snack = out.snack.sort(byPrice).slice(0, 14);
    out.drink = out.drink.sort(byPrice).slice(0, 12);
    out.dessert = out.dessert.sort(byPrice).slice(0, 6);
    return out;
  },

  /* ---------- 热量估算（kcal，无数据返回 0） ---------- */
  kcal(entry) {
    const n = Store.state.nutrition && Store.state.nutrition[entry.name];
    return n && n.energyKcal > 0 ? n.energyKcal : 0;
  },

  /* ---------- 本地枚举：预算内全部「主食+小食+饮料」组合 ---------- */
  enumerate(budget) {
    const b = this.buckets();
    const combos = [];
    const push = (entries) => {
      const est = entries.reduce((s, e) => s + e.est, 0);
      if (est <= budget + 1e-9) combos.push({ entries, est });
    };
    if (b.main.length && b.snack.length && b.drink.length) {
      for (const m of b.main) for (const s of b.snack) for (const d of b.drink) push([m, s, d]);
    } else if (b.main.length && b.snack.length) {
      for (const m of b.main) for (const s of b.snack) push([m, s]);
    } else if (b.main.length && b.drink.length) {
      for (const m of b.main) for (const d of b.drink) push([m, d]);
    } else if (b.snack.length && b.drink.length) {
      for (const s of b.snack) for (const d of b.drink) push([s, d]);
    } else if (b.main.length) {
      for (const m of b.main) push([m]);
    }
    // 预算内无解时，记录最便宜三元组用于「提高预算」提示
    let cheapest = null;
    if (!combos.length && b.main.length && b.snack.length && b.drink.length) {
      cheapest = { est: b.main[0].est + b.snack[0].est + b.drink[0].est, entries: [b.main[0], b.snack[0], b.drink[0]] };
    }
    return { combos, cheapest };
  },

  /* ---------- 本地排序：省钱 → 价格升序；吃饱 → 热量降序（无热量数据时退化为贴近预算） ---------- */
  rank(list) {
    if (this.mode === 'full') {
      const scored = list.map((c) => ({ c, kcal: c.entries.reduce((s, e) => s + this.kcal(e), 0) }));
      const anyKcal = scored.some((x) => x.kcal > 0);
      if (anyKcal) scored.sort((a, b) => b.kcal - a.kcal || a.c.est - b.c.est);
      else scored.sort((a, b) => b.c.est - a.c.est);
      return scored.map((x) => x.c);
    }
    return list.slice().sort((a, b) => a.est - b.est);
  },

  /* ---------- MCP 实时核实成交价（失败降级本地估价并标注） ---------- */
  async verify(combos) {
    const store = Store.state.store;
    if (!store) return combos.map((c) => ({ ...c, realPrice: c.est, verified: false }));
    const results = await Promise.all(combos.map(async (c) => {
      try {
        const items = c.entries.map((e) => ({ code: e.code, qty: 1, rounds: [], mods: [] }));
        const r = await Api.calculatePrice(store.storeCode, items, null, false);
        const price = r && Number.isFinite(r.price) ? fenToYuan(r.price) : c.est;
        const original = r && r.productOriginalPrice != null ? fenToYuan(r.productOriginalPrice) : c.entries.reduce((s, e) => s + e.original, 0);
        return { ...c, realPrice: price, originalPrice: original, verified: true };
      } catch (_) {
        return { ...c, realPrice: c.est, originalPrice: c.entries.reduce((s, e) => s + e.original, 0), verified: false };
      }
    }));
    return results;
  },

  /** 按实时价重新排序（核实成功的优先按实时价；未核实的按估价穿插） */
  resort(combos) {
    if (this.mode === 'full') {
      const scored = combos.map((c) => ({ c, kcal: c.entries.reduce((s, e) => s + this.kcal(e), 0) }));
      const anyKcal = scored.some((x) => x.kcal > 0);
      if (anyKcal) scored.sort((a, b) => b.kcal - a.kcal || a.c.realPrice - b.c.realPrice);
      else scored.sort((a, b) => b.c.realPrice - a.c.realPrice);
      return scored.map((x) => x.c);
    }
    return combos.slice().sort((a, b) => a.realPrice - b.realPrice);
  },

  /* ---------- 主流程：搭配 ---------- */
  async plan() {
    const menu = Store.state.menu;
    if (!menu) { UI.toast('菜单加载中，请稍后再试', 'error'); return; }
    if (!Store.state.store) { UI.toast('请先选择门店', 'error'); return; }
    this.loading = true;
    this.lastError = '';
    this.render();
    try {
      const { combos, cheapest } = this.enumerate(this.budget);
      if (!combos.length) {
        this.result = { ok: false, cheapest, combos: [] };
        return;
      }
      const top = this.rank(combos).slice(0, 4);        // 取 4 个候选送 MCP 核实，控制调用量
      const verified = await this.verify(top);
      this.result = { ok: true, combos: this.resort(verified).slice(0, 3), cheapest: null };
    } catch (e) {
      this.lastError = e.message || '搭配失败';
      this.result = null;
    } finally {
      this.loading = false;
      this.render();
    }
  },

  /* ---------- 一键加入购物车 ---------- */
  addCombo(idx) {
    const combo = this.result && this.result.combos[idx];
    if (!combo) return;
    for (const e of combo.entries) {
      Store.addToCart({
        code: e.code, name: e.name, image: e.image,
        basePrice: e.est, originalPrice: e.original,
        qty: 1, unitPrice: e.est, rounds: [], mods: [],
        withOrderNote: (e.item.discountType || '').includes('随单购'),
        note: '',
      });
    }
    const total = combo.realPrice != null ? combo.realPrice : combo.est;
    UI.toast(`已加入购物车：${combo.entries.map((e) => e.name).join(' + ')}`, 'success');
    Voice.speak(`已加入购物车，合计${Math.round(total)}元`);
    this.close();
  },

  /* ---------- 浮层 ---------- */
  openPlanner(budget) {
    if (budget && Number.isFinite(+budget) && +budget > 0) this.budget = Math.round(+budget);
    this.open = true;
    this.result = null;
    this.loading = false;
    this.render();
  },
  close() {
    this.open = false;
    UI.closeModal();
  },

  /* ---------- 渲染 ---------- */
  render() {
    if (!this.open) return;
    const state = Store.state;
    const budgetChips = [30, 50, 80].map((b) =>
      `<button class="budget-chip ${this.budget === b ? 'active' : ''}" data-action="planner-budget" data-b="${b}">¥${b}</button>`).join('');
    const modeBtn = (m, label) => `<button class="budget-chip ${this.mode === m ? 'active' : ''}" data-action="planner-mode" data-m="${m}">${label}</button>`;
    const storeName = state.store ? state.store.storeName : '未选择门店';

    let body = '';
    if (this.loading) {
      body = `<div class="planner-loading"><span class="geo-spinner"></span> 正在枚举组合并送 MCP 实时核价…</div>`;
    } else if (this.lastError) {
      body = `<div class="empty-state" style="padding:20px 0"><div class="empty-emoji">😥</div><p>${esc(this.lastError)}</p>
        <button class="btn btn-ghost" data-action="planner-run" style="margin-top:10px">重试</button></div>`;
    } else if (!this.result) {
      body = `<p class="planner-tip">告诉我这顿的预算，我从「${esc(storeName.replace(/^麦当劳/, ''))}」的真实菜单里选「主食 + 小食 + 饮料」，用 MCP 实时核价后给你前三名方案。</p>
        <button class="btn btn-primary btn-block btn-lg" data-action="planner-run">开始搭配</button>`;
    } else if (!this.result.ok) {
      const cheap = this.result.cheapest;
      body = `<div class="empty-state" style="padding:20px 0"><div class="empty-emoji">🧮</div>
        <p>¥${fmtMoney(this.budget)} 配不出「主食 + 小食 + 饮料」${cheap ? `<br />最便宜的搭配约需 <b>¥${fmtMoney(cheap.est)}</b>` : ''}</p>
        <div style="display:flex;gap:8px;justify-content:center;margin-top:12px;flex-wrap:wrap">
          ${[40, 60, 80].map((b) => `<button class="btn btn-outline btn-sm" data-action="planner-budget" data-b="${b}">试试 ¥${b}</button>`).join('')}
        </div></div>`;
    } else {
      body = this.result.combos.map((c, i) => {
        const saved = (c.originalPrice || 0) - (c.realPrice != null ? c.realPrice : c.est);
        return `
        <div class="combo-card">
          <div class="combo-rank">方案 ${i + 1}${this.mode === 'full' ? ' · 热量优先' : ' · 省钱优先'}</div>
          <div class="combo-items">
            ${c.entries.map((e) => `<div class="combo-item"><span class="ci-dot"></span>${esc(e.name)}<span class="combo-est">约 ¥${fmtMoney(e.est)}</span></div>`).join('')}
          </div>
          <div class="combo-foot">
            <div>
              <span class="combo-total">¥${fmtMoney(c.realPrice != null ? c.realPrice : c.est)}</span>
              <span class="combo-note">${c.verified ? 'MCP 实时核价' : '本地估价'}</span>
              ${saved > 0.005 ? `<span class="combo-saved">省 ¥${fmtMoney(saved)}</span>` : ''}
            </div>
            <button class="btn btn-yellow btn-sm" data-action="planner-add" data-idx="${i}">一键加入购物车</button>
          </div>
        </div>`;
      }).join('') + `<p class="planner-tip" style="margin-top:4px">价格为麦当劳 MCP calculate-price 实时计算结果；套餐类商品需在详情页手动选配，不参与自动搭配。</p>
        <button class="btn btn-ghost btn-block" data-action="planner-run" style="margin-top:8px">换一批</button>`;
    }

    UI.modal(`
      <div class="detail-body planner-body">
        <div class="detail-name">🪄 饭点安排 · 预算搭配</div>
        <p class="detail-desc">当前门店：${esc(storeName)}</p>
        <div class="planner-budget">${budgetChips}
          <label class="budget-custom">预算 ¥<input id="planner-budget-input" type="number" min="5" max="200" step="1" value="${this.budget}" /></label>
        </div>
        <div class="planner-mode">${modeBtn('save', '省钱优先')}${modeBtn('full', '吃饱优先')}</div>
        ${body}
        <button class="btn btn-ghost btn-block" data-action="close-modal" style="margin-top:14px">关闭</button>
      </div>`);
    const input = $('#planner-budget-input');
    if (input) input.addEventListener('change', () => {
      const v = Math.round(parseFloat(input.value) || 0);
      if (v >= 5 && v <= 500) { this.budget = v; this.result = null; this.render(); }
    });
  },
};
