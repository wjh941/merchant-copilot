// 店铺运营 Copilot —— agent 入口。
//
//   node agent/copilot.js --scripted <taskId|all>   脚本化模式：执行预置计划（评测/演示用，无需 LLM key）
//   node agent/copilot.js --llm "任务描述"           LLM 模式：接 OpenAI 兼容接口做真实推理
//
// 安全模式（无论哪种模式都成立）：
//   - agent 只能通过 MCP 工具读写：读自由、写必须走 propose_* → 人工审批；
//   - agent 的工具列表里根本不存在 approve —— 它无法自我生效。
'use strict';
const { banner, style, spinner, panel, kv } = require('../cli/ui');
const displayW = require('../cli/ui').displayWidth;
const { McpClient } = require('../mcp/client');

const TOOL_ICON = {
  search_products: '🔍', get_product: '🔍', list_orders: '🧾',
  get_analytics: '📊', find_stale_products: '🕸️', get_market_prices: '💹',
  get_staged_changes: '📋',
};

function toolLine(entry) {
  const icon = entry.ok === false ? style.red('✖') : (TOOL_ICON[entry.tool] || '🔧');
  const args = JSON.stringify(entry.args || {});
  return `  ${icon} ${style.cyan(entry.tool)} ${style.gray(args.length > 96 ? args.slice(0, 96) + '…' : args)}`;
}

// 终端级 markdown 渲染：粗体/标题/列表符号
const ui = require('../cli/ui');
function mdTerm(s) {
  const B = process.stderr.isTTY && !process.env.NO_COLOR;
  const b = (x) => B ? ui.c.bold + x + ui.c.reset : x;
  const lines = s.split('\n').map(l =>
    l
      .replace(/^#{1,4}\s+(.*)$/gm, (m, t) => b(t))
      .replace(/\*\*([^*]+)\*\*/g, (m, t) => b(t))
      .replace(/^\s*[-*]\s+/gm, '  · ')
  );
  // markdown 表格 → 终端对齐列
  const out = [];
  let table = [];
  const flush = () => {
    if (!table.length) return;
    const rows = table.filter(cells => !cells.every(x => /^-+$/.test(x)));
    const w = Math.max(2, ...rows.flat().map(x => x.replace(/\*\*/g, '').length + 2));
    rows.forEach((cells, ri) => {
      const line = cells.map(x => (x + ' '.repeat(w)).slice(0, w + 4)).join('');
      out.push(ri === 0 ? ui.style.bold(line) : '  ' + line);
    });
    table = [];
  };
  for (const line of lines) {
    const t = line.trim();
    if (t.startsWith('|') && t.endsWith('|')) {
      const cells = t.slice(1, -1).split('|').map(x => x.trim()).filter(x => x !== '');
      table.push(cells);
    } else { flush(); out.push(line); }
  }
  flush();
  return out.join('\n');
}

function backendLabel() {
  return process.env.BACKEND === 'medusa' ? style.violet('真店 · Medusa') : style.gray('仿真数据');
}

// ---------------- 脚本化模式 ----------------
async function runScripted(taskIds) {
  const { buildTasks } = require('../evals/tasks');
  const { computeGroundTruth } = require('../evals/ground-truth');
  const gt = computeGroundTruth();
  const tasks = buildTasks(gt).filter(t => taskIds.includes('all') || taskIds.includes(t.id));

  console.log(banner('店铺运营 Copilot', `脚本化演示 · ${tasks.length} 个任务 · ${backendLabel()}`));

  const mcp = new McpClient();
  await mcp.init();

  for (const task of tasks) {
    console.log(`\n ${style.bold(task.instruction)}`);
    const ctx = { results: {} };
    const sp = spinner(() => '执行中…');
    try {
      let steps = 0;
      for (const step of task.steps) {
        const args = typeof step.args === 'function' ? step.args(ctx) : step.args;
        const result = await mcp.callTool(step.tool, args);
        if (step.save) ctx.results[step.save] = result;
        steps++;
      }
      sp.stop('✦', `完成 · ${steps} 次工具调用`);
      const answer = task.answer(ctx);
      console.log(panel([style.white(answer)], { title: task.id, width: Math.min(80, answer.length + 12) }));
    } catch (e) {
      sp.stop('✖', '执行失败');
      console.log(style.red('  ' + e.message));
    }
  }
  mcp.stop();
  console.log('\n' + style.gray('  提案需在运营台人工批准后生效 · http://127.0.0.1:4310'));
}

// ---------------- LLM 模式（OpenAI 兼容 function calling）----------------
async function runLlm(taskText) {
  const key = process.env.LLM_API_KEY;
  if (!key) {
    console.error('缺少 LLM_API_KEY 环境变量。设置示例（智谱）：\n  export LLM_BASE_URL=https://open.bigmodel.cn/api/paas/v4\n  export LLM_API_KEY=你的key\n  export LLM_MODEL=glm-4-flash');
    process.exit(1);
  }
  const { runLlmTask } = require('./llm-agent');
  const mcp = new McpClient();
  await mcp.init();

  console.log(banner('店铺运营 Copilot', `LLM · ${process.env.LLM_MODEL || ''} · ${backendLabel()}`));
  console.log(`\n ${style.bold(taskText)}\n`);

  const t0 = Date.now();
  let sp = spinner(() => '思考中…');
  let stepCount = 0;
  let result;

  try {
    result = await runLlmTask({
      mcp, taskText,
      onStep: entry => {
        sp.stop(entry.ok === false ? '✖' : '✔', entry.ok === false ? '工具调用失败' : '已获取数据');
        console.log(toolLine(entry));
        stepCount++;
        sp = spinner(() => `推理中（第 ${stepCount + 1} 步）…`);
      },
    });
  } catch (e) {
    sp.stop('✖', '模型服务异常');
    const transient = /503|502|temporarily|fetch failed|abort/i.test(String(e.message));
    console.log('');
    console.log(panel([
      style.red(transient ? '模型服务暂时不可用（已自动重试仍失败）。' : '任务执行失败。'),
      style.gray(String(e.message).slice(0, 150)),
      '',
      style.gray('稍后重试即可；若持续失败请检查 LLM_BASE_URL / LLM_MODEL。'),
    ], { title: '出错了', color: '\x1b[31m', width: 72 }));
    mcp.stop();
    process.exit(1);
  }
  const { answer, trace, usage } = result;

  sp.stop('✦', `完成 · ${trace.length} 次工具调用 · ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  if (answer) {
    const lines = mdTerm(answer).split('\n');
    const width = Math.min(84, Math.max(44, ...lines.map(displayW)));
    console.log('\n' + panel(lines, { title: 'Copilot', width }));
  }
  console.log(style.gray(`\n  ${kv('工具调用', String(trace.length), { width: 10 })}  ${kv('Tokens', String(usage.prompt_tokens + usage.completion_tokens), { width: 10 })}  ${kv('耗时', secs + 's', { width: 10 })}`));
  console.log(style.gray('  提案需在运营台人工批准后生效 · http://127.0.0.1:4310\n'));
  mcp.stop();
}

// ---------------- 入口 ----------------
(async () => {
  const argv = process.argv.slice(2);
  if (argv[0] === '--scripted') {
    await runScripted(argv[1] === 'all' ? ['all'] : argv.slice(1));
  } else if (argv[0] === '--llm') {
    const task = argv.slice(1).join(' ');
    if (!task) { console.error('用法: node agent/copilot.js --llm "任务描述"'); process.exit(1); }
    await runLlm(task);
  } else {
    console.log(banner('店铺运营 Copilot', '带人工审批门的电商运营 agent'));
    console.log(`
  ${style.cyan('node agent/copilot.js --scripted all')}     跑全部脚本化演示任务（无需 LLM key）
  ${style.cyan('node agent/copilot.js --scripted q5 w1')}   跑指定任务
  ${style.cyan('node agent/copilot.js --llm "最近7天卖了多少钱？"')}

  ${style.gray('前提: 店铺后端已启动 · BACKEND=medusa 可切换真店数据')}`);
  }
})().catch(e => { console.error(e); process.exit(1); });
