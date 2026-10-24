/* 全局常量与工具函数 */
'use strict';

const CONFIG = {
  LS_CART: 'mcd_cart_v1',
  LS_ORDERS: 'mcd_orders_v1',
  LS_STORE: 'mcd_store_v1',
  BREAKFAST_END: '10:30',
  CURRENCY: '¥',
};

/**
 * 应用部署基础路径：'' 表示根域名托管；'/repo' 表示子路径托管
 * （如 GitHub Pages 的 https://user.github.io/repo/）。
 * 由当前文档目录推导，hash 路由不参与解析，故两种托管下均正确。
 */
const BASE_PATH = (() => {
  try { return new URL('.', window.location.href).pathname.replace(/\/$/, ''); } catch (_) { return ''; }
})();

/** 内部资源 URL：p 形如 '/api/stores' 或 '/api/status' */
function appUrl(p) {
  return BASE_PATH + p;
}

/** 金额（元）格式化 */
function fmtMoney(v) {
  const n = Number(v) || 0;
  return n % 1 === 0 ? String(n) : n.toFixed(2).replace(/0$/, '');
}

/** 分 → 元 */
function fenToYuan(fen) {
  return (Number(fen) || 0) / 100;
}

/** 元 → 分 */
function yuanToFen(yuan) {
  return Math.round((Number(yuan) || 0) * 100);
}

/** HTML 转义 */
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/** 简单选择器 */
const $ = (sel, root) => (root || document).querySelector(sel);
const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

/** 判断当前是否早餐时段（本地时间 10:30 前） */
function isBreakfastTime() {
  const now = new Date();
  const mins = now.getHours() * 60 + now.getMinutes();
  const [h, m] = CONFIG.BREAKFAST_END.split(':').map(Number);
  return mins < h * 60 + m;
}

/** 睡眠 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 字符串 → 稳定散列角度（0-359），用于雷达图上确定性地摆放标记 */
function hashAngle(str) {
  let h = 0;
  const s = String(str || '');
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 1000003;
  return h % 360;
}

/** 防抖 */
function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

/**
 * 对话框键盘辅助：Esc 关闭 + Tab 焦点圈定（焦点循环留在容器内）。
 * 返回解绑函数——调用方负责在关闭时解绑，避免监听器累积。
 * @param {Element} container 对话框容器（模态遮罩或浮层根节点）
 * @param {() => void} onClose Esc 按下时的关闭回调
 */
function dialogKeys(container, onClose) {
  const SEL = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  const handler = (e) => {
    if (e.key === 'Escape') { onClose(); return; }
    if (e.key !== 'Tab') return;
    const items = Array.from(container.querySelectorAll(SEL)).filter((el) => !el.hidden && !el.closest('[hidden]'));
    if (!items.length) { e.preventDefault(); return; }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || !container.contains(active))) {
      e.preventDefault(); last.focus();
    } else if (!e.shiftKey && (active === last || !container.contains(active))) {
      e.preventDefault(); first.focus();
    }
  };
  document.addEventListener('keydown', handler);
  return () => document.removeEventListener('keydown', handler);
}
