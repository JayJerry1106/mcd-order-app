/* 语音交互：Web Speech API 中文识别 + 语音合成 + 命令解析 */
'use strict';

const Voice = {
  supported: !!(window.SpeechRecognition || window.webkitSpeechRecognition),
  recognition: null,
  active: false,

  init() {
    if (!this.supported) return;
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    this.recognition = new SR();
    this.recognition.lang = 'zh-CN';
    this.recognition.interimResults = true;
    this.recognition.continuous = false;
    this.recognition.maxAlternatives = 1;

    this.recognition.onresult = (e) => {
      const last = e.results[e.results.length - 1];
      const text = last[0].transcript;
      $('#voice-transcript').textContent = text;
      if (last.isFinal) {
        this.setStatus('thinking');
        setTimeout(() => this.handleCommand(text), 350);
      }
    };
    this.recognition.onerror = (e) => this.onRecognError(e);
    this.recognition.onend = () => { this.stopMic(); };

    // 麦克风问题恢复路径：重试按钮（复用环境预检，环境修复后可恢复）
    $('#voice-retry-btn')?.addEventListener('click', () => this.prepareMic());
  },

  /* ---------- 麦克风环境诊断（跨平台：桌面/移动/App 内置浏览器/iframe） ---------- */

  /** 检测运行环境；测试可通过 _envOverrides 注入，避免依赖 jsdom 的 isSecureContext 等实现差异 */
  _detectEnv() {
    const o = this._envOverrides || {};
    const ua = navigator.userAgent || '';
    return {
      secure: o.secure !== undefined ? o.secure : !!window.isSecureContext,
      iframe: o.iframe !== undefined ? o.iframe : (() => { try { return window.self !== window.top; } catch (_) { return true; } })(),
      webview: o.webview !== undefined ? o.webview : /MicroMessenger|QQ\/|Weibo|FB_IAB|Line\//i.test(ua),
    };
  },

  /**
   * 精确归因：Web Speech 的 not-allowed 泛指「UA 禁止语音识别」，
   * 权限被拒只是其中一种原因。iframe 权限策略、App 内置 WebView、
   * 非安全上下文都会报同样的错——混成一句「去设置里允许」会让用户白忙。
   */
  _micIssueText(env, err) {
    if (!env.secure) return { text: '麦克风需要安全环境：请用 HTTPS 或 localhost 打开本页', retry: true, external: false };
    if (env.webview) return { text: '当前 App 内置浏览器不提供麦克风：请复制地址到系统浏览器（Safari/Chrome）打开后使用', retry: false, external: false };
    if (env.iframe) return { text: '页面被嵌入预览，浏览器策略禁止了麦克风：点「在新标签页打开」即可正常使用', retry: true, external: true };
    if (err === 'service-not-allowed') return { text: '语音服务被系统禁用（常见于缺少语音服务的安卓设备），可直接点击下方快捷指令点餐', retry: true, external: false };
    if (err === 'audio-capture') return { text: '未检测到麦克风设备，请检查设备连接后点「重试」', retry: true, external: false };
    return { text: '麦克风权限被拒绝：请点地址栏左侧锁形图标 → 权限 → 允许麦克风，然后点「重试」', retry: true, external: false };
  },

  /** 展示诊断结果 + 恢复动作（重试 / 在新标签页打开） */
  showMicIssue(err) {
    const env = this._detectEnv();
    const issue = this._micIssueText(env, err);
    this.setStatus(issue.text);
    const fix = $('#voice-mic-fix');
    if (fix) {
      fix.hidden = false;
      const ext = $('#voice-open-external');
      if (ext) {
        ext.hidden = !issue.external;
        if (issue.external) ext.href = location.href;
      }
    }
    this.stopMic();
  },

  hideMicIssue() { const f = $('#voice-mic-fix'); if (f) f.hidden = true; },

  /**
   * 打开浮层后的麦克风准备：先做环境与权限预检。
   * Permissions API 不支持（Safari/Firefox）时静默跳过直接尝试——绝不把「无法查询」当成「已拒绝」。
   */
  async prepareMic() {
    this.hideMicIssue();
    if (!this.supported) { this.setStatus('当前浏览器不支持语音识别，请点击下方建议或手动输入'); return; }
    const env = this._detectEnv();
    if (!env.secure || env.webview || env.iframe) { this.showMicIssue('precheck'); return; }
    try {
      if (navigator.permissions && navigator.permissions.query) {
        const st = await navigator.permissions.query({ name: 'microphone' });
        if (st && st.state === 'denied') { this.showMicIssue('not-allowed'); return; }
      }
    } catch (_) { /* 不支持 microphone 查询 → 直接尝试，不误报 */ }
    this.startMic();
  },

  /** 识别错误精确分派：环境类错误走诊断，普通错误给轻提示 */
  onRecognError(e) {
    if (e.error === 'aborted') { this.stopMic(); return; }
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed' || e.error === 'audio-capture') {
      this.showMicIssue(e.error); return;
    }
    const map = { 'no-speech': '没有听到声音，请再试一次', network: '网络异常，语音识别不可用' };
    this.setStatus(map[e.error] || '识别出错：' + e.error);
    this.stopMic();
  },

  /* ---------- 浮层控制 ---------- */
  open() {
    const ov = $('#voice-overlay');
    ov.hidden = false;
    $('#voice-transcript').textContent = '';
    $('#voice-reply').textContent = '';
    $('#voice-suggest').innerHTML = this.suggestionChips();
    this.setStatus(this.supported ? '正在聆听…试试说「我想吃巨无霸」' : '当前浏览器不支持语音识别');
    // 键盘无障碍：Esc 关闭 + Tab 焦点圈定（与模态框一致）
    if (this._unbindKeys) { this._unbindKeys(); this._unbindKeys = null; }
    this._unbindKeys = dialogKeys(ov, () => this.close());
    $('#voice-close-btn').focus?.();
    this.prepareMic(); // 环境与权限预检后启动，失败时给出精确归因与恢复路径
  },
  close() {
    if (this._unbindKeys) { this._unbindKeys(); this._unbindKeys = null; }
    this.stopMic();
    $('#voice-overlay').hidden = true;
  },
  setStatus(t) { $('#voice-status').textContent = t; },
  reply(t) {
    $('#voice-reply').textContent = t;
    this.speak(t);
  },
  startMic() {
    if (!this.supported) { this.setStatus('当前浏览器不支持语音识别，请点击下方建议或手动输入'); return; }
    try {
      this.recognition.start();
      this.active = true;
      $('#voice-orb').classList.remove('thinking');
      $('#header-mic-btn')?.classList.add('recording');
    } catch (_) { /* 重复 start 忽略 */ }
  },
  stopMic() {
    this.active = false;
    $('#voice-orb')?.classList.add('thinking');
    $('#header-mic-btn')?.classList.remove('recording');
    try { this.recognition && this.recognition.stop(); } catch (_) { /* ignore */ }
  },
  speak(text) {
    try {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'zh-CN';
      u.rate = 1.05;
      speechSynthesis.speak(u);
    } catch (_) { /* ignore */ }
  },

  suggestionChips() {
    const chips = ['我想吃巨无霸', '有什么优惠', '打开购物车', '去结算', '定位附近门店'];
    return chips.map((c) => `<button data-action="voice-cmd" data-cmd="${esc(c)}">${esc(c)}</button>`).join('');
  },

  /* ---------- 命令解析与执行 ---------- */
  async handleCommand(raw) {
    const text = String(raw || '').trim().replace(/[，。！？!?,.~～\s]+$/g, '');
    if (!text) { this.setStatus('没有听清，请再说一次'); this.startMic(); return; }
    $('#voice-transcript').textContent = text;
    this.setStatus('思考中…');
    const state = Store.state;
    const menu = state.menu;
    let reply = '';

    // 1) 退出/关闭
    if (/^(关闭|退出|取消|回去)/.test(text)) { this.close(); return; }

    // 2) 帮助
    if (/帮助|怎么用|你能做什么/.test(text)) {
      reply = '你可以说：我想吃巨无霸、来一份薯条、打开购物车、去结算、帮我领券、有什么优惠、清空购物车。';
      this.reply(reply); return;
    }

    // 3) 清空购物车
    if (/清空|清理|删掉.*购物车/.test(text) && /购物车/.test(text)) {
      Store.clearCart();
      reply = '购物车已清空';
      this.reply(reply); UI.toast(reply); return;
    }

    // 4) 加入购物车（优先于通用购物车导航，避免「加入购物车」被误判为查看购物车）
    if (/加入购物车|加到购物车|就要这个|加一份|加一个|加杯/.test(text)) {
      if (state.ui.detailCode && Draft.d) {
        const m = text.match(/(\d+)\s*(份|个|杯|块|件)/);
        if (m) Draft.d.qty = Math.max(1, parseInt(m[1], 10) || 1);
        const line = Draft.buildCartLine();
        Store.addToCart(line);
        Store.closeDetail();
        reply = `已加入购物车：${line.name}${line.qty > 1 ? ' ×' + line.qty : ''}`;
        this.reply(reply); UI.toast(reply, 'success');
        return;
      }
      reply = '请先说想吃什么，我打开商品详情后，再说「加入购物车」';
      this.reply(reply);
      return;
    }

    // 5) 打开购物车
    if (/购物车/.test(text) && !/清空|清理/.test(text)) {
      go('cart');
      reply = `购物车共有 ${Store.cartCount()} 件商品，预估 ${fmtMoney(Store.cartSubtotal())} 元`;
      this.reply(reply); return;
    }

    // 6) 结算
    if (/去结算|结算|结账|买单|确认下单|我要下单/.test(text)) {
      if (!state.cart.length) { reply = '购物车还是空的，先点点什么吧'; this.reply(reply); return; }
      Store.resetCheckout();
      go('checkout');
      CheckoutCtrl.enter();
      reply = '进入结算页面，正在为你准备优惠券';
      this.reply(reply); return;
    }

    // 7) 领券 / 优惠
    if (/领券|优惠|折扣|便宜/.test(text)) {
      if (!state.cart.length) { reply = '先加点商品，结算时才能用券哦'; this.reply(reply); return; }
      Store.resetCheckout();
      go('checkout');
      CheckoutCtrl.enter().then(() => {
        Store.patchCheckout({ step: 2 });
        CheckoutCtrl.claim();
      });
      reply = '正在进入结算页并自动领取优惠券';
      this.reply(reply); return;
    }

    // 8) 切换门店 / 实时定位
    if (/定位|当前位置|附近/.test(text) && /门店|麦当劳|餐厅|定位|位置/.test(text)) {
      Store.setStorePicker(true);
      this.reply('正在获取您的当前位置，请允许定位权限');
      if (window.AppActions && window.AppActions.locateStores) window.AppActions.locateStores();
      return;
    }
    if (/门店|换一家/.test(text)) {
      Store.setStorePicker(true);
      reply = '已打开门店选择，附近有 ' + Store.state.stores.length + ' 家麦当劳';
      this.reply(reply); return;
    }

    // 9) 搜索 / 点名商品（「来一份薯条」「我想吃巨无霸」等）
    const kw = text
      .replace(/^(我想吃|我想要|想吃|我要|来一份|来一个|来份|来杯|我要一份|我要一个|搜索|查找|点一份|点一个|点)/, '')
      .replace(/(谢谢|麻烦了|好吗|吧|呢)/g, '')
      .trim();
    if (kw && menu) {
      const hit = this.findProduct(kw);
      if (hit) {
        Store.openDetail(hit.code);
        reply = `找到「${hit.name}」，¥${fmtMoney(estimateUnitPrice(hit))}，请看详情并选择配料`;
        this.reply(reply);
        return;
      }
      reply = `菜单里没有找到「${kw}」，试试巨无霸、薯条、麦旋风`;
      this.reply(reply);
      return;
    }

    reply = '我没听懂，可以说「我想吃巨无霸」或「帮助」';
    this.reply(reply);
    this.startMic();
  },

  /** 在菜单中模糊查找商品 */
  findProduct(kw) {
    const menu = Store.state.menu;
    if (!menu) return null;
    const meals = Object.values(menu.meals);
    const norm = (s) => String(s || '').replace(/[\s（）()·、-]/g, '');
    const k = norm(kw);
    return meals.find((m) => norm(m.name).includes(k))
      || meals.find((m) => k.includes(norm(m.name)))
      || meals.find((m) => norm(m.name).includes(k.replace(/套餐|组合|三件套|四件套|随心配/g, '')));
  },
};
