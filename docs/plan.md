# 自主迭代循环（Execute → Verify → Fix）实现计划

## 目标

在 Virlen Agent 引擎中增加「执行→验证→修复」的自主迭代能力，让 AI 能自动检查自己的执行结果，发现问题后主动修正，直到达到目标或超出重试次数。

## 架构设计

```
                    ┌─────────────────────────────┐
                    │     IterationController      │
                    │                              │
   用户输入 Goal ──►│  ┌─────────────────────┐    │
                    │  │   LLM Round         │    │
                    │  │   (think + act)     │    │
                    │  └──────────┬──────────┘    │
                    │             ▼               │
                    │  ┌─────────────────────┐    │
                    │  │  Execute Tools      │    │
                    │  └──────────┬──────────┘    │
                    │             ▼               │
                    │  ┌─────────────────────┐    │
                    │  │  LLMVerifier        │    │
                    │  │  (同一模型验证)      │    │
                    │  └──────────┬──────────┘    │
                    │        ┌────┴────┐          │
                    │      ✅│        │❌        │
                    │        ▼        ▼          │
                    │    结束 ✅   注入反馈       │
                    │              │             │
                    │              ▼             │
                    │         回到 LLM Round     │
                    └─────────────────────────────┘
```

## 实现步骤

|  #  | 文件                                        | 操作     | 说明                                                                |
| :-: | ------------------------------------------- | -------- | ------------------------------------------------------------------- |
|  1  | `src/domain/engine/iteration-types.ts`      | **新建** | 迭代循环的类型定义（Goal、VerificationResult、IterationSession 等） |
|  2  | `src/domain/engine/verifier.ts`             | **新建** | LLMVerifier — 使用同一模型验证执行结果是否达标                      |
|  3  | `src/domain/engine/iteration-controller.ts` | **新建** | 迭代控制器 — 编排 LLM调用→工具执行→验证→反馈 的循环                 |
|  4  | `src/domain/engine/types.ts`                | **修改** | SendMessageOptions 增加 `iterationGoal` 可选字段                    |
|  5  | `src/types/index.ts`                        | **修改** | AgentEventType 增加迭代事件类型                                     |
|  6  | `src/domain/engine/engine.ts`               | **修改** | AgentEngine.sendMessage 增加迭代模式分支                            |
|  7  | `src/domain/engine/index.ts`                | **修改** | 导出新增的类型和实例                                                |
|  8  | `src/services/chat-service.ts`              | **修改** | 新增 `sendMessageWithGoal()` 方法                                   |
|  9  | `tests/domain/iteration-controller.test.ts` | **新建** | 单元测试                                                            |

## 关键设计决策

### 决策 1：同一模型验证

使用与执行相同的模型做验证。虽然独立模型更客观，但同一模型方案：

- 成本更低（不消耗额外 token）
- 架构更简单（不需要管理第二个 provider）
- 对大多数场景足够

### 决策 2：验证时机

每次 LLM 产出 tool_calls 并执行完毕后，立即验证一次。
如果 LLM 没有产生 tool_calls（直接给出答案），也做一次验证。

### 决策 3：反馈注入方式

验证结果以 `user` 角色的消息注入到下一轮对话中，
包含：问题列表、严重级别、修复建议。
这样 LLM 天然能看到上一轮的问题，不需要额外状态管理。

### 决策 4：最大迭代次数

默认 5 次，防止无限循环。超出后以失败状态结束，
生成详细报告交给用户决策。
