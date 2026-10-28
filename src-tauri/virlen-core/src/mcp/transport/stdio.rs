//! stdio 传输 —— 本地子进程 + 行分隔 JSON-RPC。
//!
//! 三件事必须做对（都踩过：
//!
//! 1. **Windows 垫片**：`npx` / `pnpm` / `uvx` 是 `.cmd` 批处理，`CreateProcess` 执行不了 →
//!    `config::resolve_launch` 会包一层 `cmd /C`；GUI 进程还要 `CREATE_NO_WINDOW`，否则每连一次
//!    就闪一个黑框。
//! 2. **环境清洗**：子进程不能拿到父进程的 `*_KEY` / `*_TOKEN` 等（`config::merge_child_env`）。
//! 3. **干净收尸**：用户关掉服务器 / 退出应用时，node 孙进程绝不能留在系统里
//!    （Windows 用 Job Object `KILL_ON_JOB_CLOSE`，其余平台走 `kill_process_tree`）。

use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use serde_json::Value;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command};
use tokio::sync::Mutex as AsyncMutex;

use super::{await_response, Core, Transport, TransportError};
use crate::agent::process_tree::{kill_process_tree, ProcessTreeGuard};
use crate::mcp::config::{merge_child_env, resolve_launch, StdioSpec};
use crate::mcp::jsonrpc::{self, Incoming, LineFramer};

/// stderr 只保留尾部这么多字节（诊断用，绝不进模型上下文）
const STDERR_TAIL_LIMIT: usize = 8 * 1024;

/// 读管道的缓冲区大小（行帧自己会处理「半条消息」）
const READ_CHUNK: usize = 64 * 1024;

/// Windows：创建进程时不弹控制台窗口
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub struct StdioTransport {
    core: Arc<Core>,
    stdin: AsyncMutex<Option<ChildStdin>>,
    /// 子进程 pid（`kill_process_tree` 兜底用；子进程已被 wait 任务接走）
    pid: Option<u32>,
    /// Windows Job Object（KILL_ON_JOB_CLOSE）：应用崩溃也不留孤儿
    guard: Option<ProcessTreeGuard>,
    /// 子进程是否真的进了 Job（进了就不必再 `taskkill`，否则会往控制台喷错误）
    job_assigned: bool,
    stderr_tail: Arc<Mutex<String>>,
    events: Mutex<Option<tokio::sync::mpsc::UnboundedReceiver<Incoming>>>,
}

impl std::fmt::Debug for StdioTransport {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("StdioTransport")
            .field("pid", &self.pid)
            .field("closed", &self.core.is_closed())
            .finish_non_exhaustive()
    }
}

impl StdioTransport {
    /// 起子进程并开始读 stdout / stderr。
    ///
    /// 不在这里握手：`initialize` 由 `Client` 发（传输不认识协议语义）。
    pub async fn spawn(spec: &StdioSpec) -> Result<Arc<Self>, TransportError> {
        // Windows：裸命令会被包成 `cmd /C`，而 cmd 总是启动成功（找不到命令是它的运行时错误）
        // → 先自己找一轮，把「命令写错」变成一条能看懂的错误，而不是「连上了又断开」。
        #[cfg(target_os = "windows")]
        if !spec.command.contains('/')
            && !spec.command.contains('\\')
            && crate::mcp::config::find_in_path(&spec.command).is_none()
        {
            return Err(TransportError::Spawn(format!(
                "找不到命令 \"{}\"（请确认已安装并在 PATH 中，或在配置里填绝对路径）",
                spec.command
            )));
        }

        let (program, args) = resolve_launch(&spec.command, &spec.args);
        let mut command = Command::new(&program);
        command
            .args(&args)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .env_clear()
            .envs(merge_child_env(&spec.env));
        if let Some(cwd) = &spec.cwd {
            command.current_dir(cwd);
        }
        #[cfg(target_os = "windows")]
        command.creation_flags(CREATE_NO_WINDOW);

        let mut child = command.spawn().map_err(|e| {
            TransportError::Spawn(format!(
                "{}（Windows 上 .cmd/.bat 垫片会自动走 cmd /C；仍失败请检查命令与工作目录）：{e}",
                spec.command
            ))
        })?;

        let pid = child.id();
        // KILL_ON_JOB_CLOSE：本进程退出（含崩溃）时内核连带杀光，不必指望清理钩子跑完
        let guard = ProcessTreeGuard::create_kill_on_close();
        // 只有真的进了 Job 才不需要兜底：没进（Job 创建/Assign 失败）就得刷式杀进程树
        let job_assigned = match (guard.as_ref(), pid) {
            (Some(guard), Some(pid)) => guard.assign_pid(pid),
            _ => false,
        };

        let stdin = child.stdin.take();
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();

        let (core, events) = Core::new();
        let stderr_tail = Arc::new(Mutex::new(String::new()));

        tokio::spawn(read_loop(core.clone(), stdout));
        tokio::spawn(stderr_loop(stderr, stderr_tail.clone()));
        tokio::spawn(wait_loop(core.clone(), child));

        Ok(Arc::new(Self {
            core,
            stdin: AsyncMutex::new(stdin),
            pid,
            guard,
            job_assigned,
            stderr_tail,
            events: Mutex::new(Some(events)),
        }))
    }

    /// 子进程 stderr 的尾部（UI 诊断 / 失败原因展示）
    pub fn stderr_tail(&self) -> String {
        self.stderr_tail.lock().map(|s| s.clone()).unwrap_or_default()
    }

    pub fn pid(&self) -> Option<u32> {
        self.pid
    }

    async fn write_line(&self, text: &str) -> Result<(), TransportError> {
        let mut guard = self.stdin.lock().await;
        let Some(stdin) = guard.as_mut() else {
            return Err(TransportError::Closed);
        };
        stdin
            .write_all(text.as_bytes())
            .await
            .map_err(|e| TransportError::Io(format!("写 stdin 失败：{e}")))?;
        stdin
            .flush()
            .await
            .map_err(|e| TransportError::Io(format!("flush stdin 失败：{e}")))?;
        Ok(())
    }
}

#[async_trait]
impl Transport for StdioTransport {
    fn kind(&self) -> &'static str {
        "stdio"
    }

    async fn request(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, TransportError> {
        if self.core.is_closed() {
            return Err(TransportError::Closed);
        }
        let id = self.core.next_id();
        // 先登记再写：服务器可能在我们返回前就把应答写回来
        let receiver = self.core.expect(id);
        self.write_line(&jsonrpc::encode_request(id, method, params))
            .await?;
        await_response(&self.core, id, method, timeout, receiver).await
    }

    async fn notify(&self, method: &str, params: Value) -> Result<(), TransportError> {
        if self.core.is_closed() {
            return Err(TransportError::Closed);
        }
        self.write_line(&jsonrpc::encode_notification(method, params))
            .await
    }

    async fn close(&self) {
        // 1) Job Object：一键杀整棵树（Windows）
        if let Some(guard) = &self.guard {
            guard.terminate();
        }
        // 2) 兜底：递归枚举后代逐个强杀（Job 分配失败 / 非 Windows）。
        //    ⚠️ 只在**真的没进 Job** 时跑：`taskkill` 找不到已终止的 pid 会往控制台喷错误，
        //    而 CLI 的 stderr 是用户可见的输出。
        if !self.job_assigned {
            if let Some(pid) = self.pid {
                // taskkill / kill 都是阻塞调用，丢到阻塞线程池，别堵运行时
                let _ = tokio::task::spawn_blocking(move || kill_process_tree(pid)).await;
            }
        }
        // 3) 关掉 stdin 让服务器读到 EOF（能优雅退出的会自己走）
        self.stdin.lock().await.take();
        self.core.close();
    }

    fn is_closed(&self) -> bool {
        self.core.is_closed()
    }

    async fn wait_closed(&self) {
        self.core.wait_closed().await;
    }

    fn take_events(&self) -> Option<tokio::sync::mpsc::UnboundedReceiver<Incoming>> {
        self.events.lock().ok().and_then(|mut slot| slot.take())
    }

    fn stderr_tail(&self) -> Option<String> {
        Some(StdioTransport::stderr_tail(self))
    }

    async fn reply_error(
        &self,
        id: &Value,
        error: &crate::mcp::jsonrpc::RpcError,
    ) -> Result<(), TransportError> {
        if self.core.is_closed() {
            return Err(TransportError::Closed);
        }
        self.write_line(&jsonrpc::encode_error(id, error)).await
    }
}

// ==================== 后台任务 ====================

/// 读 stdout → 行帧 → 分派。EOF 或协议错误即关闭连接（监督器据此重连）。
async fn read_loop(core: Arc<Core>, stdout: Option<ChildStdout>) {
    let Some(mut stdout) = stdout else {
        eprintln!("[mcp] stdio：拿不到子进程 stdout，连接作废");
        core.close();
        return;
    };
    let mut framer = LineFramer::new();
    let mut buffer = vec![0u8; READ_CHUNK];
    loop {
        match stdout.read(&mut buffer).await {
            Ok(0) => break,
            Ok(read) => match framer.push(&buffer[..read]) {
                Ok(messages) => {
                    for message in messages {
                        core.dispatch(message);
                    }
                }
                Err(e) => {
                    // 协议级错误：继续读只会一直错，直接断开让监督器重连
                    eprintln!("[mcp] stdio 协议错误：{e}");
                    break;
                }
            },
            Err(e) => {
                eprintln!("[mcp] stdio 读取失败：{e}");
                break;
            }
        }
    }
    core.close();
}

/// 读 stderr 到环形缓冲（只保留尾部；不进模型，不进埋点正文）
async fn stderr_loop(stderr: Option<ChildStderr>, tail: Arc<Mutex<String>>) {
    let Some(mut stderr) = stderr else {
        return;
    };
    let mut buffer = vec![0u8; 8 * 1024];
    loop {
        match stderr.read(&mut buffer).await {
            Ok(0) => return,
            Ok(read) => {
                let chunk = String::from_utf8_lossy(&buffer[..read]);
                push_tail(&tail, &chunk);
            }
            Err(_) => return,
        }
    }
}

/// 等子进程退出 → 关连接
async fn wait_loop(core: Arc<Core>, mut child: Child) {
    match child.wait().await {
        Ok(status) => eprintln!("[mcp] 子进程退出：{status}"),
        Err(e) => eprintln!("[mcp] 子进程 wait 失败：{e}"),
    }
    core.close();
}

/// 把新片段追加到尾部缓冲，超过上限按**字符边界**裁掉头部（避免切出半个 UTF-8）。
fn push_tail(tail: &Mutex<String>, chunk: &str) {
    let Ok(mut guard) = tail.lock() else {
        return;
    };
    guard.push_str(chunk);
    if guard.len() <= STDERR_TAIL_LIMIT {
        return;
    }
    let text = guard.as_str();
    let mut cut = text.len() - STDERR_TAIL_LIMIT;
    while cut < text.len() && !text.is_char_boundary(cut) {
        cut += 1;
    }
    *guard = text[cut..].to_string();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stderr_tail_keeps_only_the_tail() {
        let tail = Mutex::new(String::new());
        push_tail(&tail, "hello ");
        push_tail(&tail, "world");
        assert_eq!(tail.lock().unwrap().as_str(), "hello world");
    }

    #[test]
    fn stderr_tail_truncates_on_char_boundary() {
        let tail = Mutex::new(String::new());
        // 每个汉字 3 字节：塞满后裁头部不能切出半个字符
        let chunk = "中".repeat(STDERR_TAIL_LIMIT);
        push_tail(&tail, &chunk);
        let text = tail.lock().unwrap().clone();
        assert!(text.len() <= STDERR_TAIL_LIMIT, "尾部缓冲超限：{}", text.len());
        assert!(!text.is_empty());
        // 能正常转成 &str 就说明没有切坏（String 本身保证 UTF-8，这里断言首字符完整）
        assert!(text.starts_with('中'));
    }
}
