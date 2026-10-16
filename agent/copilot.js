// 店铺运营 Copilot —— agent 入口。
//
// 两种模式：
//   node agent/copilot.js --scripted <taskId|all>   脚本化模式：执行预置计划（评测/演示用，无需 LLM key）
//   node agent/copilot.js --llm "任务描述"           LLM 模式：接 OpenAI 兼容接口做真实推理
//
// 安全模式（无论哪种模式都成立）：
//   - agent 只能通过 MCP 工具读写：读自由、写必须走 propose_* → 人工审批；
//   - agent 的工具列表里根本不存在 approve —— 它无法自我生效。
'use strict';
const { McpClient } = require('../mcp/client');

// ---------------- 脚本化模式 ----------------
async function runScripted(taskIds) {
  const { buildTasks } = require('../evals/tasks');
  const { computeGroundTruth } = require('../evals/ground-truth');
  const gt = computeGroundTruth();
  const tasks = buildTasks(gt).filter(t => taskIds.includes('all') || taskIds.includes(t.id));

  const mcp = new McpClient();
  await mcp.init();

  for (const task of tasks) {
    console.log(`\n━━━ 任务 ${task.id}（${task.type}）: ${task.instruction}`);
    const ctx = { results: {} };
    try {
      for (const step of task.steps) {
        const args = typeof step.args === 'function' ? step.args(ctx) : step.args;
        const result = await mcp.callTool(step.tool, args);
        if (step.save) ctx.results[step.save] = result;
        console.log(`  🔧 ${step.tool}(${JSON.stringify(args).slice(0, 120)})`);
      }
      const answer = task.answer(ctx);
      console.log(`  ✅ ${answer}`);
    } catch (e) {
      console.log(`  ❌ 执行失败: ${e.message}`);
    }
  }
  mcp.stop();
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
  const t0 = Date.now();
  const { answer, trace, usage } = await runLlmTask({ mcp, taskText });
  for (const t of trace) {
    console.log(`  🔧 ${t.tool}(${JSON.stringify(t.args).slice(0, 140)})${t.ok ? '' : ' -> ' + t.error}`);
  }
  console.log(`\n🤖 ${answer}`);
  console.log(`\n[${trace.length} 次工具调用 · ${usage.prompt_tokens + usage.completion_tokens} tokens · ${((Date.now() - t0) / 1000).toFixed(1)}s]`);
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
    console.log(`店铺运营 Copilot v0.1
用法:
  node agent/copilot.js --scripted all     跑全部脚本化演示任务（无需 LLM key）
  node agent/copilot.js --scripted q5 w1   跑指定任务
  node agent/copilot.js --llm "最近7天卖了多少钱？"

前提: 店铺后端已启动 (npm run server)`);
  }
})().catch(e => { console.error(e); process.exit(1); });
