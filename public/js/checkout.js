/* 结算流程：确认订单 → 优惠券优先领取 → MCP 核价 → 创建订单 */
'use strict';

const CheckoutCtrl = {
  /** 进入结算页：空车拦截 + 预取取餐方式 */
  async enter() {
    const state = Store.state;
    if (!state.cart.length) {
      UI.toast('购物车是空的，先去点餐吧', 'error');
      go('menu');
      return;
    }
    if (!state.ui.checkout.priceResult) {
      Store.patchCheckout({ step: 1 });
      this.render(Store.state);
      try {
        const r = await Api.calculatePrice(state.store.storeCode, state.cart, null, state.ui.checkout.needTableware);
        Store.patchCheckout({ priceResult: r });
      } catch (e) {
        UI.toast(e.message, 'error');
      }
    }
    this.render(Store.state);
  },

  render(state) {
    const c = state.ui.checkout;
    const root = $('#view-root');
    if (!state.cart.length && !c.orderResult) {
      root.innerHTML = `<div class="empty-state"><div class="empty-emoji">🛒</div><p>购物车是空的</p>
        <button class="btn btn-yellow" data-action="goto" data-route="menu" style="margin-top:12px">去点餐</button></div>`;
      return;
    }
    const steps = `
      <div class="steps">
        <div class="step ${c.step >= 1 ? (c.step > 1 ? 'done' : 'active') : ''}" data-num="1">确认订单</div>
        <div class="step ${c.step >= 2 ? (c.step > 2 ? 'done' : 'active') : ''}" data-num="2">优惠券</div>
        <div class="step ${c.step >= 3 ? (c.step > 3 ? 'done' : 'active') : ''}" data-num="3">核价确认</div>
        <div class="step ${c.step >= 4 ? 'active' : ''}" data-num="4">完成</div>
      </div>`;
    let body = '';
    if (c.step === 1) body = this.step1(state);
    else if (c.step === 2) body = this.step2(state);
    else if (c.step === 3) body = this.step3(state);
    else body = this.step4(state);
    root.innerHTML = `<div class="checkout-wrap">${steps}${body}</div>`;
    if (c.step === 2 && !c.couponsLoaded) this.loadCoupons();
  },

  /* ---------- 第 1 步：确认订单 ---------- */
  step1(state) {
    const c = state.ui.checkout;
    const takeWays = c.priceResult?.takeWayList?.length
      ? c.priceResult.takeWayList
      : [{ code: 'eat-in', title: '堂食', subtitle: '店内用餐' }, { code: 'take-in-store', title: '外带', subtitle: '店内自提' }];
    return `
      <div class="checkout-card">
        <h3>📍 门店与取餐方式</h3>
        <p style="font-size:13px;color:var(--ink-2);line-height:1.7">
          <b>${esc(state.store?.storeName || '')}</b><br />${esc(state.store?.address || '')}
          ${state.store?.businessStartTime ? ` · 营业 ${state.store.businessStartTime}-${state.store.businessEndTime}` : ''}
        </p>
        <div class="takeway-row" style="margin-top:14px">
          ${takeWays.map((t) => `
            <div class="takeway-opt ${c.takeWay === t.code ? 'selected' : ''}" data-action="pick-takeway" data-code="${esc(t.code)}">
              <div class="tw-title">${esc(t.title)}</div>
              <div class="tw-sub">${esc(t.subtitle || '')}</div>
            </div>`).join('')}
        </div>
        <label style="display:flex;align-items:center;gap:8px;margin-top:14px;font-size:14px;cursor:pointer">
          <input type="checkbox" id="tableware-toggle" ${c.needTableware ? 'checked' : ''} />
          需要餐具（可能产生餐具费）
        </label>
      </div>

      <div class="checkout-card">
        <h3>🧾 订单清单（${Store.cartCount()} 件）</h3>
        ${state.cart.map((line) => `
          <div class="co-item">
            <img src="${esc(line.image)}" alt="" onerror="this.style.opacity=0" />
            <div>
              <div class="coi-name">${esc(line.name)}</div>
              ${line.note ? `<div class="coi-opt">${esc(line.note)}</div>` : ''}
              ${line.withOrderNote ? `<div class="coi-opt" style="color:#c2410c">未随单购卡 · 按原价结算</div>` : ''}
            </div>
            <div class="coi-price">×${line.qty}<br />¥${fmtMoney(line.unitPrice * line.qty)}</div>
          </div>`).join('')}
        <div class="price-line" style="margin-top:12px"><span>预估商品合计</span><span class="pl-value">¥${fmtMoney(Store.cartSubtotal())}</span></div>
      </div>

      <div class="checkout-card" style="display:flex;gap:10px">
        <button class="btn btn-ghost" data-action="goto" data-route="menu">再逛逛</button>
        <button class="btn btn-primary btn-lg" style="flex:1" data-action="checkout-next">下一步 · 选优惠券</button>
      </div>`;
  },

  /* ---------- 第 2 步：优惠券优先领取 ---------- */
  step2(state) {
    const c = state.ui.checkout;
    const claimable = (c.claimable || []).length;
    const coupons = c.coupons || [];
    return `
      <div class="checkout-card">
        <h3>🎟️ 优惠券（优先领取）</h3>
        <div class="coupon-banner">
          <span class="cb-icon">🎁</span>
          <div class="cb-text">
            <div class="cb-title">麦麦省可领优惠券 ${claimable} 张</div>
            <div class="cb-sub">下单前自动为你领取全部可用券，不错过任何优惠</div>
          </div>
          <button class="btn btn-yellow btn-sm" data-action="claim-coupons" ${c.claiming ? 'disabled' : ''}>
            ${c.claiming ? '领取中…' : claimable ? '一键领取' : '已全部领取'}
          </button>
        </div>
        <div class="coupon-list">
          <div class="coupon-card ${!c.coupon ? 'selected' : ''}" data-action="pick-coupon" data-idx="-1">
            <div class="cc-left" style="background:linear-gradient(160deg,#9a9a9a,#7a7a7a)"><span class="cc-amount">—</span><span class="cc-desc">不使用优惠券</span></div>
            <div class="cc-body"><div class="cc-title">不使用优惠券</div><div class="cc-meta">按商品原价结算</div></div>
            <div class="cc-check"><span class="cc-radio"></span></div>
          </div>
          ${coupons.map((cp, i) => {
            const matched = Api.couponMatchedCodes(cp, state.cart);
            const usable = matched.size > 0 || !cp.products?.length;
            return `
            <div class="coupon-card ${c.coupon && c.coupon.idx === i ? 'selected' : ''} ${usable ? '' : 'disabled'}" data-action="pick-coupon" data-idx="${i}">
              <div class="cc-left">
                <span class="cc-amount">${cp.discountValue ? `<small>¥</small>${esc(cp.discountValue)}` : '券'}</span>
                <span class="cc-desc">${esc(cp.discountDesc || '麦当劳优惠券')}</span>
              </div>
              <div class="cc-body">
                <div class="cc-title">${esc(cp.title)}</div>
                <div class="cc-meta">${cp.validityText ? '有效期：' + esc(cp.validityText) + '<br />' : ''}${esc(cp.sourceText)}</div>
                <div class="cc-tags">
                  ${(cp.tags || []).map((t) => `<span class="chip chip-yellow">${esc(t)}</span>`).join('')}
                  ${usable ? `<span class="chip chip-green">适用于当前购物车</span>` : `<span class="chip">不适用当前商品</span>`}
                </div>
              </div>
              <div class="cc-check"><span class="cc-radio"></span></div>
            </div>`;
          }).join('') || `<div class="empty-state" style="padding:24px"><div class="empty-emoji">🎫</div><p>暂无可用的优惠券</p></div>`}
        </div>
        <div style="display:flex;gap:10px;margin-top:16px">
          <button class="btn btn-ghost" data-action="checkout-back">上一步</button>
          <button class="btn btn-outline" data-action="smart-coupon" style="flex:1">🪄 智能选最优</button>
          <button class="btn btn-primary" style="flex:1" data-action="checkout-next">去核价</button>
        </div>
      </div>`;
  },

  /* ---------- 第 3 步：核价确认 ---------- */
  step3(state) {
    const c = state.ui.checkout;
    const r = c.priceResult;
    if (!r) {
      // 核价失败/未完成：给出重试入口，避免永久骨架屏
      return `
      <div class="checkout-card">
        <h3>💰 价格确认</h3>
        <div class="empty-state" style="padding:20px 0">
          <div class="empty-emoji">🧾</div>
          <p>核价失败或尚未完成${Api.authFailed ? '<br /><span style="color:#c2410c">服务端 Token 可能已失效，请更新后重试</span>' : ''}</p>
          <button class="btn btn-primary" data-action="retry-price" style="margin-top:12px">重新核价</button>
        </div>
      </div>
      <div class="checkout-card" style="display:flex;gap:10px">
        <button class="btn btn-ghost" data-action="checkout-back">上一步</button>
      </div>`;
    }
    const coupon = c.coupon;
    return `
      <div class="checkout-card">
        <h3>💰 价格确认${coupon ? ` · 已选「${esc(coupon.title)}」` : ''}</h3>
        <div class="price-detail">
          <div class="price-line"><span>商品原价</span><span class="pl-value">¥${fmtMoney(fenToYuan(r.productOriginalPrice ?? r.originalPrice))}</span></div>
          <div class="price-line"><span>商品现价</span><span class="pl-value">¥${fmtMoney(fenToYuan(r.productPrice))}</span></div>
          ${r.discount ? `<div class="price-line discount"><span>优惠券优惠</span><span class="pl-value">-¥${fmtMoney(fenToYuan(r.discount))}</span></div>` : ''}
          ${r.packingPrice ? `<div class="price-line"><span>打包费</span><span class="pl-value">¥${fmtMoney(fenToYuan(r.packingPrice))}</span></div>` : ''}
          ${r.tablewarePrice ? `<div class="price-line"><span>餐具费</span><span class="pl-value">¥${fmtMoney(fenToYuan(r.tablewarePrice))}</span></div>` : ''}
          <div class="price-line grand"><span>应付合计</span><span class="pl-value">¥${fmtMoney(fenToYuan(r.price))}</span></div>
        </div>
        ${r.enjoyable && r.enjoyable.balance ? `<p class="price-note" style="margin-top:10px">💡 再购 ¥${fmtMoney(fenToYuan(r.enjoyable.balance))} 可享受更多优惠</p>` : ''}
        <p class="price-note" style="margin-top:10px">价格由麦当劳 MCP calculate-price 实时计算，与门店实际计费一致。</p>
      </div>

      <div class="checkout-card" style="display:flex;gap:10px">
        <button class="btn btn-ghost" data-action="checkout-back">上一步</button>
        <button class="btn btn-primary btn-lg" style="flex:1" data-action="confirm-order">确认下单</button>
      </div>`;
  },

  /* ---------- 第 4 步：下单结果（取餐码 + 支付链接 + 取餐柜二维码闭环） ---------- */
  step4(state) {
    const c = state.ui.checkout;
    const o = c.orderResult || {};
    const od = o.orderDetail || {};
    const payUrl = o.payH5Url || od.payH5Url || '';
    const statusText = ORDER_STATUS[String(od.orderStatus)] || o.status || '待支付';
    const realTotal = od.realTotalAmount || (c.priceResult ? fenToYuan(c.priceResult.price) : null);
    const discount = od.totalDiscountAmount || '';
    return `
      <div class="checkout-card order-success">
        <div class="os-icon">🎉</div>
        <h2>下单成功</h2>
        <p class="os-status">订单状态：${esc(statusText)}${discount ? ` · 本单优惠 ¥${esc(discount)}` : ''}</p>
        ${realTotal != null ? `<div class="os-code">¥${fmtMoney(realTotal)}</div><p>实付金额</p>` : ''}
        ${o.pickupCode || od.pickupCode ? `<div class="os-code">${esc(o.pickupCode || od.pickupCode)}</div><p>取餐码</p>` : ''}
        ${od.lockerQrCode ? `<img class="os-locker-qr" src="${esc(od.lockerQrCode)}" alt="取餐柜二维码" />` : ''}
        ${od.lockerCode ? `<div class="os-code small">${esc(od.lockerCode)}</div><p>取餐柜密码</p>` : ''}
        ${od.expirePayTime ? `<p class="os-expire">支付截止：${esc(od.expirePayTime)}</p>` : ''}
        <p>订单号：${esc(o.orderId || od.orderId || '-')}<br />
        ${esc(o.message || '请通过支付链接或麦当劳 App 完成支付。')}</p>
        <div class="os-actions">
          ${payUrl ? `<a class="btn btn-primary btn-lg" href="${esc(payUrl)}" target="_blank" rel="noopener">去支付</a>` : ''}
          <button class="btn btn-ghost" data-action="goto" data-route="menu">返回点餐</button>
          <button class="btn btn-primary" data-action="goto" data-route="orders">查看订单</button>
        </div>
      </div>`;
  },

  /* ---------- 数据加载 ---------- */
  async loadCoupons() {
    const state = Store.state;
    Store.patchCheckout({ couponsLoaded: true });
    try {
      const [available, mine, storeCoupons] = await Promise.all([
        Api.getAvailableCoupons(),
        Api.getMyCoupons(),
        Api.getStoreCoupons(state.store.storeCode),
      ]);
      const claimable = (available || []).filter((c) => {
        const s = c.claimStatus || c.couponStatus || '';
        return s === 'CAN_GET' || s === '可领取';
      });
      const norm = (c, source) => ({
        id: c.id || c.couponId || '',
        code: c.code || c.couponCode || '',
        title: c.title || c.couponName || '',
        discountValue: c.discountValue || '',
        discountDesc: c.discountDesc || '',
        validityText: c.validityText || c.datetimeText || c.tradeDateTime || '',
        tags: c.tags || [],
        products: c.products || [],
        source,
        sourceText: source === 'mine' ? '我的券包' : '门店可用券',
      });
      const list = [
        ...(mine || []).map((c) => norm(c, 'mine')),
        ...(storeCoupons || []).map((c) => norm(c, 'store')),
      ].filter((c) => c.id || c.title);
      Store.patchCheckout({ coupons: list, claimable });
    } catch (e) {
      UI.toast('优惠券加载失败：' + e.message, 'error');
    }
    this.render(Store.state);
  },

  /** 一键领取 */
  async claim() {
    const state = Store.state;
    Store.patchCheckout({ claiming: true });
    this.render(state);
    try {
      await Api.claimCoupons();
      const mine = await Api.getMyCoupons();
      const norm = (c, source) => ({
        id: c.id || c.couponId || '', code: c.code || c.couponCode || '',
        title: c.title || c.couponName || '', discountValue: c.discountValue || '',
        discountDesc: c.discountDesc || '', validityText: c.validityText || c.datetimeText || c.tradeDateTime || '',
        tags: c.tags || [], products: c.products || [], source, sourceText: '我的券包',
      });
      const list = [
        ...(mine || []).map((c) => norm(c, 'mine')),
        ...(Store.state.ui.checkout.coupons || []).filter((c) => c.source === 'store'),
      ];
      Store.patchCheckout({ coupons: list, claimable: [], claiming: false, coupon: null, priceResult: null });
      UI.toast(`领取成功，当前可用 ${list.length} 张券`, 'success');
    } catch (e) {
      Store.patchCheckout({ claiming: false });
      UI.toast(Api.authFailed
        ? '领券失败：服务端 MCP Token 可能已失效，请更新 .env 的 MCD_MCP_TOKEN 后重启服务'
        : '领券失败：' + e.message, 'error');
    }
    this.render(Store.state);
  },

  /** 智能选最优：并行试算全部适用券，取到手价最低 */
  async smartPick() {
    const state = Store.state;
    const candidates = (state.ui.checkout.coupons || []).filter((c) => Api.couponMatchedCodes(c, state.cart).size > 0).slice(0, 8);
    if (!candidates.length) {
      UI.toast('当前购物车没有适用券', 'error');
      return;
    }
    UI.toast(`正在试算 ${candidates.length} 张适用券…`);
    // 并行试算（限流 600 次/分钟内完全可控），单张失败不影响其他券
    const settled = await Promise.allSettled(candidates.map(async (cp) => {
      const r = await Api.calculatePrice(state.store.storeCode, state.cart, cp, state.ui.checkout.needTableware);
      return { coupon: cp, price: r.price ?? Infinity, result: r };
    }));
    let best = null;
    for (const s of settled) {
      if (s.status !== 'fulfilled') continue;
      if (!best || s.value.price < best.price) best = s.value;
    }
    if (!best) { UI.toast('试算失败，请手动选择', 'error'); return; }
    Store.patchCheckout({
      coupon: { ...best.coupon, idx: (state.ui.checkout.coupons || []).indexOf(best.coupon) },
      priceResult: best.result,
    });
    UI.toast(`已选最优：${best.coupon.title}，到手价 ¥${fmtMoney(fenToYuan(best.price))}`, 'success');
    this.render(Store.state);
  },

  /** 核价并进入第 3 步 */
  async goPrice() {
    const state = Store.state;
    try {
      const coupon = state.ui.checkout.coupon && state.ui.checkout.coupon.idx >= 0
        ? (state.ui.checkout.coupons || [])[state.ui.checkout.coupon.idx] : null;
      const r = await Api.calculatePrice(state.store.storeCode, state.cart, coupon, state.ui.checkout.needTableware);
      Store.patchCheckout({ priceResult: r, step: 3 });
    } catch (e) {
      UI.toast('核价失败：' + e.message, 'error');
    }
    this.render(Store.state);
  },

  /** 确认下单 */
  async confirmOrder(btn) {
    const state = Store.state;
    UI.btnLoading(btn, '下单中');
    try {
      const c = state.ui.checkout;
      const coupon = c.coupon && c.coupon.idx >= 0 ? (c.coupons || [])[c.coupon.idx] : null;
      const r = await Api.createOrder(state.store.storeCode, state.cart, coupon, c.takeWay, c.needTableware);
      const od = r.orderDetail || {};
      const order = {
        orderId: r.orderId || od.orderId || String(Date.now()),
        pickupCode: od.pickupCode || r.pickupCode || '',
        status: ORDER_STATUS[String(od.orderStatus)] || r.status || '待支付',
        storeName: od.storeName || state.store?.storeName || '',
        takeWay: (c.priceResult?.takeWayList || []).find((t) => t.code === c.takeWay)?.title || c.takeWay,
        items: state.cart.map((l) => ({ name: l.name, qty: l.qty, unitPrice: l.unitPrice })),
        total: parseFloat(od.realTotalAmount) || fenToYuan(c.priceResult?.price ?? Store.cartSubtotal() * 100),
        time: od.createTime || new Date().toLocaleString('zh-CN', { hour12: false }),
        message: r.message || '',
        payH5Url: r.payH5Url || '',
        lockerQrCode: od.lockerQrCode || '',
        lockerCode: od.lockerCode || '',
        expirePayTime: od.expirePayTime || '',
      };
      Store.addOrder(order);
      Store.clearCart();
      Store.patchCheckout({ step: 4, orderResult: { ...r, orderDetail: od } });
      UI.toast('下单成功，请完成支付', 'success');
    } catch (e) {
      UI.toast(Api.authFailed
        ? '下单失败：服务端 MCP Token 可能已失效，请更新 .env 的 MCD_MCP_TOKEN 后重启服务'
        : '下单失败：' + e.message, 'error');
    }
    UI.btnRestore(btn);
    this.render(Store.state);
  },
};

/** MCP orderStatus 数字码 → 中文（create-order 返回数字，order-list 返回中文文案） */
const ORDER_STATUS = {
  '1': '待支付', '2': '已支付 · 配餐中', '4': '配送中',
  '6': '已完成', '7': '已取消', '8': '已评价', '10': '餐厅确认配餐中',
};
