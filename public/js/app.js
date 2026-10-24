/* 应用入口：初始化 / 路由 / 全局事件委托 */
'use strict';

(function boot() {
  const ROUTES = ['menu', 'cart', 'checkout', 'orders'];

  function currentRoute() {
    const h = location.hash.replace(/^#\/?/, '').split('?')[0] || 'menu';
    return ROUTES.includes(h) ? h : 'menu';
  }

  /* ---------- 数据加载 ---------- */
  async function loadMenu() {
    const state = Store.state;
    if (!state.store) return;
    try {
      const menu = await Api.getMenu(state.store.storeCode);
      Store.setMenu(menu);
    } catch (e) {
      UI.toast('菜单加载失败：' + e.message, 'error');
    }
  }

  async function switchStore(storeCode) {
    const s = Store.state.stores.find((x) => x.storeCode === storeCode);
    if (!s) return;
    Store.setStore(s);
    Store.resetCheckout();
    UI.toast('已切换：' + s.storeName);
    await loadMenu();
  }

  /* ---------- 实时定位 ---------- */
  /**
   * 定位并搜索附近门店。
   * 流程：Geo.locate（设备定位 + 逆向地理编码）→ Api.getStoresByLocation（MCP 按关键词搜索）
   *      → 按距离升序 → 当前门店不在列表时自动选最近门店。
   * 异常：权限拒绝 / 不可用 / 超时 / 非安全上下文 → geo 状态置 error，UI 展示引导与手动兜底。
   */
  async function locateStores(force = false) {
    Store.patchGeo({ status: 'locating', error: null, note: null });
    let result;
    try {
      const { position, place } = await Geo.locate({ force });
      Store.patchGeo({ status: 'success', position, place });
      try {
        result = await Api.getStoresByLocation(place);
      } catch (e) {
        UI.toast('门店搜索失败：' + e.message, 'error');
        result = { stores: [], geoNote: null, located: !!place };
      }
    } catch (e) {
      Store.patchGeo({
        status: 'error',
        error: { code: e.geoCode || 'ERROR', reason: e.reason || e.message || '定位失败', hint: e.hint || '' },
      });
      UI.toast(e.reason || '定位失败', 'error');
      return;
    }

    const place = Store.state.geo.place;
    Store.setStores(result.stores, {
      label: place ? place.label : '国贸',
      city: place ? place.city : '北京市',
      keyword: place ? place.keyword : '国贸',
      located: result.located,
    });
    Store.patchGeo({ note: result.geoNote });

    const st = Store.state;
    if (!result.stores.length) {
      UI.toast(place ? '该位置附近未找到门店，请手动搜索' : '已定位，请手动输入城市与关键词搜索', 'error');
      return;
    }
    const curInList = st.store && result.stores.some((s) => s.storeCode === st.store.storeCode);
    if (!curInList) {
      Store.setStore(result.stores[0]);
      Store.resetCheckout();
      UI.toast(`已定位，最近门店：${result.stores[0].storeName.replace(/^麦当劳/, '')}`, 'success');
      await loadMenu();
    } else {
      UI.toast(`已定位：附近 ${result.stores.length} 家门店，已按距离排序`, 'success');
    }
  }

  /* ---------- 全局事件委托 ---------- */
  async function onClick(e) {
    const el = e.target.closest('[data-action]');
    if (!el) return;
    const act = el.dataset.action;
    const state = Store.state;

    switch (act) {
      case 'quick-search':
        Store.setCategory('全部');
        Store.setSearch(el.dataset.kw);
        break;

      case 'pick-category':
        Store.setSearch('');
        Store.setCategory(el.dataset.cat);
        break;

      case 'open-detail':
        Store.openDetail(el.dataset.code);
        break;

      case 'quick-add': {
        // 单品一键加购；套餐类打开详情进行选配
        const item = state.menu?.meals[el.dataset.code];
        if (!item) break;
        if (/套餐|组合|件套|随心配|餐$|分享餐/.test(item.name)) {
          Store.openDetail(item.code);
        } else {
          Store.addToCart({
            code: item.code, name: item.name, image: item.image,
            basePrice: estimateUnitPrice(item), originalPrice: parseFloat(item.originalPrice ?? item.currentPrice) || 0,
            qty: 1, unitPrice: estimateUnitPrice(item), rounds: [], mods: [],
            withOrderNote: (item.discountType || '').includes('随单购'),
            note: '',
          });
          UI.toast(`已加入购物车：${item.name}`, 'success');
        }
        break;
      }

      case 'pick-store':
        await switchStore(el.dataset.code);
        Store.setStorePicker(false);
        break;

      case 'locate-me':
      case 'retry-locate':
        await locateStores(act === 'retry-locate');
        break;

      case 'manual-store-search': {
        const city = (($('#manual-city') || {}).value || '').trim() || '北京市';
        const kw = (($('#manual-kw') || {}).value || '').trim() || '国贸';
        UI.btnLoading(el, '搜索中');
        try {
          const { stores, note } = await Api.getStores(city, kw);
          Store.setStores(stores, { label: kw, city, keyword: kw, located: false });
          Store.patchGeo({ note });
          UI.toast(stores.length ? `找到 ${stores.length} 家门店（实时数据）` : '未找到门店，换个关键词试试', stores.length ? 'success' : 'error');
        } catch (e2) {
          UI.toast('搜索失败：' + e2.message, 'error');
        }
        UI.btnRestore(el);
        break;
      }

      case 'close-modal':
        UI.closeModal();
        Store.closeDetail();
        Store.setStorePicker(false);
        BudgetPlanner.open = false;
        break;

      case 'qty-inc': {
        const line = state.cart.find((l) => l.lineId === el.dataset.line);
        if (line) Store.setQty(line.lineId, line.qty + 1);
        break;
      }
      case 'qty-dec': {
        const line = state.cart.find((l) => l.lineId === el.dataset.line);
        if (line) Store.setQty(line.lineId, line.qty - 1);
        break;
      }
      case 'clear-cart':
        Store.clearCart();
        UI.toast('购物车已清空');
        break;

      case 'goto':
        go(el.dataset.route);
        break;

      case 'open-voice':
        Voice.open();
        break;

      /* ---- 饭点安排 · 预算搭配 ---- */
      case 'open-planner':
        BudgetPlanner.openPlanner();
        break;
      case 'planner-budget':
        BudgetPlanner.budget = parseInt(el.dataset.b, 10) || BudgetPlanner.budget;
        BudgetPlanner.result = null;
        BudgetPlanner.render();
        break;
      case 'planner-mode':
        BudgetPlanner.mode = el.dataset.m === 'full' ? 'full' : 'save';
        BudgetPlanner.result = null;
        BudgetPlanner.render();
        break;
      case 'planner-run':
        BudgetPlanner.plan();
        break;
      case 'planner-add':
        BudgetPlanner.addCombo(parseInt(el.dataset.idx, 10));
        break;
      case 'retry-price': {
        UI.btnLoading(el, '核价中');
        await CheckoutCtrl.goPrice();
        UI.btnRestore(el);
        break;
      }

      /* ---- 详情弹层 ---- */
      case 'pick-round':
        Draft.setRoundChoice(parseInt(el.dataset.round, 10), el.dataset.code);
        UI.refresh();
        break;
      case 'toggle-mod':
        Draft.toggleMod(el.dataset.group, parseInt(el.dataset.idx, 10));
        UI.refresh();
        break;
      case 'draft-qty':
        if (Draft.d) Draft.d.qty = Math.max(1, Draft.d.qty + parseInt(el.dataset.n, 10));
        UI.refresh();
        break;
      case 'detail-add': {
        if (!Draft.d) break;
        const line = Draft.buildCartLine();
        Store.addToCart(line);
        Store.closeDetail();
        UI.toast(`已加入购物车：${line.name}${line.qty > 1 ? ' ×' + line.qty : ''}`, 'success');
        Voice.speak(`已加入购物车，${line.name}`);
        break;
      }

      /* ---- 结算 ---- */
      case 'pick-takeway':
        Store.patchCheckout({ takeWay: el.dataset.code });
        break;
      case 'checkout-next': {
        const c = state.ui.checkout;
        if (c.step === 1) {
          Store.patchCheckout({ step: 2 });
        } else if (c.step === 2) {
          const btn = el;
          UI.btnLoading(btn, '核价中');
          await CheckoutCtrl.goPrice();
          UI.btnRestore(btn);
        }
        break;
      }
      case 'checkout-back':
        Store.patchCheckout({ step: Math.max(1, state.ui.checkout.step - 1) });
        break;
      case 'claim-coupons':
        await CheckoutCtrl.claim();
        break;
      case 'smart-coupon':
        await CheckoutCtrl.smartPick();
        break;
      case 'pick-coupon': {
        const idx = parseInt(el.dataset.idx, 10);
        const coupons = state.ui.checkout.coupons || [];
        const cp = idx >= 0 ? coupons[idx] : null;
        // 不适用当前购物车的券不可选（避免 MCP 600012）
        if (cp && cp.products && cp.products.length && Api.couponMatchedCodes(cp, state.cart).size === 0) {
          UI.toast('该券不适用于当前购物车商品', 'error');
          break;
        }
        Store.patchCheckout({ coupon: cp ? { ...cp, idx } : null, priceResult: null });
        break;
      }
      case 'confirm-order':
        await CheckoutCtrl.confirmOrder(el);
        break;

      /* ---- 语音建议 ---- */
      case 'voice-cmd':
        Voice.handleCommand(el.dataset.cmd);
        break;

      default:
        break;
    }
  }

  function onChange(e) {
    if (e.target.id === 'tableware-toggle') {
      Store.patchCheckout({ needTableware: e.target.checked, priceResult: null });
    }
  }

  /** 后端不可用：展示配置提示（无 MCP Token / 网络不可达），不使用任何模拟数据 */
  function renderBackendRequired(error) {
    const badge = document.querySelector('#mode-badge');
    if (badge) { badge.textContent = '⚠ 后端未连接'; badge.className = 'mode-badge offline'; badge.title = '未连接真实后端，无法获取门店与菜单'; }
    const root = document.querySelector('#view-root');
    if (!root) return;
    root.dataset.view = 'backend-required';
    root.innerHTML = `
      <div class="backend-required">
        <div class="br-emoji">🔌</div>
        <h1>未连接真实后端</h1>
        <p>本应用已移除演示模式，必须连接持有麦当劳 MCP Token 的后端才能获取真实门店与菜单。</p>
        <ul class="br-list">
          <li><b>本地运行：</b>在服务端目录配置 <code>.env</code> 的 <code>MCD_MCP_TOKEN</code> 后执行 <code>npm start</code>。</li>
          <li><b>线上运行：</b>Cloudflare Pages 需配置密钥 <code>MCD_MCP_TOKEN</code>（<code>wrangler secret put</code>），由 Pages Function 代理真实接口。</li>
        </ul>
        ${error ? `<p class="br-error">原因：${esc(error)}</p>` : ''}
        <button class="btn btn-primary" onclick="location.reload()">重试</button>
      </div>`;
  }

  /* ---------- 启动 ---------- */
  (async function main() {
    Store.hydrate();
    const mode = await Api.init();
    Store.setMode(mode);

    // 后端不可用（无 MCP Token / 网络不可达）：展示「需配置后端」，绝不回退到模拟数据
    if (mode !== 'live') {
      renderBackendRequired(Api.backendError);
      return;
    }

    Voice.init();

    // 门店与菜单
    try {
      const { stores, note } = await Api.getStores('北京市', '国贸');
      Store.setStores(stores, { label: '国贸', city: '北京市', keyword: '国贸', located: false });
      Store.patchGeo({ note });
      if (!Store.state.store || !stores.some((s) => s.storeCode === Store.state.store.storeCode)) {
        if (stores[0]) Store.setStore(stores[0]);
      }
    } catch (e) {
      UI.toast('门店加载失败：' + e.message, 'error');
    }
    await loadMenu();
    Api.getNutrition().then((n) => Store.setNutrition(n)).catch(() => {});

    // 路由
    const applyRoute = () => {
      const r = currentRoute();
      if (Store.state.ui.route !== r) Store.setRoute(r);
      if (r === 'checkout') CheckoutCtrl.enter();
    };
    window.addEventListener('hashchange', applyRoute);
    if (location.hash) applyRoute();

    // 渲染订阅与事件
    Store.subscribe((s) => Views.render(s));
    document.addEventListener('click', onClick);
    document.addEventListener('change', onChange);
    window.addEventListener('resize', debounce(() => Views.render(Store.state), 200));

    // 顶栏按钮
    $('#store-pill').addEventListener('click', () => Store.setStorePicker(true));
    $('#header-mic-btn').addEventListener('click', () => Voice.open());
    $('#nav-voice-btn').addEventListener('click', () => Voice.open());
    $('#voice-close-btn').addEventListener('click', () => Voice.close());

    // 语音等跨模块调用入口
    window.AppActions = { locateStores, switchStore };

    Views.render(Store.state);
  })().catch((e) => {
    console.error(e);
    UI.toast('初始化失败：' + e.message, 'error');
  });
})();
