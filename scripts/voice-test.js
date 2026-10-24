/* 语音麦克风诊断回归测试：验证 not-allowed 的精确归因与跨平台恢复路径。
 * 覆盖：正常启动 / 权限已拒预检 / Permissions API 不支持不误报 / iframe 嵌入 / App 内置 WebView /
 *      非安全上下文 / audio-capture / service-not-allowed / no-speech / aborted 静默 / 重试按钮恢复。
 * 用法：node scripts/voice-test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('C:/Users/86181/.workbuddy/binaries/node/workspace/node_modules/jsdom');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8')
  .replace(/<script src="[^"]*"><\/script>/g, '');

const results = [];
function check(name, cond, extra = '') {
  results.push({ name, pass: !!cond, extra });
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? '  → ' + extra : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 伪造 SpeechRecognition：记录 start 次数，可手动触发 onerror */
const SRInstances = [];
class FakeSR {
  constructor() {
    this.lang = ''; this.interimResults = false; this.continuous = false;
    this.onresult = null; this.onerror = null; this.onend = null;
    this.started = false; this.startCount = 0;
    SRInstances.push(this);
  }
  start() {
    if (this.started) throw new Error('InvalidStateError');
    this.started = true; this.startCount++;
  }
  stop() { this.started = false; }
}
const lastSR = () => SRInstances[SRInstances.length - 1];

(async () => {
  const dom = new JSDOM(html, { url: 'http://localhost:3210/', runScripts: 'dangerously', pretendToBeVisual: true });
  const { window } = dom;
  const { document } = window;
  window.speechSynthesis = { cancel() {}, speak() {} };
  window.SpeechRecognition = FakeSR; // 必须在 eval 前注入，Voice.supported 才为 true

  // 可切换的权限模拟：null = API 不存在；{ throws } = query 抛错；否则返回 { state }
  let permState = 'granted';
  let permThrows = false;
  let permDefined = true;
  Object.defineProperty(window.navigator, 'permissions', {
    configurable: true,
    get() {
      if (!permDefined) return undefined;
      if (permThrows) return { query: async () => { throw new TypeError('unsupported name'); } };
      return { query: async () => ({ state: permState, onchange: null }) };
    },
  });

  const bundle = ['config.js', 'voice.js'].map((f) => fs.readFileSync(path.join(ROOT, 'public/js', f), 'utf8')).join('\n;\n')
    + '\n;window.__voice = { Voice };';
  window.eval(bundle);
  const Voice = window.__voice.Voice;

  Voice.init();
  const openOverlay = async () => { Voice.open(); await sleep(30); };

  const status = () => document.querySelector('#voice-status').textContent;
  const fixRow = () => document.querySelector('#voice-mic-fix');
  const extLink = () => document.querySelector('#voice-open-external');

  /* 1. 正常路径：安全上下文 + 顶层页面 + 权限已授予 → 直接启动识别 */
  Voice._envOverrides = { secure: true, iframe: false, webview: false };
  permState = 'granted'; permThrows = false; permDefined = true;
  await openOverlay();
  check('正常路径：识别已启动', lastSR().startCount === 1, 'start=' + lastSR().startCount);
  check('正常路径：不显示诊断行', fixRow().hidden === true, '');
  check('正常路径：状态为聆听提示', /聆听/.test(status()), status());

  /* 2. 权限预检：query 返回 denied → 不启动，给出设置引导 + 重试 */
  Voice.close();
  permState = 'denied';
  await openOverlay();
  check('权限已拒：不启动识别', lastSR().startCount === 1, 'start=' + lastSR().startCount);
  check('权限已拒：诊断行可见（含重试）', fixRow().hidden === false && !document.querySelector('#voice-retry-btn').hidden, '');
  check('权限已拒：文案含地址栏引导', /地址栏/.test(status()) && /允许麦克风/.test(status()), status());
  check('权限已拒：不显示「在新标签页打开」', extLink().hidden === true, '');

  /* 3. 重试按钮：权限改为允许后点「重试」→ 成功启动 */
  permState = 'granted';
  document.querySelector('#voice-retry-btn').click();
  await sleep(30);
  check('重试按钮：权限恢复后成功启动', lastSR().startCount === 2 && fixRow().hidden === true, 'start=' + lastSR().startCount);

  /* 4. Permissions API 不支持（Safari/Firefox）→ 静默跳过直接尝试，绝不误报「已拒绝」 */
  Voice.close();
  permDefined = false;
  await openOverlay();
  check('不支持 Permissions API：仍启动识别（不误报）', lastSR().startCount === 3, 'start=' + lastSR().startCount);
  check('不支持 Permissions API：无权限拒绝文案', !/权限被拒绝/.test(status()), status());

  /* 5. query 抛 TypeError（部分浏览器对 microphone 名不支持）→ 同样不误报 */
  Voice.close();
  permDefined = true; permThrows = true;
  await openOverlay();
  check('query 抛错：仍启动识别（不误报）', lastSR().startCount === 4, 'start=' + lastSR().startCount);

  /* 6. iframe 嵌入（预览面板）→ 指引「在新标签页打开」并提供链接 */
  Voice.close();
  permThrows = false; permState = 'granted';
  Voice._envOverrides = { secure: true, iframe: true, webview: false };
  await openOverlay();
  check('iframe 嵌入：不启动识别', lastSR().startCount === 4, 'start=' + lastSR().startCount);
  check('iframe 嵌入：文案指明嵌入限制', /嵌入/.test(status()), status());
  check('iframe 嵌入：显示「在新标签页打开」链接', extLink().hidden === false && /^https?:/.test(extLink().href), extLink().href);

  /* 7. App 内置 WebView（微信/QQ）→ 引导用系统浏览器打开 */
  Voice.close();
  Voice._envOverrides = { secure: true, iframe: false, webview: true };
  await openOverlay();
  check('App 内置 WebView：引导系统浏览器', /系统浏览器/.test(status()), status());
  check('App 内置 WebView：不启动识别', lastSR().startCount === 4, '');

  /* 8. 非安全上下文（http 非 localhost）→ HTTPS 提示 */
  Voice.close();
  Voice._envOverrides = { secure: false, iframe: false, webview: false };
  await openOverlay();
  check('非安全上下文：HTTPS 提示', /HTTPS/.test(status()), status());

  /* 9. 运行中错误精确归因 */
  Voice._envOverrides = { secure: true, iframe: false, webview: false };
  Voice.close();
  await openOverlay(); // 正常启动一次
  lastSR().onerror({ error: 'audio-capture' });
  check('audio-capture：提示未检测到麦克风', /未检测到麦克风/.test(status()), status());
  check('audio-capture：诊断行可见', fixRow().hidden === false, '');

  lastSR().onerror({ error: 'service-not-allowed' });
  check('service-not-allowed：提示语音服务被禁用', /语音服务/.test(status()), status());

  lastSR().onerror({ error: 'no-speech' });
  check('no-speech：轻提示可重试', /没有听到声音/.test(status()), '');

  const beforeAbort = status();
  lastSR().onerror({ error: 'aborted' });
  check('aborted：静默不打扰', status() === beforeAbort, '');

  /* 10. 诊断行在正常打开时被清空 */
  Voice.close();
  await openOverlay();
  check('重新打开：诊断行已隐藏', fixRow().hidden === true, '');

  Voice.close();
  window.close();

  const pass = results.filter((r) => r.pass).length;
  console.log(`\n========== 语音麦克风诊断测试：${pass}/${results.length} 通过 ==========`);
  if (pass !== results.length) {
    console.log('失败项：' + results.filter((r) => !r.pass).map((r) => r.name).join(' | '));
    process.exitCode = 1;
  }
  process.exit(process.exitCode || 0);
})().catch((e) => { console.error('测试异常：', e); process.exit(1); });
