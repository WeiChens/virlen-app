//! ConPTY（伪控制台）封装 —— 把 `execute_command` 的 stdio 从匿名管道换成伪控制台。
//!
//! 权威依据：`docs/pty-research.md` §5（实现要点）与 §8.0（本机 Spike 实测结论）。
//! 下面每条「为什么这么写」都已在 `conpty_spike.rs` 里实测验证过：
//!
//!   1. 通信管道必须是**同步** I/O（挂 `OVERLAPPED` 会让 `CreatePseudoConsole` 失败）；
//!   2. `PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE` 传「句柄值本身」，与 `JOB_LIST` 的
//!      「句柄数组指针」语义不同（见 `spawn.rs::ProcThreadAttributeList::set_pseudoconsole`）；
//!   3. 子进程必须设 `STARTF_USESTDHANDLES` 且三个句柄置 NULL，否则会继承父进程 std 句柄
//!      （见 `spawn.rs::create_process_pty_core`）；
//!   4. 关停顺序：**杀进程树 → 关伪控制台 → 读线程收到 EOF**。
//!      ⚠️ 伪控制台的输出管道在 `ClosePseudoConsole` 之后才断开，所以「等 EOF 再关」会死等；
//!      正确顺序是「先关伪控制台，读线程仍在排空，随后自然收 EOF」（Spike 实测 3.6–14.7ms）。

use std::fs::File;
use std::os::windows::io::{FromRawHandle, RawHandle};

use anyhow::{anyhow, Result};
use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, HANDLE};
use windows_sys::Win32::System::Console::{
    ClosePseudoConsole, CreatePseudoConsole, ResizePseudoConsole, COORD, HPCON,
};
use windows_sys::Win32::System::Pipes::CreatePipe;

/// 伪控制台默认列数。
///
/// 取较大值是为了**减少硬换行**：伪控制台会按列宽把长行折行，折出来的换行会进入
/// 模型可见文本（`\x1b[87X` 这类擦除序列也由列宽决定）。240 列足以覆盖绝大多数单行输出。
pub const DEFAULT_COLS: i16 = 240;

/// 伪控制台默认行数（同步影响 `ResizePseudoConsole` 的初始值）。
pub const DEFAULT_ROWS: i16 = 50;

/// 建一条**同步**匿名管道（ConPTY 只接受同步 I/O，不接受 `OVERLAPPED`）。
///
/// `lpPipeAttributes = NULL` → 句柄不可继承，安全描述符取自**当前进程**默认 DACL。
/// 与官方 ConPTY 示例一致；子进程并不直接继承这些句柄，而是通过
/// `PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE` 拿到伪控制台。
fn create_sync_pipe() -> Result<(HANDLE, HANDLE)> {
    let mut read: HANDLE = std::ptr::null_mut();
    let mut write: HANDLE = std::ptr::null_mut();
    // SAFETY: 两个 out 参数均为有效栈变量。
    let ok = unsafe { CreatePipe(&mut read, &mut write, std::ptr::null_mut(), 0) };
    if ok == 0 {
        return Err(anyhow!("CreatePipe failed: {}", unsafe { GetLastError() }));
    }
    Ok((read, write))
}

/// 一个伪控制台会话：持有 `HPCON` 与两条通信通道。
///
/// 生命周期（§5.1）：
///   1. `create()` 建管道 + 伪控制台，并**立刻关掉父进程手里的**
///      `inputReadSide` / `outputWriteSide`（降低设备对象引用计数，让 I/O 能正确检测通道断开）；
///   2. 长期持有 `input`（写 → 把用户/AI 的输入送进伪控制台）
///      与 `output`（读 → 收 VT 渲染输出）；
///   3. `close()` 关伪控制台，读线程随即收到 EOF。
pub struct PseudoConsole {
    hpc: HPCON,
    /// inputWriteSide：向伪控制台写输入。
    input: Option<File>,
    /// outputReadSide：从伪控制台读 VT 输出。
    output: Option<File>,
}

// HPCON（isize）与 File 都是 Send，伪控制台会话可安全跨 await / 跨线程持有。
unsafe impl Send for PseudoConsole {}

impl PseudoConsole {
    /// 建会话：管道 → 伪控制台 → 关掉父进程不该持有的两个端点。
    pub fn create(cols: i16, rows: i16) -> Result<Self> {
        let (in_read, in_write) = create_sync_pipe()?;
        let (out_read, out_write) = create_sync_pipe()?;

        let mut hpc: HPCON = 0;
        // SAFETY: 传入的是「输入的读端」与「输出的写端」，与官方示例一致。
        let hr = unsafe {
            CreatePseudoConsole(
                COORD {
                    X: cols.max(1),
                    Y: rows.max(1),
                },
                in_read,
                out_write,
                0, // dwFlags = 0：故意不使用 PSEUDOCONSOLE_INHERIT_CURSOR（会引入游标查询死锁）
                &mut hpc,
            )
        };
        if hr < 0 {
            // SAFETY: 四个句柄均由上面两次 CreatePipe 成功创建。
            unsafe {
                CloseHandle(in_read);
                CloseHandle(in_write);
                CloseHandle(out_read);
                CloseHandle(out_write);
            }
            return Err(anyhow!(
                "CreatePseudoConsole failed: HRESULT 0x{:08X}",
                hr as u32
            ));
        }

        // 官方要求：创建子进程后父进程立刻关掉这两个，只保留 in_write / out_read。
        // SAFETY: 句柄有效且尚未被关闭。
        unsafe {
            CloseHandle(in_read);
            CloseHandle(out_write);
        }

        Ok(Self {
            hpc,
            // SAFETY: 两个句柄刚创建、有效且未被关闭；所有权自此交给 File。
            input: Some(unsafe { File::from_raw_handle(in_write as RawHandle) }),
            output: Some(unsafe { File::from_raw_handle(out_read as RawHandle) }),
        })
    }

    /// 原始 `HPCON`（用于挂 `PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE`）。
    pub fn raw_hpc(&self) -> HPCON {
        self.hpc
    }

    /// 取走输入写端（交给 PTY 会话注册表，供 `pty_write` 使用）。
    pub fn take_input(&mut self) -> Option<File> {
        self.input.take()
    }

    /// 取走输出读端（交给阻塞读线程）。
    pub fn take_output(&mut self) -> Option<File> {
        self.output.take()
    }

    /// 调整伪控制台尺寸（返回是否成功，即 `S_OK`）。
    ///
    /// 实例 API；运行期的实际入口是自由函数 `resize_raw`（PTY 会话注册表只持有 `HPCON` 副本）。
    #[allow(dead_code)]
    pub fn resize(&self, cols: i16, rows: i16) -> bool {
        if self.hpc == 0 {
            return false;
        }
        // SAFETY: hpc 有效且会话尚未关闭（close 后 hpc 被置 0 并提前返回）。
        unsafe {
            ResizePseudoConsole(
                self.hpc,
                COORD {
                    X: cols.max(1),
                    Y: rows.max(1),
                },
            ) >= 0
        }
    }

    /// 关闭伪控制台（幂等）。
    ///
    /// ⚠️ `ClosePseudoConsole` 会终止所有附着在伪控制台上的字符模式应用及其进程树，因此调用前
    /// 必须先把该杀的东西杀掉、把该收的输出收完（§5.5 / §5.6）。调用后输出管道断开，读线程
    /// 会自然收到 EOF。
    pub fn close(&mut self) {
        if self.hpc != 0 {
            let h = self.hpc;
            self.hpc = 0;
            // SAFETY: h 是本会话创建的唯一 HPCON，且只关闭一次（置 0 保证幂等）。
            unsafe { ClosePseudoConsole(h) };
        }
        // 通信通道留给 File 的 Drop 关闭（顺序上应在读过 EOF 之后）。
    }
}

impl Drop for PseudoConsole {
    fn drop(&mut self) {
        // 兜底：忘记显式 close 时也要释放伪控制台，避免句柄泄漏。
        self.close();
    }
}

/// 按原始 `HPCON` 调整尺寸 —— 供 `pty_session` 在命令运行中响应前端 `pty_resize`。
///
/// ⚠️ 调用方必须保证会话尚未关闭：`HPCON` 是裸句柄，关闭后再用属于未定义行为。`pty_session`
/// 的注销流程是「先移除表项 → 再关伪控制台」，因此不会命中这种情况。
pub fn resize_raw(hpc: HPCON, cols: i16, rows: i16) -> bool {
    if hpc == 0 {
        return false;
    }
    // SAFETY: 句柄由调用方保证仍然有效（会话未关闭）。
    unsafe {
        ResizePseudoConsole(
            hpc,
            COORD {
                X: cols.max(1),
                Y: rows.max(1),
            },
        ) >= 0
    }
}
