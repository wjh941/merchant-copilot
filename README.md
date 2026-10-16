# 店铺运营 Copilot（merchant-copilot）v0.3

一个带**人工审批门**的电商运营 agent 最小可行版：agent 能查数据、能分析经营、能提案改价/补货/修数据，但**任何写操作都必须店主在运营台点批准才生效**。带确定性评测集 + 真实 LLM 评测（通过率/token 成本/双模型横评），**全套可在浏览器里实时演示**——数据在动、Copilot 在建议、审批有后果，一个页面走完。

对标 [anthropics/commerce-agents](https://github.com/anthropics/commerce-agents) 的 merchant-agent 安全模式，区别在于：Anthropic 的是虚构公司参考蓝图，本项目跑在**真实可运行的后端**上，且带一套**确定性评测集**。

**零 npm 依赖** —— 只需要 Node 18+（内置 fetch / http / child_process）。

---

## 30 秒跑起来

```bash
npm run -s seed              # 1. 生成仿真数据（36 商品 / 136 订单 + 故意注入的脏数据）
npm run -s server            # 2. 启动店铺后端（端口 4310；真店模式加前缀 MEDUSA_URL=http://127.0.0.1:9000）
```

浏览器打开 **http://127.0.0.1:4310/** —— 就是全部：

- **洞察建议（💡）**：Copilot 主动扫描经营数据生成建议卡——缺货流失🚨/售罄预测📦/滞销占压🕸️/营收异动📉/零价格🏷️/缺描述📝/同名重复👥，每张卡带量化依据和**"让 Copilot 处理"一键派活**（部分卡有免 key 预设）。**卡片在人工批准前不会消失**——数据和 UI 共守审批门
- **营业模拟**：后台每 12 秒产生新订单并**真实扣减库存**，库存不足 → 订单流失（有记录）。补货提案被批准后流失即停止——agent 的动作有真实后果，看板是活的
- **运营台首页**：KPI（带环比涨跌 + 数字滚动）、30 天营收/订单趋势图（canvas 手绘，悬停有 tooltip）、数据质量体检
- **审批队列**：agent 的提案在这里排队，点「批准生效/拒绝」，按状态筛选，一键重置演示数据
- **商品**：36 个商品浏览，搜索（支持 SKU）/类目/状态过滤，库存条与脏数据高亮
- **🤖 Copilot**：左侧 20 个预设任务一键跑（无需 API key，看实时工具调用轨迹）；配置 key 后可用自然语言派活；产生的提案一键跳去审批
- **审计**：每次提案/批准/拒绝/围栏拦截全留痕

命令行方式（可选）：

```bash
npm run -s demo                           # 脚本化演示（无需 LLM key）
npm run -s copilot -- --llm "最近7天卖了多少钱？"          # 真实 LLM 模式（见下文配置）
```

跑评测：

```bash
node evals/run-evals.js      # 20 个任务 + 确定性验证器 → evals/results.json
```

> 评测/演示会往审批队列里塞提案。重复跑之前先重置：杀掉 server → 重新 `node server/seed.js` → 重启 server。

---

## 架构

```
┌──────────────┐   MCP (stdio/JSON-RPC)   ┌──────────────────┐   HTTP    ┌──────────────────┐
│ Copilot Agent │ ───────────────────────▶ │   MCP Server      │ ────────▶ │   店铺后端         │
│ (agent/)      │   8 个工具: 5 读 + 3 提案 │   (mcp/)          │           │   (server/)       │
└──────────────┘                          └──────────────────┘           └────────┬─────────┘
                                                                                   │ 唯一写路径
                                                                          ┌────────▼─────────┐
                                                                          │ 暂存变更队列       │ ◀── 人工审批（运营台）
                                                                          │ pending→applied   │     http://127.0.0.1:4310/
                                                                          └──────────────────┘
```

- **agent ↔ MCP**：agent 是一个最小 MCP stdio 客户端（`mcp/client.js`），工具发现/调用走标准 JSON-RPC——将来把后端换成 Medusa，agent 这层一行不用改。
- **MCP ↔ 后端**：MCP server 把店铺 API 包装成 8 个工具。
- **运营台 console**（`console/index.html`，单文件）：KPI、审批队列（批准/拒绝）、数据质量体检、审计日志，5 秒自动刷新。

## 安全模式（这个项目的核心，面试可讲）

| 模式 | 实现 | 在哪验证 |
|---|---|---|
| **围栏 fencing** | 商品/订单**没有**直接写接口，`PUT /admin/products/:id` 返回 403 | `curl -X PUT .../admin/products/prod_001` |
| **暂存变更 staged changes** | 所有写操作 = `POST /admin/staged-changes`，只产生 pending 记录 | 跑 `npm run demo` 看输出 |
| **人工审批门** | 生效只有一个出口：`approve` 接口；**MCP 工具列表里根本没有 approve** —— agent 在协议层无法自我生效 | 运营台点批准 |
| **限额** | 待审批 >10 条拒绝新提案；提案限流 20 次/分钟 | 连续跑两遍 demo 不重置 |
| **审计** | 每次 propose/approve/reject/fence_blocked 落审计日志 | 运营台「审计日志」面板 |
| **参数校验** | variant 不存在、价格非正数等在提案入口拒绝 | `verify` 断言 |

## 评测（evals/）

20 个运营任务：8 查询 + 6 分析 + 6 写提案，每个任务配**确定性验证器**（订单真的查对了吗、价格提案参数对不对），ground truth 从原始数据独立计算（不经过 server 的分析接口，避免循环验证）。

两种模式：

- **脚本化基线**（`npm run eval`）：预置工具调用计划，验证工具层与验证器本身 → `results.json`
- **LLM 模式**（`npm run eval -- --llm`）：真实模型推理完成同样的任务，验证器消费 agent 的**真实工具调用轨迹**（过程接地：查对工具用对了没、拿到的数对不对、提案参数对不对，而非匹配最终文案）；结果文件按模型命名（如 `results-llm-glm-5.3-flash.json`），支持 `--runs N` 多轮取均值

**23 个任务 = 8 查询 + 6 分析 + 6 写提案 + 3 长程**。长程任务是"扫描 → 批量提案"的多步链路（全量修零价格 / 全量补描述 / 滞销品 8 折清仓），其中 x3 专门埋了脏数据陷阱——滞销品里必然混着 0 元商品，盲目打 8 折会生成 0 元提案被校验拒绝，**考察 agent 会不会跳过脏数据**。

**双模型横评**（2026-10-16，各 2 轮 × 23 任务，过程接地验证）：

| 模型 | 2轮均值 | 单轮 | 平均工具调用/任务 | 平均 tokens/任务 |
|---|---|---|---|---|
| `glm-5.3-flash` | **97.8% ± 4.3** | 95.7% / 100% | 2.3 | 4,783 |
| `gpt-6-astra`（代理底层 gpt-5.6-sol） | 74.0% ± 43.5* | 52.2% / 95.7% | 2.2 | 4,501 |

\* astra 的低均值**不是模型能力问题**：供应商通道大面积 503（连 3 次退避重试都扛不住的持续不可用），52.2% 那轮 12 个失败全是基建错误；供应商可用时它同样跑出 95.7%（唯一失败仍是 503）。**方法论教训**：评测基建必须把「供应商可用性」和「模型能力」解耦——失败分类（infra vs capability）已列入 roadmap。同时验证了另一件事：**6 个写提案任务在两个模型上全部通过且全部正确停在 pending**——安全模式是架构保证，不依赖模型自觉。

历史备注：v0.2 首轮评测曾暴露 search_products 不索引 SKU 的缺口（模型 9 步未收敛而失败），v0.3 已修。这正是评测的价值：让系统的薄弱点自己浮出来。

LLM 评测复现：

```bash
export LLM_BASE_URL=https://open.bigmodel.cn/api/paas/v4   # 任意 OpenAI 兼容接口
export LLM_API_KEY=你的key
export LLM_MODEL=glm-4-flash
npm run -s eval -- --llm --runs 3    # 3 轮取均值；每轮自动关模拟+重置+放宽限额
```

写任务的验证器专门断言两件事：① 提案参数正确且状态 pending；② **store.json 里对应字段原封不动** —— 即"agent 提了案但动不了真实数据"是评测的一部分，不是口头承诺。

## LLM 模式配置

任何 OpenAI 兼容接口均可（默认按智谱配置）：

```bash
export LLM_BASE_URL=https://open.bigmodel.cn/api/paas/v4
export LLM_API_KEY=你的key
export LLM_MODEL=glm-4-flash
node agent/copilot.js --llm "把缺描述的商品都补上描述文案，逐个提案"
```

## 目录结构

```
merchant-copilot/
├── server/store-server.js   店铺后端：只读查询 + 暂存变更 + 审批 + 围栏 + 审计
│                            + 趋势接口 + /admin/reset + /agent/run（浏览器跑 agent）
├── server/seed-data.js      数据生成逻辑（seed CLI 与 reset 共用）
├── server/seed.js           CLI：生成确定性仿真数据，注入真实世界脏数据
├── mcp/mcp-server.js        MCP server（stdio, JSON-RPC 2.0），8 个工具（搜索含 SKU）
├── mcp/client.js            最小 MCP stdio 客户端
├── agent/copilot.js         agent 入口：--scripted（脚本化） / --llm（真实推理）
├── agent/llm-agent.js       共享 LLM agent 循环（trace + token 记账 + onStep），CLI/评测/浏览器共用
├── evals/ground-truth.js    独立 ground truth（直接算原始数据）
├── evals/tasks.js           20 任务定义 + 确定性验证器 + 轨迹 capture
├── evals/run-evals.js       评测 runner（--llm / --runs N）→ results.json / results-llm.json
├── evals/debug-task.js      单任务调试工具（node evals/debug-task.js w1）
├── console/index.html       运营台 v0.3：KPI 动效/趋势图/审批队列/商品浏览/Copilot 面板/审计
└── data/store.json          数据文件（seed 生成，审批生效时落盘）
```

## 已知的 v0.3 局限（诚实声明）

- 后端是**自建的 Medusa 风格域模型**（product/variant/order），不是真 Medusa——v0.4 换成 `create-medusa-app` 真店，MCP 工具层语义保持不变；
- 暂存变更队列在 server 内存里（重启即清空），只有**已批准生效**的变更落盘；
- 20 个任务覆盖面仍窄（对比 CommerceAgentBench 的 107 个长程任务），且都是单步/少步任务，还没有多步依赖的长程任务；
- 运营台是单文件应用，轮询（4s）而非 SSE 推送——演示足够，生产级实时性还差一步；
- 洞察引擎目前是规则引擎（阈值+排序），不是模型驱动的分析——让它变成"LLM 洞察+规则兜底"是 v0.5 候选项。

## Roadmap

- **v0.4（进行中）**：换真 Medusa v2 后端 —— 基础设施已就绪（本地 PostgreSQL 18 + Medusa 2.21 已跑通 `db:migrate` / 管理员认证 / Admin API 建品读写），下一步：MCP 工具层加 `BACKEND=medusa` 适配器、审批门生效动作落到 Medusa API
- **v0.5**：评测强化——失败分类（infra vs capability，双模型横评中 503 污染数据的教训）、多步长程任务扩展
- **v0.6**：售后客服场景（RAG 挂订单+政策、退款类操作强制人工、转人工）——复用同一套审批门
- **v0.7**：只读演示 ACP agentic checkout 流程（对齐协议层，面试谈资）

## Medusa 集成进展（v0.4）

**核心闭环已打通并实测**：agent 通过 MCP 读真店铺数据 → 提案 → 店主在审批队列点批准 → **变更真实执行到 Medusa**（审计记录 `backend: "medusa"`），再用 Medusa API 独立复核生效。

架构：

```
Copilot Agent ──MCP──▶ 工具层(BACKEND=medusa: 读真店) ──propose──▶ 审批网关(:4310)
                                                                    │ 店主批准
                                                                    ▼
                                                            medusa.js 适配器 ──Admin API──▶ 真 Medusa 店铺(:9000)
```

- **真店数据**：9 个商品 / 16 个变体 / 15 笔真实订单（时间分布回填，趋势图有形）已灌入（`medusa-seed.js` + `medusa-orders-seed.js`，含 CNY region、双币价格、销售渠道↔库存位置关联）
- **运营台直接显示真店数据**：以 `MEDUSA_URL` 启动网关后，看板 KPI / 趋势图 / 数据体检 / 洞察建议全部来自真实 Medusa（响应带 `backend: "medusa"`），营业模拟自动停用；不设该变量则整套看板跑仿真数据
- **真数据实测**：medusa 模式下 30 天营收 ¥7,873 / 15 单 / AOV ¥524.87、热卖榜、滞销清单、低库存全部来自真实 Medusa 数据；真实 LLM 巡检任务轨迹见 `data/medusa-llm-demo.log`
- **执行桥**：`MEDUSA_URL=... node server/store-server.js` 启动后，批准的动作（改价/改标题/补货）调用 Medusa Admin API 真实生效；执行失败变更保持 pending 可重试；不设该变量则执行到本地仿真（评测默认，保证确定性）
- **读切换**：`BACKEND=medusa node agent/copilot.js --llm "..."` 时，agent 的搜索/详情/订单/分析/滞销工具全部吃真店数据
- **冒烟测试**：`node evals/medusa-smoke.js` —— 9 项断言覆盖「读真店 → 提案 → 批准 → Medusa 独立复核 → 审计留痕」，全绿
- **竞品价格监测（v0.4.3）**：`💹 竞品价格` Tab + `get_market_prices` MCP 工具。每商品对比 3 家竞店的 30 天价格带（区间条+本店价标记+多线走势图），建议引擎按「价格位置 × 销量趋势 × 弹性 1.5」生成改价建议并测算预期销量/营收影响——且与弹性模型自洽（提价只在需求上行时建议；低价+需求平淡 → 诚实建议"先做流量再议价"）。一键"按建议生成提案"仍走审批门。数据源为适配器架构：内置仿真监测器（确定性随机游走），真实比价数据源经 `recordObservation` 接入
- 已验证的写路径：改价（prices 全量替换，双币）、补货（inventory-items → location-levels，需先建 stock location 并与销售渠道互链）、改标题/描述
- 踩坑：建单报 "sales channel not associated with stock location" 时，除了渠道↔位置关联，还要检查**该变体在位置上是否有库存记录**（预留库存失败会报这个误导性错误）；草稿单转正式用 `/admin/draft-orders/:id/convert-to-order`

环境搭建踩坑记录（v2.21 实测）：新版 npm allow-scripts 拦截 esbuild postinstall（`npm approve-scripts esbuild`）；medusa-config.ts 必须配 jwtSecret/cookieSecret；tsconfig 用官方 starter 的 `module: Node16` + `ts-node.swc`（需 ts-node/@swc/core/@swc-node/register）；admin 面板 build 产物目录与 `medusa start` 不兼容（本项目用自建运营台代替，config 里 `admin.disable: true`）。
