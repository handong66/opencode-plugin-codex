# OpenCode for Codex 插件开发文档

本文档记录 `opencode-plugin-codex` 的目标、已验证事实、系统设计、实现计划和验收标准。它基于当前已经完成的本机验证工作编写，目标是把“能不能做”推进到“如何稳定做出来”。

## 1. 项目目标

本项目要做的是一个 Codex 插件，让用户可以在 Codex 中调用 OpenCode。它参考的反向项目是 [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc)：该项目让用户在 Claude Code 中调用 Codex；本项目要让用户在 Codex 中调用 OpenCode。

目标不是简单封装一条 `opencode run` 命令，而是尽量复刻 `codex-plugin-cc` 的工作流能力：

- 在 Codex 内检查和初始化 OpenCode 环境。
- 从 Codex 启动一次 OpenCode 任务。
- 继续、查看、取消 OpenCode 后台任务。
- 让 OpenCode 做 rescue、review、adversarial review。
- 把当前 Codex thread 迁移为 OpenCode session，并让 OpenCode 继续工作。
- 在能力不完整或环境不满足时给出明确诊断，而不是静默失败。

## 2. 当前结论

结论：这个插件可以做，`transfer` 也可以做成第一等功能。

已经验证的关键点：

| 能力 | 结论 | 说明 |
| --- | --- | --- |
| OpenCode CLI 是否可用 | 可用 | 当前机器安装的 OpenCode CLI 版本为 `1.17.11`。 |
| OpenCode 是否支持导入 session | 支持 | `opencode import <file>` 可以导入 JSON session。 |
| OpenCode 是否支持导出 session | 支持 | `opencode export [sessionID]` 可以导出 session，且支持 `--sanitize`。 |
| OpenCode 是否支持继续指定 session | 支持 | `opencode run --session <sessionID>` 可以继续导入后的 session。 |
| Codex 是否能拿到当前 thread 内容 | 可行 | 当前 Codex Desktop 运行环境暴露 `CODEX_THREAD_ID`，本机 JSONL rollout 文件可解析出 visible user/assistant transcript。 |
| Codex transcript 能否转换为 OpenCode session | 已验证 | 已将当前 Codex JSONL 转成 OpenCode session JSON 并成功 `opencode import`。 |
| 导入后的 OpenCode session 能否继续运行 | 已验证 | 对导入 session 执行 `opencode run --session ... --format json` 成功返回预期文本。 |
| 是否能完全复刻 `codex-plugin-cc transfer` | 可以接近完整复刻 | Codex 端 transcript 访问已经有可用路径；仍需把解析器、隐私过滤和错误处理产品化。 |

需要注意：当前非交互 shell 中 `opencode` 不在 `PATH`，但二进制存在于 `~/.opencode/bin/opencode`。插件实现不能假设 `opencode` 一定能被 `spawn("opencode")` 找到，必须做 CLI 路径探测。

## 3. 已验证环境

当前本机验证快照：

| 项 | 值 |
| --- | --- |
| 仓库 | `https://github.com/handong66/opencode-plugin-codex.git` |
| 本地仓库状态 | 创建完成，当前工作区在写本文档前为空壳仓库 |
| Codex CLI | `codex-cli 0.130.0` |
| OpenCode CLI | `1.17.11` |
| OpenCode 可执行文件 | `~/.opencode/bin/opencode` |
| OpenCode CLI PATH 状态 | 当前非交互 shell 中 `opencode` 未进入 `PATH` |
| OpenCode provider | 已配置 `AIHubMix api` |
| 本机可用模型验证 | `provider/model-authorized-for-this-user` 成功 |
| 本机不可用模型验证 | `deepseek-v4-pro`、`deep-deepseek-v4-pro`、`coding-glm-5.1-free` 因 provider 授权失败 |

验证过的 OpenCode CLI 命令：

```bash
~/.opencode/bin/opencode --version
~/.opencode/bin/opencode --help
~/.opencode/bin/opencode import --help
~/.opencode/bin/opencode export --help
~/.opencode/bin/opencode run --help
```

关键 CLI 能力：

```bash
opencode import <file>
opencode export [sessionID] --sanitize
opencode run --session <sessionID> --model <provider/model> --format json --dir <path> "<message>"
opencode models [provider]
opencode providers list
```

注意：`opencode models aihubmix` 只能说明模型在 provider 列表中出现，不保证当前 API key 对该模型有调用权限。插件必须把 provider 授权失败当成模型配置问题报告，而不是当成 transfer 失败。

## 4. 参考项目能力映射

`codex-plugin-cc` 的目标是“在 Claude Code 中使用 Codex”。本项目的目标是反过来“在 Codex 中使用 OpenCode”。

目标映射如下：

| `codex-plugin-cc` 能力 | 本项目对应能力 | 目标状态 |
| --- | --- | --- |
| setup | `opencode_setup` | 检查 OpenCode CLI、provider、模型、工作目录、插件配置。 |
| run | `opencode_run` | 从 Codex 启动 OpenCode 任务，可前台或后台执行。 |
| rescue | `opencode_rescue` | 将当前问题上下文交给 OpenCode 做救援分析。 |
| review | `opencode_review` | 让 OpenCode 对 diff、文件或指定范围做代码审查。 |
| adversarial-review | `opencode_adversarial_review` | 让 OpenCode 以反方视角寻找失败路径和隐藏风险。 |
| transfer | `opencode_transfer` | 将 Codex thread 转成 OpenCode session 并导入。 |
| status | `opencode_status` | 查看后台 OpenCode job 状态。 |
| result | `opencode_result` | 读取 OpenCode job 输出、事件和摘要。 |
| cancel | `opencode_cancel` | 终止仍在运行的 OpenCode job。 |
| optional stop-time review gate | 后续 hook 或 skill 流程 | 初版不强制，需要先验证 Codex plugin hook 打包和启用方式。 |

## 5. 目标用户体验

插件安装后，用户在 Codex 中应该可以自然地说：

- “用 OpenCode 跑一下这个修复方案。”
- “让 OpenCode review 当前 diff。”
- “让 OpenCode 从反方角度审查这次改动。”
- “把当前 Codex 会话转给 OpenCode 继续。”
- “查看刚才 OpenCode 任务的结果。”
- “取消那个还在跑的 OpenCode 任务。”

Codex 插件内部通过 skill 引导用户表达意图，再通过 MCP server 调用 OpenCode CLI。用户不需要手写 OpenCode session JSON，也不需要知道 Codex rollout 文件在哪里。

## 6. 仓库布局

建议采用 Codex marketplace 兼容布局：

```text
.
├── .agents/
│   └── plugins/
│       └── marketplace.json
├── docs/
│   └── development.md
├── plugins/
│   └── opencode-plugin-codex/
│       ├── .codex-plugin/
│       │   └── plugin.json
│       ├── .mcp.json
│       ├── README.md
│       ├── package.json
│       ├── skills/
│       │   └── opencode/
│       │       └── SKILL.md
│       └── dist/
│           └── server.mjs
├── src/
│   ├── cli/
│   │   ├── discover-opencode.ts
│   │   ├── opencode.ts
│   │   └── parse-events.ts
│   ├── codex/
│   │   ├── find-thread.ts
│   │   ├── parse-rollout.ts
│   │   └── transcript.ts
│   ├── jobs/
│   │   ├── job-store.ts
│   │   └── runner.ts
│   ├── transfer/
│   │   ├── to-opencode-session.ts
│   │   └── import-session.ts
│   ├── tools/
│   │   ├── check.ts
│   │   ├── run.ts
│   │   ├── review.ts
│   │   ├── status.ts
│   │   └── transfer.ts
│   └── server.ts
├── test/
│   ├── fixtures/
│   ├── unit/
│   └── integration/
├── package.json
├── tsconfig.json
└── README.md
```

说明：

- `plugins/opencode-plugin-codex` 是 Codex 插件发布目录。
- `src` 是 TypeScript 源码，构建后输出到插件目录的 `dist/server.mjs`。
- `.agents/plugins/marketplace.json` 用于本仓库作为插件 marketplace 时被 Codex 发现。
- 初版不要在 `plugin.json` 中写未经验证的 manifest 字段，尤其是 hook 相关字段。hook 能力等插件主体可用后单独验证。

## 7. 插件架构

整体链路：

```text
Codex user intent
  -> Codex skill
  -> bundled MCP server
  -> OpenCode CLI wrapper
  -> OpenCode session / provider / model
  -> MCP result back to Codex
```

核心模块：

| 模块 | 责任 |
| --- | --- |
| Skill | 定义用户在 Codex 中如何调用 OpenCode，说明何时使用哪些 MCP tool。 |
| MCP server | 暴露 `opencode_*` 工具，做参数校验、任务调度、错误包装。 |
| CLI discovery | 找到 OpenCode 可执行文件，支持 `OPENCODE_BIN`、常见路径和 `PATH`。 |
| OpenCode wrapper | 使用 `spawn` 调 CLI，解析 JSON event stream，收集 stdout/stderr。 |
| Job runner | 后台运行长任务，保存 job 状态和输出。 |
| Codex transcript reader | 找到当前 Codex thread 的 transcript。 |
| Transfer converter | 将 Codex visible transcript 转成 OpenCode import JSON。 |
| Review prompt builder | 生成 review、rescue、adversarial review 的 OpenCode prompt。 |
| Security filter | 防止把系统/developer 指令、密钥、敏感文件内容转移给 OpenCode。 |

## 8. MCP 工具设计

### 8.1 `opencode_check`

用途：快速诊断当前环境能否运行 OpenCode。

输入：

```ts
{
  cwd?: string;
  opencodeBin?: string;
  provider?: string;
  model?: string;
  includeModels?: boolean;
}
```

行为：

1. 探测 OpenCode CLI。
2. 运行 `opencode --version`。
3. 检查 `opencode providers list`。
4. 可选运行 `opencode models <provider>`。
5. 报告当前 shell 是否能直接找到 `opencode`。

输出：

```ts
{
  ok: boolean;
  opencodeBin?: string;
  version?: string;
  providers?: string[];
  modelHint?: string;
  warnings: string[];
  errors: string[];
}
```

### 8.2 `opencode_setup`

用途：给用户一个可执行的设置诊断，不直接写凭据。

输入：

```ts
{
  cwd?: string;
  opencodeBin?: string;
  preferredProvider?: string;
  preferredModel?: string;
  verifyModel?: boolean;
}
```

行为：

- 调用 `opencode_check`。
- 如果 CLI 不存在，提示安装方式。
- 如果 provider 不存在，提示运行 `opencode providers` 或 `opencode auth`。
- 如果模型调用失败，明确区分：
  - CLI 不存在。
  - provider 未配置。
  - 模型未授权。
  - 网络或 provider 服务错误。

### 8.3 `opencode_run`

用途：从 Codex 启动一个 OpenCode 任务。

输入：

```ts
{
  prompt: string;
  cwd?: string;
  model?: string;
  agent?: string;
  files?: string[];
  title?: string;
  background?: boolean;
  format?: "text" | "json";
  timeoutMs?: number;
  dangerouslySkipPermissions?: boolean;
}
```

默认策略：

- 默认后台执行，返回 job id。
- 短任务可以允许前台等待。
- 默认不启用 `--dangerously-skip-permissions`。
- 使用 `--dir` 固定工作目录。
- 使用 `--format json` 方便结构化解析。

### 8.4 `opencode_continue`

用途：继续已有 OpenCode session。

输入：

```ts
{
  sessionId: string;
  prompt: string;
  cwd?: string;
  model?: string;
  fork?: boolean;
  background?: boolean;
}
```

对应 CLI：

```bash
opencode run --session <sessionId> --model <provider/model> --format json --dir <cwd> "<prompt>"
```

### 8.5 `opencode_rescue`

用途：当 Codex 任务卡住、测试失败或需要第二代理救援时，让 OpenCode 独立分析。

输入：

```ts
{
  problem: string;
  cwd?: string;
  model?: string;
  includeDiff?: boolean;
  includeRecentTranscript?: boolean;
  background?: boolean;
}
```

prompt 要求：

- 要求 OpenCode 先复述问题和假设。
- 要求给出最小修复路径。
- 要求区分“已证据支持”和“需要验证”。
- 默认不允许直接修改文件，除非用户显式授权。

### 8.6 `opencode_review`

用途：让 OpenCode 审查当前变更。

输入：

```ts
{
  cwd?: string;
  target?: "working-tree" | "staged" | "branch" | "files";
  baseRef?: string;
  files?: string[];
  model?: string;
  severityFloor?: "all" | "medium" | "high";
  background?: boolean;
}
```

行为：

- 解析目标 diff。
- 生成只读 review prompt。
- 要求输出按 severity 排序。
- 要求每条问题包含文件、行号、影响、复现或验证建议。

### 8.7 `opencode_adversarial_review`

用途：让 OpenCode 站在反方立场寻找隐藏失败模式。

输入基本同 `opencode_review`，但 prompt 更强调：

- 破坏性思考。
- 迁移、回滚、并发、权限、边界条件。
- 关注“看起来能跑但线上会坏”的路径。

### 8.8 `opencode_transfer`

用途：将当前 Codex thread 转成 OpenCode session 并导入 OpenCode。

输入：

```ts
{
  threadId?: string;
  cwd?: string;
  model?: string;
  title?: string;
  maxMessages?: number;
  includeToolOutputs?: boolean;
  includeDeveloperMessages?: false;
  continuePrompt?: string;
  runAfterImport?: boolean;
}
```

默认值：

- `threadId` 默认来自 `CODEX_THREAD_ID`。
- `includeDeveloperMessages` 固定默认为 `false`，初版不建议开放为 `true`。
- `includeToolOutputs` 默认为 `false`。
- `maxMessages` 默认限制最近可见 transcript，避免导入过大。
- `runAfterImport` 默认为 `false`，用户显式要求“转过去继续”时才运行。

输出：

```ts
{
  ok: boolean;
  opencodeSessionId?: string;
  importedMessages?: number;
  sourceThreadId?: string;
  source?: "codex-jsonl" | "app-server" | "explicit-file";
  warnings: string[];
  jobId?: string;
}
```

### 8.9 `opencode_status`

用途：查看后台任务状态。

输入：

```ts
{
  jobId?: string;
  limit?: number;
}
```

输出 job 状态：

- `queued`
- `running`
- `succeeded`
- `failed`
- `cancelled`

### 8.10 `opencode_result`

用途：读取任务输出。

输入：

```ts
{
  jobId: string;
  maxChars?: number;
  includeRawEvents?: boolean;
}
```

输出：

- 最终文本。
- OpenCode session id。
- token/cost 信息。
- stdout/stderr tail。
- 错误分类。

### 8.11 `opencode_cancel`

用途：取消正在运行的 OpenCode 子进程。

输入：

```ts
{
  jobId: string;
}
```

行为：

- 优先发送 `SIGTERM`。
- 超时后再 `SIGKILL`。
- 写入 job 状态和取消原因。

## 9. OpenCode CLI 探测策略

由于当前机器已经证明 `opencode` 不一定在非交互 shell 的 `PATH` 中，探测顺序必须稳定：

1. 用户显式传入的 `opencodeBin`。
2. 环境变量 `OPENCODE_BIN`。
3. 常见安装路径：
   - `~/.opencode/bin/opencode`
   - `/opt/homebrew/bin/opencode`
   - `/usr/local/bin/opencode`
4. `PATH` 中的 `opencode`。

每个候选必须验证：

```bash
<candidate> --version
```

实现要求：

- 不通过 shell 拼接命令，使用 `spawn(file, args)`。
- 路径中有空格也必须工作。
- 返回错误时带上已尝试路径。
- 不自动执行 `opencode upgrade` 或 `opencode uninstall`。

## 10. Transfer 设计

### 10.1 数据源优先级

`opencode_transfer` 读取 Codex transcript 的推荐顺序：

1. Codex Desktop 或 app-server 能力，如果当前插件运行时暴露稳定 thread API。
2. `CODEX_THREAD_ID` 加本地 rollout JSONL 文件。
3. 用户显式传入的 Codex rollout JSONL 文件。
4. 如果以上都失败，降级为 continuation prompt bootstrap。

当前本机验证显示：

- Codex Desktop 工具层可以读取 thread。
- `codex app-server generate-json-schema` 中存在 `thread/read`，参数有 `includeTurns`。
- 直接启动独立 `codex app-server` 读取当前 thread 曾出现兼容问题。
- 本机 JSONL rollout 文件可以解析出完整 visible transcript。

所以初版应把 JSONL fallback 做扎实，不要只依赖 app-server。

### 10.2 Codex JSONL 解析规则

Codex rollout JSONL 每行是一个 JSON record，常见类型包括：

- `session_meta`
- `turn_context`
- `response_item`
- `event_msg`
- `compacted`

用于 transfer 的核心记录是 `response_item`。解析规则：

1. 只提取 `payload.type === "message"`。
2. 只保留 `role === "user"` 和 `role === "assistant"`。
3. 提取 `content` 中的 `input_text` 和 `output_text`。
4. 默认忽略 `developer`、system、tool call、tool result、reasoning、encrypted content。
5. 按 JSONL 文件顺序保持时间线。
6. 对连续同角色文本可合并，但必须保留 user/assistant 轮次边界。
7. 过滤空消息。
8. 对超长 transcript 应按最近 N 条或 token 预算截断，并在导入 session 的首条 system-like note 中说明截断情况。

初版不要导入 developer 指令，因为这会把 Codex 内部行为约束转移到 OpenCode，既不一定合法，也不一定符合用户预期。

### 10.3 OpenCode import JSON 结构

OpenCode import/export JSON 结构已经通过 `opencode export --sanitize` 观察并通过 `opencode import` 验证。核心形态：

```json
{
  "info": {
    "id": "ses_codex_transfer_<suffix>",
    "title": "Codex transfer",
    "version": "1.17.11",
    "time": {
      "created": 1782589587543,
      "updated": 1782589587543
    }
  },
  "messages": [
    {
      "info": {
        "id": "msg_...",
        "sessionID": "ses_codex_transfer_<suffix>",
        "role": "user",
        "time": {
          "created": 1782589587543
        }
      },
      "parts": [
        {
          "id": "prt_...",
          "sessionID": "ses_codex_transfer_<suffix>",
          "messageID": "msg_...",
          "type": "text",
          "text": "..."
        }
      ]
    }
  ]
}
```

实现时不要手写靠猜的字段全集。应从 sanitized export fixture 建立最小可导入 schema，并用真实 `opencode import` 做 live integration gate。

### 10.4 导入与继续

导入流程：

1. 解析 Codex transcript。
2. 生成 OpenCode session JSON。
3. 写入 OS 临时目录。
4. 执行：

```bash
opencode import <temp-json>
```

5. 解析 stdout 中的：

```text
Imported session: <session-id>
```

6. 如果 `runAfterImport === true`，继续执行：

```bash
opencode run --session <session-id> --model <provider/model> --format json --dir <cwd> "<continuePrompt>"
```

生产实现中，导入成功后应默认删除临时 JSON。调试模式可以保留并在结果中报告路径。

### 10.5 已完成 transfer smoke 验证

已经完成的本机验证：

- 从当前 Codex JSONL 中提取 visible user/assistant transcript。
- 转换为 OpenCode session JSON。
- 执行 `opencode import` 成功。
- 执行 `opencode export <session> --sanitize` 成功 round-trip。
- 执行 `opencode run --session <session> --model provider/model-authorized-for-this-user --format json` 成功返回预期文本。

这证明 OpenCode 端具备等价导入能力，Codex 端也存在可用 transcript 来源。剩余工作是把一次性验证脚本产品化为插件内部模块。

## 11. 后台任务设计

OpenCode 任务可能很久，MCP tool 不应该始终阻塞到完成。需要一个轻量 job store。

Job record：

```ts
type JobRecord = {
  id: string;
  kind:
    | "run"
    | "continue"
    | "rescue"
    | "review"
    | "adversarial_review"
    | "transfer";
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  cwd: string;
  command: string;
  args: string[];
  opencodeSessionId?: string;
  pid?: number;
  startedAt?: string;
  finishedAt?: string;
  exitCode?: number;
  signal?: string;
  errorClass?: string;
  errorMessage?: string;
  stdoutPath: string;
  stderrPath: string;
  eventsPath?: string;
  resultPath?: string;
};
```

存储位置：

```text
<repo-or-cwd>/.opencode-plugin-codex/jobs/
```

注意：

- 初版可以只支持当前 Codex 工作区内的 job store。
- 不要写入用户 home 下的全局状态，除非用户明确配置。
- job 文件需要可读 JSON，方便用户手动排障。
- stdout/stderr 应限制返回长度，完整输出保存到文件。

## 12. Review 与 Rescue prompt 规范

### 12.1 Review 输出格式

要求 OpenCode 输出：

```text
Findings
1. [severity] file:line
   Impact:
   Evidence:
   Suggested fix:

Open questions

Test gaps
```

规则：

- Findings 优先，摘要靠后。
- 没有发现问题时必须明确说没有发现 blocker。
- 不要把风格建议和真实 bug 混在一起。
- 必须区分已经验证的事实和模型推测。

### 12.2 Adversarial review 输出格式

要求 OpenCode 输出：

```text
Breakage Paths
1. Scenario:
   Why this can fail:
   Evidence to check:
   Mitigation:

Highest-risk assumption

Recommended verification
```

规则：

- 重点找“看起来可以运行但实际可能出错”的路径。
- 优先关注权限、并发、路径、平台差异、长上下文截断、模型授权失败。
- 不要求 OpenCode 给完整修复，先要求它给风险闭环。

### 12.3 Rescue 输出格式

要求 OpenCode 输出：

```text
Diagnosis

Minimal path forward

Commands to verify

Risks
```

规则：

- 默认只读。
- 如果用户授权修改，OpenCode 才能编辑文件。
- Rescue 的结果应回到 Codex，由 Codex 决定是否采纳和执行。

## 13. 安全和隐私边界

必须遵守以下边界：

1. 不读取或输出用户凭据。
2. 不把 Codex developer/system 指令导入 OpenCode session。
3. 默认不导入 tool outputs，因为其中可能包含文件内容、命令输出或敏感信息。
4. 默认不启用 `--dangerously-skip-permissions`。
5. 不自动删除 OpenCode 数据库中的 session，除非用户明确要求。
6. 不自动运行 `opencode uninstall`、`upgrade` 或 provider auth 写入操作。
7. 所有 CLI 调用使用 `spawn` 参数数组，不拼 shell 字符串。
8. transfer 之前需要在结果中说明：这会把当前可见对话写入 OpenCode 本地 session 数据库。

对于 `opencode_transfer`，安全默认值应该偏保守：

```ts
{
  includeDeveloperMessages: false,
  includeToolOutputs: false,
  runAfterImport: false
}
```

## 14. 错误分类

插件需要把错误分类清楚，方便用户下一步操作。

| 错误类型 | 识别方式 | 用户动作 |
| --- | --- | --- |
| `opencode_not_found` | 所有路径探测失败 | 安装 OpenCode CLI 或设置 `OPENCODE_BIN`。 |
| `opencode_not_executable` | 文件存在但不可执行 | 修复权限或重新安装。 |
| `provider_missing` | provider 列表为空或目标 provider 不存在 | 运行 OpenCode auth/provider 配置。 |
| `model_unauthorized` | provider 返回 403、unauthorized、permission denied | 更换模型或修复 provider key 权限。 |
| `network_error` | DNS、连接超时、provider 服务不可达 | 检查网络或 provider 状态。 |
| `codex_thread_missing` | 找不到 `CODEX_THREAD_ID` 或显式 thread | 传入 thread id 或 JSONL 文件。 |
| `codex_rollout_parse_failed` | JSONL 不符合预期 | 回退 continuation prompt，保留错误摘要。 |
| `opencode_import_failed` | `opencode import` 非零退出 | 报告 import stderr 和 JSON schema 摘要。 |
| `job_cancelled` | 用户取消 | 返回已取消和输出 tail。 |

模型授权失败不能归类为 transfer 失败。transfer 成功但 run-after-import 失败时，结果应明确：

```text
Import succeeded, OpenCode session created: <session-id>.
Continuation run failed because model <model> is not authorized by provider <provider>.
```

## 15. 实现阶段

### 阶段 1：插件骨架

目标：

- 建立 TypeScript 项目。
- 建立 Codex plugin manifest。
- 建立 MCP server。
- 建立本地 marketplace。

交付物：

- `package.json`
- `tsconfig.json`
- `src/server.ts`
- `plugins/opencode-plugin-codex/.codex-plugin/plugin.json`
- `plugins/opencode-plugin-codex/.mcp.json`
- `plugins/opencode-plugin-codex/skills/opencode/SKILL.md`
- `.agents/plugins/marketplace.json`

验收：

- `npm test` 通过。
- `npm run build` 生成 `plugins/opencode-plugin-codex/dist/server.mjs`。
- Codex 能发现插件和 MCP server。

### 阶段 2：OpenCode CLI wrapper

目标：

- 实现 CLI 探测。
- 实现基础 OpenCode 调用。
- 实现 JSON event 解析。

交付物：

- `src/cli/discover-opencode.ts`
- `src/cli/opencode.ts`
- `src/cli/parse-events.ts`

验收：

- 单元测试覆盖 PATH 缺失、显式 `OPENCODE_BIN`、常见路径探测。
- fake OpenCode CLI 测试覆盖成功、非零退出、stderr、JSON events。
- live check 可返回本机 OpenCode `1.17.11`。

### 阶段 3：基础 MCP tools

目标：

- 实现 `opencode_check`。
- 实现 `opencode_setup`。
- 实现 `opencode_run`。
- 实现 `opencode_continue`。

验收：

- MCP server 能 list tools。
- 每个 tool 的 input schema 有测试。
- `opencode_run` 可以用 fake CLI 测试。
- live gate 在显式设置 `OPENCODE_LIVE=1` 时运行。

### 阶段 4：后台 job 系统

目标：

- 实现 job store。
- 实现后台子进程生命周期管理。
- 实现 `opencode_status`、`opencode_result`、`opencode_cancel`。

验收：

- 后台 job 从 `queued` 到 `running` 到终态。
- 取消 running job 后状态为 `cancelled`。
- stdout/stderr tail 限长返回，完整输出可从文件读取。

### 阶段 5：Transfer 子系统

目标：

- 实现 Codex JSONL 查找。
- 实现 rollout parser。
- 实现 Codex transcript 到 OpenCode session JSON 的转换。
- 实现 `opencode_transfer`。

交付物：

- `src/codex/find-thread.ts`
- `src/codex/parse-rollout.ts`
- `src/codex/transcript.ts`
- `src/transfer/to-opencode-session.ts`
- `src/transfer/import-session.ts`
- `src/tools/transfer.ts`

验收：

- 用 sanitized Codex JSONL fixture 解析出正确 user/assistant 消息。
- developer/system/tool output 默认不进入 transfer。
- 生成的 OpenCode session JSON 通过 golden snapshot。
- live gate 可执行 `opencode import`。
- 在 `OPENCODE_LIVE=1` 且指定可用模型时，可执行 import 后 continue。

### 阶段 6：Review/Rescue 工作流

目标：

- 实现 diff resolver。
- 实现 review prompt builder。
- 实现 rescue/adversarial review tools。

验收：

- 对 working tree、staged、files 三类目标有测试。
- prompt 不要求 OpenCode 直接修改文件。
- 输出解析能提取 findings、open questions、test gaps。

### 阶段 7：发布和文档

目标：

- README 可指导安装。
- marketplace metadata 完整。
- 发布前跑完整验证。

验收：

- 新用户可以从 GitHub repo 安装插件。
- README 包含最小使用例子。
- `opencode_transfer` 的隐私边界写清楚。
- 所有 live tests 均为 opt-in，普通 CI 不依赖用户 OpenCode 配置。

## 16. 测试计划

### 16.1 单元测试

必须覆盖：

- CLI path discovery。
- OpenCode command arg 生成。
- JSON event parser。
- job store 状态转换。
- Codex JSONL parser。
- OpenCode session JSON converter。
- 错误分类。

### 16.2 fixture 测试

需要建立 fixtures：

```text
test/fixtures/
├── codex-rollout-minimal.jsonl
├── codex-rollout-with-developer.jsonl
├── codex-rollout-with-tool-output.jsonl
├── opencode-export-sanitized.json
└── opencode-run-events.jsonl
```

测试点：

- developer message 被过滤。
- tool output 默认被过滤。
- user/assistant 顺序不乱。
- transcript 截断会产生 warning。
- converter 生成的 JSON 可稳定 snapshot。

### 16.3 MCP contract 测试

测试：

- server 启动。
- tools/list 返回全部工具。
- tools/call 对非法参数返回结构化错误。
- tools/call 对 fake CLI 返回稳定结果。

### 16.4 Live integration 测试

live 测试必须显式开启：

```bash
OPENCODE_LIVE=1 \
OPENCODE_BIN="$HOME/.opencode/bin/opencode" \
OPENCODE_MODEL="provider/model-authorized-for-this-user" \
npm run test:integration
```

live 测试不在默认 CI 运行，因为它依赖用户本机 provider、模型授权和 OpenCode 数据库。

最关键的 live transfer acceptance：

1. 生成一个最小 Codex rollout fixture。
2. 转换为 OpenCode import JSON。
3. `opencode import <json>` 成功。
4. `opencode export <session> --sanitize` 成功。
5. `opencode run --session <session> --model "$OPENCODE_MODEL" --format json "Reply exactly: OPENCODE_IMPORTED_SESSION_CONTINUED_OK."` 成功。
6. 输出包含 `OPENCODE_IMPORTED_SESSION_CONTINUED_OK`。

## 17. 验收标准

插件达到可用版本的标准：

- `opencode_check` 能准确报告 OpenCode CLI 和 provider 状态。
- `opencode_run` 能启动 OpenCode 并返回 job。
- `opencode_status`、`opencode_result`、`opencode_cancel` 能管理后台 job。
- `opencode_review` 能对当前 diff 输出结构化 findings。
- `opencode_adversarial_review` 能输出风险路径。
- `opencode_transfer` 能把当前 Codex visible transcript 导入 OpenCode。
- transfer 默认不泄露 developer/system/tool output。
- 模型授权失败时，能报告“session 已导入但继续运行失败”。
- 默认测试不依赖网络或用户 provider。
- live 测试在配置模型后能完整通过。

## 18. 当前遗留清理项

本机验证过程中产生过 OpenCode 测试 session 和临时 JSON。它们用于证明 import/export/run 链路有效，不应在没有用户明确确认时删除。

已知测试 session：

```text
ses_codex_import_1782589193602
ses_codex_jsonl_transfer_1782589587543
```

已知临时 JSON：

```text
<temp-dir>/opencode-codex-transfer-import-smoke-1782589193602.json
<temp-dir>/opencode-codex-jsonl-transfer-probe-1782589562042.json
<temp-dir>/opencode-codex-jsonl-transfer-probe-1782589587543.json
```

后续如果要清理，需要先确认 OpenCode 是否提供安全删除 session 的 CLI 或 DB 工具；不能直接手工改数据库作为默认方案。

## 19. 风险和待确认问题

| 风险 | 当前状态 | 缓解方案 |
| --- | --- | --- |
| Codex app-server API 在插件运行时是否稳定可用 | 尚未完全确认 | JSONL fallback 作为初版主路径。 |
| Codex rollout JSONL schema 未来变化 | 中等风险 | parser 写成宽松模式，fixture 覆盖多版本。 |
| OpenCode import JSON schema 未来变化 | 中等风险 | 用当前 OpenCode sanitized export 建 golden fixture，live gate 捕捉变化。 |
| provider 模型列表不等于授权可用 | 已验证存在 | 增加 model override 和错误分类。 |
| 非交互 shell PATH 缺失 OpenCode | 已验证存在 | CLI discovery 必须支持常见路径和 `OPENCODE_BIN`。 |
| transfer 可能导入敏感上下文 | 高风险 | 默认只导入 visible user/assistant text，过滤 tool output 和 developer 指令。 |
| 长 transcript 太大 | 中等风险 | 默认最近 N 条和 token 预算，结果中报告截断。 |
| stop-time review gate | 未实现 | 放到第二阶段，在插件主体可用后单独验证 hook 打包。 |

## 20. 推荐下一步

下一步不要继续停留在计划层，应进入实现：

1. 初始化 TypeScript 项目和插件骨架。
2. 先实现 `opencode_check`，解决 CLI path discovery。
3. 用 fake CLI 完成 MCP server contract 测试。
4. 实现 `opencode_transfer` 的 JSONL parser 和 converter。
5. 做一次 live transfer gate，复现已经手工验证成功的链路。
6. 再补 review、rescue、adversarial review。

最小可用版本应优先包含：

- `opencode_check`
- `opencode_run`
- `opencode_status`
- `opencode_result`
- `opencode_cancel`
- `opencode_transfer`

review 和 rescue 可以排在第二批，但 transfer 必须从第一版开始做，因为它是本项目能否接近 `codex-plugin-cc` 体验的核心。
