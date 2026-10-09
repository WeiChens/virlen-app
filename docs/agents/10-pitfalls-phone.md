# 常见坑 · 手机端与共享包（§11.42–§11.47）

> 本册是 [`docs/AGENTS.md`](../AGENTS.md) 的分册：**原 §号保持不变**（源码注释与文档里的 §-引用照旧有效）。总入口 / 铁律 / 安全红线见 [`../AGENTS.md`](../AGENTS.md)。

**11.42 手机端文件面板：条目一多，面包屑被挤成一条缝（用户报回 → 已修）** —— 现象：目录里条目多了之后，面板顶部的面包屑只剩「一点点」（文字被截去大半），想回上一级得先滚回顶部。
- 根因：面包屑是 `.sheet__body`（`flex` 列 + `overflow-y: auto`）的子项，而它自己写了 `overflow-x: auto` —— 这会让 `overflow-y` **也算成 `auto`**，于是它是一个**滚动容器**；**滚动容器的自动最小高度是 0**，所以内容装不下时，收缩量（`flex-shrink`）几乎全落到它头上（其余子项 `overflow` 可见，最小高度 = 内容高度，压不动）。
- 结论：**flex 列里凡自带滚动的子项（`overflow: auto/hidden/scroll`），都必须自己声明 `flex: none`（或 `flex-shrink: 0`）**；判断时别只看有没有写 `overflow-y` —— 写了 `overflow-x: auto` 就已经是滚动容器了。
- 顺带改成 `position: sticky; top: 0` 常驻面板顶部。⚠️ sticky 的代价：**必须自己铺一层与 `.sheet` 同色的背景**（否则列表行从它背后滚过时直接「叠字」），再用 `padding-bottom: 14px` + `margin-bottom: -12px` 盖住 `.sheet__body` 的 12px 间距而不改视觉间距。
- 落地与守卫：`virlen-mobile/src/ui/components/FileSheet.css`；**`jsdom` 不做布局，这类缺陷在 DOM 断言里根本看不见**（元素在、文案在、click 也照旧触发），所以守卫用例直接读样式表 —— `files-ui.test.ts` 的「文件面板的布局契约」（钉 `flex: none`，并比对面包屑底色与 `.sheet` 底色**同色**）。

**11.43 手机端文件面板：进目录时把列表换成一行提示 = 高度先塌再撑的「闪一下」（用户报回 → 已修）** —— 现象：点进一个子目录，界面明显闪动一下。
- 根因：`fileStore.load()` **并没有**清 `entries`（上一份列表还在 state 里），是**渲染**把它换成了单行提示（`loading ? hint : list`）；面板高度是内容撑的，于是「塌 → 撑」两下。
- 结论：**加载中保留上一份内容，等应答回来直接替换**；加载提示放在**既不占高度、也不随内容滚**的地方（这里是标题栏下方的绝对定位胶囊，定位父级 `.sheet__head` 因此加了 `position: relative`）。首屏（还没有上一份列表）保持原样给一行提示。
- 顺带一条：在途时旧行本来就是 `disabled`（`isBusy()` 含 `loading`），所以「旧列表点不动」**不用额外做** —— 但**新增行内交互时得自己走 `busy`**，否则就是拿旧目录的条目发新请求。
- 守卫（`files-ui.test.ts`）：把电脑侧的列目录**拖慢 40ms**，点进去后**不等应答**就地断言「行数不变 + 出现加载提示」，再等应答验「整体替换」。不拖慢是测不到的 —— 内存链路会在同一次 `act` 里就答完。

**11.44 手机端编辑电脑上的文件：三个「存回去就把文件搞坏」的坑（§37 覆写保存）** ——
1. **换行**：`<textarea>` 的 value 只有 LF（HTML 规范），而 Windows 源码大多 CRLF ——
   照 LF 存回去 = 在「只改三个字符」的改动里混进一次**全文行尾改写**（diff 满屏红）。修法：
   先 `detectEolStyle` 记住原风格（按多数判），保存时 `encodeEditedText` 还原；而且必须
   **先拉平再铺**（`applyEolStyle`），只做 `\n → \r\n` 会把已有的 CRLF 变成 `\r\r\n`
   = 「保存一次多出一堆空行」。
2. **编码**：宽容解码（GBK 中文注释）看着能用，**存回去就是毁文件**（原本在电脑上还能正常看，
   之后连电脑上也读不回来了）→ `decodeUtf8Strict` 返回 `null` 就不给编辑入口，只说「请在电脑上改」。
3. **并发**：从手机上打开到按保存之间，电脑上的 AI / 用户 / 编辑器都可能写过它 → 必须带
   `expectMtimeMs` 校验（且 `finish` 落盘前**再来一次**），否则那些改动被**静默吞掉**且用户毫无察觉。
   「强制覆盖」= 先取一次当前版本再写，**不是盲写**。

**11.45 共享包契约的四个坑（文件引用 §37 落地时踩到的，前两条是跨仓通用的）**：
1. **`strictNullChecks: false` 会让布尔字面量的判别联合彻底无法收窄** —— `virlen-app` 的 tsconfig 是
   `strict: true` 但 **`strictNullChecks: false`**，于是共享包里写成
   `type R = { ok: true; files } | { ok: false; reason }` 之后，电脑侧那句
   `if (!r.ok) { …r.reason… }` 直接 **TS2339：`reason` 不存在于 `R`**（两边的分支都收窄不了，
   连 `return r.reason` 也不给过）。**契约放在共享包里就不能只在一边成立** → 改成
   `{ ok: boolean; files; reason: string }`（不变式：`ok === (reason === '')`），消费方不需要收窄。
   证据：临时探针文件在 `virlen-app` 里跑 `tsc --noEmit` 复现（见 `message-files.ts` 的 `FileRefSanitizeResult`）。
2. **「静默丢掉一条」比报错难查得多（假绿灯）** —— 手机端的 chip 由**手机端自己**渲染，电脑侧把
   非法条目删掉之后**一切照旧成功**：用户看到 chip 在、消息里也有，而 AI 从未看到那个文件。
   所以形状非法一律**拒整条**（`E_BAD_REQUEST`）+ 审计留痕。同一条纪律在 §36 引用、
   §22 压缩方式上都出现过：**宁可不让发，也不要发一个「看起来成了」的**。
3. **`[文件] …` 展平占位符丢了路径** —— `dto.ts::projectContentToText` 原本把文件块投影成
   `[文件] ${block.name ?? block.path}`：**只有名字**（同一目录下两个 `index.ts` 手机上分不出）、
   没有体积、也无法回显。所以拿了 §36 的同一条做法（结构化下行 + `skipQuotes` / `skipFiles`
   两个开关），⚠️ 但**两个开关都必须默认关**：`store-bridge` 的消息指纹故意不跳，
   否则「换了个附件」不会触发任何下行更新（手机端停在旧 chip 上）。
4. **「只附文件不写话」是一条完全正常的消息** —— 行模型 `rendersNothing` 只看正文的话会把它
   当成「什么都渲染不出来」而**不占行**（用户亲眼看自己发的那条不见了）。判据必须与 `MessageRow`
   的 `return null` 分支一致，且**每次新增一类结构化附件（引用 / 文件 / 以后还会有）都要回去改它**。

**11.46 手机端「默认打开第一个会话」= 默认打开【置顶】的那个（用户报回 → 已修）** ——
现象：每次打开（刷新 / 重连后重进）手机端都跑到一个**几天没动**的会话里，而最近在用的那个要手工去抽屉里选。
根因不在「默认打开第一个」这句，而在**那个「第一个」是谁**：电脑侧的会话列表是
`sessionStore.listSessions()` 排的「**置顶优先** → `updatedAt` 倒序」，所以 `sessions[0]` 是**置顶**项，
而不是最近用过的项（`virlen-mobile/src/ui/pages/Chat.tsx` 挂载 effect 里那句 `snap.sessions[0].id`）。
口径（用户拍板）：**正在工作的会话优先**（`SessionSummaryDTO.working === true`，电脑侧权威；多个则取其中
`updatedAt` 最大的），**否则取 `updatedAt` 最大的**；**置顶不参与这个选择** —— 置顶的意思是「别让它被淹没」，
不是「每次进来都回到它」。实现收在纯函数 `lib/session-entry.ts::pickEntrySession`（可单测）。
连带三条（都会踩）：
1. **列表顺序不能动**（手机端不得重排）：抽屉 / 分组 / 「组内顺序 = 电脑侧给的顺序」全靠它
   （`lib/session-groups.ts`）—— 要改「默认进哪个」只能在**这个纯函数里**自己比 `updatedAt`，不要顺手 sort 全表。
2. **必须保留「已有当前会话就不切」的守卫**：这个挂载 effect 不只跑在首屏，链路抖动 / 代际更替后重新挂载
   （`App.tsx` 在 `status !== 'online'` 时把整页换成 `Login`）也会跑它 —— 少了守卫，用户正看着的会话会被
   自己顶掉；那条路上真正该做的只是重拉（`chatStore.resync`）。
3. **`working` 是电脑侧给的快照事实**（`toSessionSummaryDTO` 取 `sessionRuntimeState`），所以「工作中优先」
   在**进入那一刻**就成立，不需要额外 RPC；但它也只是那一刻的事实 —— **不做轮询、不做自动跳转**
   （「某个会话开始工作了就自动切过去」会把用户正在读的内容换掉，且用户没有任何办法关掉它）。
回归：`virlen-mobile/src/tests/session-entry.test.ts`（纯函数 8 例 + DOM 端到端 4 例；后者在改回
`sessions[0]` 的实现下会红 —— 已实测）。演示宿主 `?entry=pin` / `?entry=work`（`src/dev/host-harness.ts`）
把「置顶但更旧」与「另一个会话正在工作」这两种真机形态造出来，真机/联调都能一眼看到标题换没换。

**11.47 「user_choice 过一会再回答」报 400（`Messages with role 'tool' must be a response to a preceding message with 'tool_calls'`）（用户报回 → 已修）** —— 复现路径：**工具弹窗 → 点「暂存」→ 过一会点「继续」→ 再回答**。
根因：**同一份 Run Snapshot 被并发恢复两次，导致同一步重跑、同一 `tool_call_id` 产出两条 tool 结果**（正是 §11.34 记的那个 400，但那条堵的是「残留快照重跑」，这条是**并发重入**）。两道缺口：
1. 前端 `services/chat/flow.ts::resumePausedRun` 的忙判据非原子 —— `isSessionActivelyWorking()` 检查后，中间隔了 `await getEngine().getRunSnapshot()` 才设 `working:true`；桌面 + 手机（或重复触发）会**都**通过检查、各拿同一份快照跑一次。
2. 引擎 `Engine::send_message` 对同一 `session_id` **没有并发闸** —— `active_cancels.insert` 是覆盖而非拒绝（`engine/tests.rs::concurrent_resume_of_same_snapshot_duplicates_tool_result` 实测：并发双恢复产出 `tc1` 两条 tool 结果）。
改法（两侧配对）：① 引擎侧原子 check-and-set（`Mutex` 内 `contains_key` → 拒绝，文案同前端 `MSG_SESSION_BUSY`），任何来源（桌面 / 手机 / 托盘 / CLI）都经这里，是**权威闸**；② 前端 `resumePausedRun` 拆成「同步防重入薄封装（`resumingSessions` Set）+ `resumePausedRunImpl`」—— 防重入必须在**任何 await 之前**同步生效（顺带避免第二次 `createToolHandles` 顶替第一次的交互 handler，令其 `user_choice` 掉进「无处理器」分支）。
⚠️ 不要踩：前端那把锁只是第一道防线（有 await 窗口），**不能**只修前端 —— 引擎侧必须也有闸；反之引擎侧有闸后，前端重复调用只会拿到「该会话正在回复中」，不会污染会话数据。
回归：`virlen-core` 的 `concurrent_resume_of_same_snapshot_duplicates_tool_result` / `resume_request_messages_are_well_formed` / `resume_after_shelve_then_answer_writes_single_tool_result`；前端 `src/tests/services/chat-concurrency.test.ts`（并发两次「继续」只一次进入）。
