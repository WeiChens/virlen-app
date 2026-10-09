# 手机控制 · 文件域 / 引用 / 压缩与字号（§5.9 之三）

> 本册是 [`docs/AGENTS.md`](../AGENTS.md) 的分册：**原 §号保持不变**（源码注释与文档里的 §-引用照旧有效）。总入口 / 铁律 / 安全红线见 [`../AGENTS.md`](../AGENTS.md)。

- **工作目录文件（§37）**：手机端能浏览 / 预览 / 下载 / **上传**当前会话工作目录里的文件（入口在会话信息面板的「工作目录」那一行：**浏览文件**）。
  ⚠️ 顶栏**早已收到三个图标**（信号 / ＋ / 会话列表）：五个 38px 图标就是 206px，360px 的屏上左侧标题只剩 ~100px（真机反馈「五个按钮和左边叠在一起了」）。文件入口当初也试过放顶栏，已下沉；`设置` 同理（在会话抽屉底栏）。
  - **协议（六个方法）**：`host.file.list`（非递归列目录）/ `host.file.read`（分块读，单次 ≤ `FILE_CHUNK_BYTES` = 256KB）/ `host.file.write.begin|chunk|finish|abort`（分块上传）。能力名三档（**默认全开**）：`file.browse` / `file.download` / `file.upload`（拆三档而不是一个：能看「有哪些文件」与能看「文件里写了什么」是两种强度，写又是第三种）。
  - **为何是 base64 分块而不是整文件 / 二进制帧**：帧层载荷是 UTF-8 JSON 且要**攒齐全部分片**才交付 —— 整文件塞一次会同时炸掉两端的组装缓冲；换二进制帧则要改帧格式与主版本。代价是 33% 的 base64 开销，换来进度可见、可取消、单请求内存上界固定。
    电脑侧读分块走 `open + seek + read`（`file-tauri.ts`）而不是 `plugin-fs.readFile`（**它把整个文件读进内存** —— 手机上点开 500MB 的视频时 webview 先 OOM，而我们只要前 256KB），为此 `src-tauri/capabilities/default.json` 里开了 `fs:allow-open` / `fs:allow-seek`（实际边界仍由 `fs:scope` 与本层传入的**已过安全校验**的绝对路径决定）。
  - ⚠️ **越权防线只有一道，且在电脑侧**：手机传来的路径先被 `normalizeRelPath` 规整（逃出工作目录的 `..` 段就地吃掉），再由 **`securityService.resolveSafePath`**（与桌面文件工具同一个入口）落到绝对路径并过黑白名单。`file-source.ts` 里**不得**自己做路径拼接 —— 两份拼接逻辑就是两个边界。安全拒绝归一成 `E_DENIED`（而不是让它成为一个普通 `Error` → 手机端看到「电脑端内部错误：路径不在…」，用户会去重试、去报修）。
  - ⚠️ **非中继门槛不在 ACL 里**（它是链路质量，不是授权）：口径是共享包的 `fileTransferDeniedReason()`，**只在确认走了 TURN 中继时拒**（`direct` / `unknown` 放行 —— `unknown` 是常态：同源 Broadcast 联调、非 WebRTC 链路、刚打通那几秒；把它判成禁用等于功能在联调里根本进不来）。链路事实只有拿 `RTCPeerConnection` 的那一层知道，故由 `PhoneControlService` 注入 `linkKind: () => kindWatch.kind`（与 `transferTier` 同一做法）。**唯一的例外是 `abort`**：它只删自己的临时文件，链路刚变中继 / 断掉时恰恰最需要能清掉它。
  - ⚠️ **上传是原子的**：`begin` 之后字节只写临时文件（`.virlen-upload-<id>.virlen-part`），`finish` 才 `rename` 到目标名 —— 传输中断 / 用户取消不会在用户项目里留下一个「打开是坏的」半截文件。`finish` 时若目标名被抢（用户同时在电脑上存了同名文件），**按同一条冲突口径再让一次名**并把新名字如实回给手机。同名自动加「 - 副本」（与桌面 `file-transfer-service` 同一条口径）。
  - 两个注入口：`fileSystem`（文件系统端口，不传 = Tauri 真机实现）与 `resolvePath`（安全校验）—— 本层的全部纪律（上限 / 临时文件 / 乱序拒绝）都值得单测，而单测里没有 Tauri（`src/tests/bridge/phone-files.test.ts` 注入内存端口 + 假安全校验）。
  - 手机端（`virlen-mobile`）：`store/files.ts` + `ui/components/FileSheet.tsx`；门槛判定收在 `fileStore.blockReason()`（能力 + 链路合成一句话，UI 只负责置灰与展示）。本端另有一条**本机内存**上限制（`DOWNLOAD_MAX_BYTES` = 64MB）：分块收下来的字节要拼成 Blob 才能交给系统分享，而 Blob 在手机上就是内存。列表区两条布局 / 加载态纪律（面包屑常驻、进目录不清空列表）见 §11.42、§11.43。
  - 联调：演示宿主自带一棵**真**文件树（含一张真 PNG 与一个未知类型的 `build/app.bin`）；`?files=relay` 让所有文件 RPC 一律拒（验证手机端整面板显示同一句理由）。
  - 用例：电脑侧 `src/tests/bridge/phone-files.test.ts`（越权 / 中继 / ACL / 原子落盘 / 乱序与未传完）；共享包 `tests/files.test.ts`（分类 / base64 / 路径 / mock 宿主）；手机端 `files-lib.test.ts`（纯函数）、`files-store.test.ts`（与 mock 宿主经内存链路对跑）、`files-ui.test.ts`（DOM：进目录 / 预览 / 中继置灰 / 两个入口）。
- **压缩上下文可选两种方式（§22）**：`CompressParams.mode`（`'ai'` = AI 摘要 / `'raw'` = 正文压缩）。
  能力名 `session.compress.mode`（常量 `COMPRESS_MODE_CAPABILITY`，见共享包 `protocol/compress.ts`）。
  - ⚠️ **为何要能力名**：`mode` 是普通字段，**旧电脑端会静默忽略它**而按电脑侧设置压缩 ——
    用户侧表现是「我点了『正文压缩』，结果还是 AI 摘要（还花了钱）」，没有任何报错可查。
    所以手机端**只在电脑端声明它时才给两个按钮**，否则只给一个「压缩上下文」（不传 `mode`）。
  - 它是**功能标记**而不是权限：压缩本身的授权仍是 `session.compress`（破坏性、需 `confirm: true`，
    handler 里独立 `assert`）。电脑侧 `host-source.ts::compress` 仍**独立校一遍取值**：
    没传 = 沿用桌面设置里的那一档（与改动前同形的一次调用）；**传了但不认识 → `E_BAD_REQUEST`**
    （落回缺省等于把手机端的一个拼写错误变成一次要花钱的模型调用）；留痕写明 `mode=…` / `mode=host-setting`。
  - 落地：手机端 `store/chat.ts::compressContext(sessionId, mode)` 只在能力允许时才把 `mode` 放进请求；
    UI 是会话信息面板「上下文」块里的**两个按钮**（`AI 摘要压缩` / `正文压缩`，各自二次确认）；
    `sentMode` 只用来决定哪一颗按钮转圈（压缩中的真实进度仍是电脑侧推来的 `compacting`）。
  - 联调：演示宿主（`virlen-remote/testing`）按 `mode` 出不同产物，`lastCompress()` 是观察口；
    手机端 `/host.html` 的说明已注明两个入口。
  - 用例：电脑侧 `src/tests/bridge/phone-compress-wiring.test.ts`（原样下发 / 归一化 / 未知取值拒 / 不传=沿用设置）；
    共享包 `tests/compress.test.ts`（取值域 + mock 真的走出不同产物）；
    手机端 `chat-compress-mode.test.ts`（DOM：两个按钮 / 选了真的走那种 / 取消不发 / 旧电脑端只给一个按钮且不传 `mode`）。
- **手机端界面字号五档（特小 / 小 / 中 / 大 / 特大）**：`--fs` = `0.80 / 0.90 / 1 / 1.12 / 1.26`
  （`virlen-mobile/src/theme.css` 的 `:root[data-size]`，取值域在 `src/lib/prefs.ts::SIZE_PREFS`）。
  - 原有三档的**取值名不动**（`s` / `m` / `l`），所以存储里的 `{"size":"l"}` 不需要迁移；
    新增 `xs` / `xl`，真机反馈是「还想再小一点」——旧「小」（0.92→0.90）在长命令 / 长表格前仍偏大，
    而字号不能靠浏览器缩放解决（`zoom` 会把 `position: fixed` 的抽屉与底部面板一起缩）。
  - 中档恒为 1（默认值 + 其余四档的基准）；面板里的「A」预览与文字**竖向叠放**（五列在 360px 屏上
    放不下横排的 A + 两个字，截断的标签比不显示更糟）。
  - 用例：`ui-prefs.test.ts`（含直接读 `theme.css` 比对取值集合 / 递增性 / 中档为 1 —— 少一条 CSS 规则
    就是「点了没反应」）、`settings-sheet-ui.test.ts`（五档逐一点到 DOM + 标签顺序）。
- **编辑电脑上的文件（§37 覆写保存）**：手机端可改工作目录里的**纯文本 / 代码 / Markdown 源码**。
  协议面 = `host.file.write.begin` 带 `overwrite: true` + `expectMtimeMs` / `expectSize`（归 `file.edit` 档）；
  `host.file.read` / `.finish` 的应答各多一个 `mtimeMs`（打开时的版本凭据 / 覆写后的新版本）。
  - ⚠️ **与上传是两条路**：覆写要求目标**已存在**（不新建）、**不做同名改名**（不产生「 - 副本」）、
    必须带版本（不给 → `E_BAD_REQUEST`，于是「盲写」不存在）；版本不符 → `E_CONFLICT`。
    电脑侧**独立**再校一遍可编辑扩展名（`isEditableFileName`）与编辑上限（`FILE_EDIT_MAX_BYTES` = 256KB）。
  - **落盘前再校验一次版本**（`finish`）：begin 与 finish 之间隔着网络，AI 可能正好在这期间写完那个文件。
  - 手机端那三个「存回去就把文件搞坏」的坑全由共享包兜住：**CRLF**（textarea 只有 LF）、
    **BOM**、**非 UTF-8 拒绝编辑**（`decodeUtf8Strict`；宽容解码的乱码存回去就是毁文件）——见 §11.44。
  - 降级：旧电脑端没有 `file.edit` → 手机端只给只读预览（旧电脑端会静默忽略 `overwrite`，
    一次覆盖保存会退化成「另存为 - 副本」，用户以为改了、原文件其实没动）。
  - 落地：电脑侧 `src/bridge/file-source.ts`（覆写分支 + `requireAuthorizedUpload`：授权按**记录自己的写入方式**算）
    + 端口 `file-tauri.ts`（`statFile` / `replaceFile`）；手机端 `store/files.ts`（编辑态 / 保存 / 冲突 / 重新载入）
    + `ui/components/FileSheet.tsx`（编辑区 + 未保存确认 + 冲突两个按钮）。
  - 用例：电脑侧 `src/tests/bridge/phone-files.test.ts`（两档授权独立 / 冲突的两个窗口 / 不改名 / 中途放弃）；
    共享包 `tests/files-edit.test.ts`（换行往返 / BOM / GBK 拒编 / 覆写链路）；
    手机端 `src/tests/files-edit.test.ts`（字节真落到宿主 / CRLF 保留 / 冲突两条选择 / 取消不发 RPC）。
- **引用电脑上的文件（§37 的延伸）**：手机端把讲题里的文件面板里挑中的文件**挂到要发的那条消息上**（入口：文件面板预览头的「引用」按钮）。
  与桌面输入框的「文件附件」（`FileAttachment`）**同一条口径**：只带**路径 + 展示元数据**，不搬运内容 ——
  真正的读取交给 AI 用 `read_file` 按需完成。
  - 协议面：`SendParams.files?: MessageFileRef[]` + `MessageDTO.files?: MessageFileRef[]`（与 §36 的 `quotes` 并列）；
    能力名 `message.file`（`MESSAGE_FILE_CAPABILITY`，**功能标记**不是权限：引用本身就是 `session.send` 的一个参数）。
    电脑侧 `host-source.ts::send` 把两件结构化输入一起交给 `buildUserContent`（块顺序 quote → text → file），
    于是引擎 / 持久化 / 桌面渲染 / 导出与桌面拖一个文件进输入框**完全一致**。
  - ⚠️ **校验口径只有一份**（共享包 `sanitizeFileRefs`，电脑侧与演示宿主共用）：
    形状非法 / 超条数（`MESSAGE_FILE_MAX` = 20）/ 路径过长（`MESSAGE_FILE_PATH_MAX` = 1024）→
    **拒整条**（`E_BAD_REQUEST`，并留痕 `allowed: false`），**不静默丢掉那一条** —— 丢一条时
    手机上 chip 还在、用户以为附上了，而 AI 从未看到（§36 引用那次踩过的坑，见 §11.45-②）。
    `isDir` / `size` 只是展示元数据（形状不对就丢字段）；路径分隔符归一为 `/`；同一路径去重。
  - ⚠️ **文件引用不进 `text`**（与 `quotes` 同一纪律）：电脑侧投影正文时本就会把文件块展平成
    `[文件] <名字>`（§7-⑦，与图片同一套降级规则），两条路同时走会显示两遍 —— 而那个展平占位符
    **只有名字没有路径**（同一目录下两个 `index.ts` 长得一样）。
  - 降级：旧电脑端没有 `message.file` → 手机端**不给「引用」入口**（它会把 `files` 静默丢掉；
    ⚠️ 与只读两项不同，**不能整面板置灰** —— 浏览 / 预览 / 下载 / 编辑都还能用）。
  - 落地：手机端 `ui/components/FileSheet.tsx`（预览头「引用 / 已引用」开关，点完**不关面板**：
    可以接着引用下一个）、`ui/pages/Chat.tsx`（`pendingFiles` + 输入区 chip + 发送带 `files`）、
    `store/chat.ts::send(text, quotes, files)`、`lib/message-rows.ts::rendersNothing`（只附文件的消息
    也必须占行）、`ui/components/FileIcon.tsx`（面板行 / 输入区 chip / 气泡 chip 共用一张图标表）。
  - 用例：电脑侧 `src/tests/bridge/phone-file-refs.test.ts`（投影 / 端到端落块 / 拒整条 + 审计 / 能力声明）；
    共享包 `tests/message-files.test.ts`（校验与归一）；手机端 `src/tests/files-ref.test.ts`
    （纯函数 + 行模型 + 面板→chip→电脑侧收到 + 旧电脑端不显示入口）。
- **依赖形态（2026-10 起）**：`virlen-remote` 在 `virlen-app` 与 `virlen-mobile` 里都是 **`link:../virlen-remote`**（本地仓库 `C:\code\virlen\virlen-remote`）。
  ⚠️ 改完该仓库的 `src` 必须 **`pnpm build`**（`scripts/build.mjs` 生成 `dist`）—— 两端 import 的是 `dist`，不重建就会「源码改了、行为没变」。改协议（方法表 / DTO / 能力名）时两端要一起对齐。
  发版时：把本地改动推回上游仓库 → 按 `prepublishOnly`（`typecheck && test && build`）发版 → 两端依赖改回版本号。
- 测试：`src/tests/bridge/*`（memory transport）与 `src/tests/ui/phone-control-*`。
- **设计文档未落地**：`src/` 内 16 个文件引用 `docs/phone-control-bridge.md` 的 §号（§16.2 / §25 / §27 / §30 …），但该文件不存在；读到时不要当成已有资料。
