// 临时调试脚本：单独跑一个 LLM 任务，打印完整轨迹和堆栈
'use strict';
const { McpClient } = require('../mcp/client');
const { runLlmTask } = require('../agent/llm-agent');
const { buildTasks } = require('./tasks');
const { computeGroundTruth } = require('./ground-truth');

(async () => {
  const taskId = process.argv[2] || 'w1';
  const gt = computeGroundTruth();
  const task = buildTasks(gt).find(t => t.id === taskId);
  const mcp = new McpClient();
  await mcp.init();
  try {
    const r = await runLlmTask({ mcp, taskText: task.instruction });
    console.log('answer:', (r.answer || '').slice(0, 200));
    console.log('usage:', JSON.stringify(r.usage));
    for (const t of r.trace) {
      console.log(' tool:', t.tool, 'ok=' + t.ok, t.error ? ('ERR=' + t.error) : '');
      console.log('   args:', JSON.stringify(t.args).slice(0, 200));
      if (t.ok) console.log('   result:', JSON.stringify(t.result).slice(0, 200));
    }
    const patch = task.capture(r.trace);
    console.log('capture:', JSON.stringify(patch, null, 1).slice(0, 500));
    console.log('verify:', JSON.stringify(task.verify({ results: patch })));
  } catch (e) {
    console.error('STACK:', e.stack);
  }
  mcp.stop();
})();
