// 共享的 LLM agent 循环：给一条自然语言任务 + MCP 工具集，跑完整的
// 「推理 → 工具调用 → 观察」循环，记录轨迹和 token 用量。
// copilot CLI（--llm）和评测 runner（--llm）共用这一份实现。
'use strict';

const DEFAULT_SYSTEM_PROMPT = [
  '你是这家服装店铺的运营 Copilot。规则：',
  '1. 只用给出的工具完成任务，不要编造数据。',
  '2. 任何修改（价格/标题/描述/库存）都必须通过 propose_* 工具提交，它们只会产生"暂存变更"，店主会在运营台人工审批。',
  '3. 回答经营问题时给出具体数字；提交提案时说明理由。',
  '4. 用中文简洁回答。拿到足够信息后立即给出最终答案，不要反复查询。',
].join('\n');

/**
 * 跑一个任务的 agent 循环。
 * @param {object} opts
 *   mcp      已 init 的 McpClient
 *   taskText 自然语言任务
 *   maxSteps 最大 LLM 轮数（默认 10）
 * @returns {answer, trace, usage} answer=最终文本；trace=[{tool,args,ok,result|error}]；usage={calls,prompt_tokens,completion_tokens}
 */
async function runLlmTask(opts) {
  const base = opts.baseUrl || process.env.LLM_BASE_URL || 'https://open.bigmodel.cn/api/paas/v4';
  const key = opts.apiKey || process.env.LLM_API_KEY;
  const model = opts.model || process.env.LLM_MODEL || 'glm-4-flash';
  const maxSteps = opts.maxSteps || 10;
  const mcp = opts.mcp;

  if (!key) throw new Error('缺少 LLM_API_KEY 环境变量');
  const tools = mcp.tools || (await mcp.init());
  const openaiTools = tools.map(t => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.inputSchema },
  }));

  const messages = [
    { role: 'system', content: opts.systemPrompt || DEFAULT_SYSTEM_PROMPT },
    { role: 'user', content: opts.taskText },
  ];
  const trace = [];
  const usage = { calls: 0, prompt_tokens: 0, completion_tokens: 0 };
  let answer = null;

  for (let i = 0; i < maxSteps; i++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 90000);
    let res;
    try {
      res = await fetch(base.replace(/\/$/, '') + '/chat/completions', {
        method: 'POST',
        signal: ctrl.signal,
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
        body: JSON.stringify({ model, messages, tools: openaiTools, temperature: 0.1 }),
      });
    } finally { clearTimeout(timer); }

    if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    const msg = data.choices[0].message;
    if (data.usage) {
      usage.prompt_tokens += data.usage.prompt_tokens || 0;
      usage.completion_tokens += data.usage.completion_tokens || 0;
    }
    messages.push(msg);

    if (!msg.tool_calls || !msg.tool_calls.length) {
      answer = msg.content || '';
      break;
    }
    for (const tc of msg.tool_calls) {
      let args = {};
      try { args = JSON.parse(tc.function.arguments || '{}'); }
      catch { messages.push({ role: 'tool', tool_call_id: tc.id, content: '参数不是合法 JSON，请重试' }); continue; }
      let entry = { tool: tc.function.name, args, ok: false };
      try {
        const result = await mcp.callTool(tc.function.name, args);
        entry.ok = true; entry.result = result;
        messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result).slice(0, 30000) });
      } catch (e) {
        entry.error = String(e.message || e);
        messages.push({ role: 'tool', tool_call_id: tc.id, content: '工具执行失败: ' + entry.error });
      }
      trace.push(entry);
      usage.calls++;
      if (opts.onStep) { try { opts.onStep(entry); } catch {} }
    }
  }

  if (answer === null) answer = '（达到最大步数仍未给出最终答案）';
  return { answer, trace, usage };
}

module.exports = { runLlmTask, DEFAULT_SYSTEM_PROMPT };
