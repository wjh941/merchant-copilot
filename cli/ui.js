// 零依赖 CLI 美学层 —— 借鉴 clack（框线面板）/ ora（盲文旋转器）/ chalk（ANSI 颜色）。
// 尊重 NO_COLOR 与非 TTY 环境（管道/CI 时自动降级为纯文本，评测日志不受污染）。
'use strict';

const isTTY = process.stderr.isTTY && !process.env.NO_COLOR;
const code = (n) => isTTY ? `\x1b[${n}m` : '';

const c = {
  reset: code(0), bold: code(1), dim: code(2),
  red: code(31), green: code(32), amber: code(33),
  cyan: code(36), violet: code(35), gray: code(90),
  white: code(97),
};
const paint = (open) => (s) => open + s + c.reset;

const style = {
  bold: paint(c.bold), dim: paint(c.dim), gray: paint(c.gray),
  red: paint(c.red), green: paint(c.green), amber: paint(c.amber),
  cyan: paint(c.cyan), violet: paint(c.violet), white: paint(c.white),
};

// ---------- 旋转器（ora 风格盲文帧，写 stderr 不污染 stdout）----------
const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

function spinner(text) {
  if (!isTTY) {
    // 非 TTY：不输出动画，静默直到 stop
    return { stop(symbol = '✔', final) { if (final) process.stderr.write(`${pale(symbol)} ${final}\n`); }, update() {} };
  }
  let frame = 0;
  const render = () => {
    process.stderr.write(`\r${c.cyan}${FRAMES[frame]}${c.reset} ${text()}`);
  };
  render();
  const timer = setInterval(() => { frame = (frame + 1) % FRAMES.length; render(); }, 80);
  return {
    stop(symbol = '✔', final) {
      clearInterval(timer);
      const pad = ' '.repeat(Math.max(0, 40 - text().length));
      process.stderr.write(`\r${colorSymbol(symbol)} ${final || text()}${pad}\n`);
    },
    update(t) { text = () => t; },
  };
}

function colorSymbol(s) {
  if (s === '✔' || s === '✦') return c.green + s + c.reset;
  if (s === '✖') return c.red + s + c.reset;
  if (s === '◆') return c.cyan + s + c.reset;
  return s;
}
const pale = (s) => isTTY ? c.gray + s + c.reset : s;

// ---------- 框线面板（clack 风格）----------
function displayWidth(s) {
  // CJK/全角按 2 列计
  let w = 0;
  const plain = String(s).replace(/\x1b\[\d+m/g, '');
  for (const ch of plain) w += ch.charCodeAt(0) > 0x2e7f ? 2 : 1;
  return w;
}

// 按显示宽度硬折行（CJK 感知，ANSI 码不参与计宽但会保留在行内）
function wrapLine(s, width) {
  const out = [];
  let cur = '', w = 0;
  let i = 0;
  while (i < s.length) {
    const m = /^\x1b\[\d+m/.exec(s.slice(i));
    if (m) { cur += m[0]; i += m[0].length; continue; }
    const ch = s[i];
    const cw = ch.charCodeAt(0) > 0x2e7f ? 2 : 1;
    if (w + cw > width) { out.push(cur); cur = ''; w = 0; }
    cur += ch; w += cw; i++;
  }
  out.push(cur);
  return out;
}

function panel(lines, { title, color = c.cyan, width = 72 } = {}) {
  const wrapped = lines.flatMap(l => wrapLine(l, width - 4));
  const top = color + '╭─' + (title ? ` ${title} ` : '') + '─'.repeat(Math.max(2, width - displayWidth(title || '') - 3)) + '╮' + c.reset;
  const bottom = color + '╰' + '─'.repeat(width) + '╯' + c.reset;
  const body = wrapped.map(l => color + '│' + c.reset + ' ' + l + ' '.repeat(Math.max(0, width - 4 - displayWidth(l))) + ' ' + color + '│' + c.reset);
  return [top, ...body, bottom].join('\n');
}

// ---------- 标题横幅 ----------
function banner(title, subtitle) {
  const line = '─'.repeat(56);
  const out = [];
  out.push(c.violet + '  ◆ ' + c.reset + style.bold(title));
  if (subtitle) out.push('  ' + style.gray(subtitle));
  out.push('  ' + pale(line));
  return out.join('\n');
}

// ---------- 键值行 ----------
function kv(key, value, { width = 16 } = {}) {
  const plain = (s) => String(s).replace(/\x1b\[\d+m/g, '').length;
  return '  ' + style.gray((key + ' ').padEnd(width, '·') + ' ') + value;
}

// ---------- 进度条 ----------
function bar(pct, width = 20) {
  const filled = Math.round(Math.max(0, Math.min(1, pct)) * width);
  return c.cyan + '█'.repeat(filled) + c.reset + pale('░'.repeat(width - filled));
}

module.exports = { c, style, spinner, panel, banner, kv, bar, pale, colorSymbol, displayWidth };
