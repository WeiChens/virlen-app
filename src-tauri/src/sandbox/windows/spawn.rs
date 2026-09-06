//! 以受限令牌拉起子进程（对应 codex process.rs）。
//!
//! 二改自 sandbox-win：
//!   1. stdout/stderr 改为匿名管道（读端回传上层做流式推送），不再继承父 stdio；
//!   2. 支持 `raw_cmdline` 原样透传（cmd /s /c 嵌套引号不被 CRT 引号撕碎）；
//!   3. 进程放入 Job Object（KILL_ON_JOB_CLOSE + 超时/取消整树终止），
//!      并在创建时经 PROC_THREAD_ATTRIBUTE_JOB_LIST 原子挂入（无竞态）。

use std::collections::BTreeMap;
use std::ffi::c_void;
use std::mem;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::{FromRawHandle, RawHandle};
use std::path::Path;

use anyhow::{anyhow, Context, Result};
use windows_sys::Win32::Foundation::{
    CloseHandle, GetLastError, HANDLE, HANDLE_FLAG_INHERIT, INVALID_HANDLE_VALUE,
    SetHandleInformation,
};
use windows_sys::Win32::Security::SECURITY_ATTRIBUTES;
use windows_sys::Win32::System::JobObjects::{
    CreateJobObjectW, JobObjectExtendedLimitInformation, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, SetInformationJobObject, TerminateJobObject,
};
use windows_sys::Win32::System::Pipes::CreatePipe;
use windows_sys::Win32::System::Threading::{
    CreateProcessAsUserW, DeleteProcThreadAttributeList, EXTENDED_STARTUPINFO_PRESENT,
    GetExitCodeProcess, InitializeProcThreadAttributeList, LPPROC_THREAD_ATTRIBUTE_LIST,
    PROCESS_INFORMATION, STARTF_USESTDHANDLES, STARTUPINFOEXW, STARTUPINFOW,
    UpdateProcThreadAttribute, WaitForSingleObject, INFINITE,
};
use windows_sys::Win32::System::Console::GetStdHandle;
use windows_sys::Win32::System::Console::{STD_ERROR_HANDLE, STD_OUTPUT_HANDLE};
use windows_sys::Win32::System::Threading::CREATE_UNICODE_ENVIRONMENT;

/// 生成 UTF-16 以 0 结尾字符串。
pub fn to_wide(s: impl AsRef<std::ffi::OsStr>) -> Vec<u16> {
    let mut v: Vec<u16> = s.as_ref().encode_wide().collect();
    v.push(0);
    v
}

/// CRT/CommandLineToArgvW 风格的单参数引用。
pub fn quote_windows_arg(arg: &str) -> String {
    let needs_quotes = arg.is_empty()
        || arg
            .chars()
            .any(|c| matches!(c, ' ' | '\t' | '\n' | '\r' | '"'));
    if !needs_quotes {
        return arg.to_string();
    }
    let mut quoted = String::with_capacity(arg.len() + 2);
    quoted.push('"');
    let mut backslashes = 0;
    for ch in arg.chars() {
        match ch {
            '\\' => backslashes += 1,
            '"' => {
                quoted.push_str(&"\\".repeat(backslashes * 2 + 1));
                quoted.push('"');
                backslashes = 0;
            }
            _ => {
                if backslashes > 0 {
                    quoted.push_str(&"\\".repeat(backslashes));
                    backslashes = 0;
                }
                quoted.push(ch);
            }
        }
    }
    if backslashes > 0 {
        quoted.push_str(&"\\".repeat(backslashes * 2));
    }
    quoted.push('"');
    quoted
}

pub fn argv_to_command_line(argv: &[String]) -> String {
    argv.iter()
        .map(|arg| quote_windows_arg(arg))
        .collect::<Vec<_>>()
        .join(" ")
}

/// 构造环境块（排序、以 0 结尾、双 0 结尾）。
pub fn make_env_block(env: &BTreeMap<String, String>) -> Vec<u16> {
    let mut items: Vec<(String, String)> =
        env.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
    items.sort_by(|a, b| {
        a.0.to_uppercase()
            .cmp(&b.0.to_uppercase())
            .then(a.0.cmp(&b.0))
    });
    let mut w: Vec<u16> = Vec::new();
    for (k, v) in items {
        let mut s = to_wide(&format!("{k}={v}"));
        s.pop(); // 去掉结尾 0，再加一个作为条目分隔
        w.extend_from_slice(&s);
        w.push(0);
    }
    w.push(0);
    w
}

/// 收集当前进程环境变量。
pub fn current_env() -> BTreeMap<String, String> {
    std::env::vars().collect()
}

/// PROC_THREAD_ATTRIBUTE_JOB_LIST：在进程创建时原子挂入 Job Object。
const PROC_THREAD_ATTRIBUTE_JOB_LIST: usize = 0x0002_000D;

/// 持有由 `InitializeProcThreadAttributeList` 分配/初始化的属性列表缓冲区。
struct ProcThreadAttributeList {
    buffer: Vec<u8>,
    job_list: Vec<HANDLE>,
}

impl ProcThreadAttributeList {
    fn new(attr_count: u32) -> Result<Self> {
        let mut size: usize = 0;
        // SAFETY: 第一次调用仅查询所需缓冲区大小（list 传 NULL 合法）。
        let _ = unsafe {
            InitializeProcThreadAttributeList(std::ptr::null_mut(), attr_count, 0, &mut size)
        };
        if size == 0 {
            return Err(anyhow!(
                "InitializeProcThreadAttributeList size query failed: {}",
                unsafe { GetLastError() }
            ));
        }
        let mut buffer = vec![0u8; size];
        let list = buffer.as_mut_ptr() as LPPROC_THREAD_ATTRIBUTE_LIST;
        let ok = unsafe { InitializeProcThreadAttributeList(list, attr_count, 0, &mut size) };
        if ok == 0 {
            return Err(anyhow!(
                "InitializeProcThreadAttributeList failed: {}",
                unsafe { GetLastError() }
            ));
        }
        Ok(Self {
            buffer,
            job_list: Vec::new(),
        })
    }

    fn as_mut_ptr(&mut self) -> LPPROC_THREAD_ATTRIBUTE_LIST {
        self.buffer.as_mut_ptr() as LPPROC_THREAD_ATTRIBUTE_LIST
    }

    fn set_job(&mut self, job: HANDLE) -> Result<()> {
        self.job_list = vec![job];
        let value = self.job_list.as_mut_ptr().cast();
        let size = std::mem::size_of_val(self.job_list.as_slice());
        // SAFETY: value 指向 self.job_list，size 覆盖该切片；属性列表在调用期间存活。
        let ok = unsafe {
            UpdateProcThreadAttribute(
                self.as_mut_ptr(),
                0,
                PROC_THREAD_ATTRIBUTE_JOB_LIST,
                value,
                size,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            )
        };
        if ok == 0 {
            return Err(anyhow!(
                "UpdateProcThreadAttribute(PROC_THREAD_ATTRIBUTE_JOB_LIST) failed: {}",
                unsafe { GetLastError() }
            ));
        }
        Ok(())
    }
}

impl Drop for ProcThreadAttributeList {
    fn drop(&mut self) {
        // SAFETY: buffer 由 InitializeProcThreadAttributeList 初始化。
        unsafe {
            DeleteProcThreadAttributeList(self.as_mut_ptr());
        }
    }
}

pub struct Job {
    handle: HANDLE,
}

impl Job {
    /// 创建 Job，设置 KILL_ON_JOB_CLOSE（句柄关闭时整树结束，防止逃逸进程残留）。
    pub fn create() -> Result<Self> {
        // SAFETY: 以 NULL 名称创建 Job。
        let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if handle.is_null() || handle == INVALID_HANDLE_VALUE {
            return Err(anyhow!(
                "CreateJobObjectW failed: {}",
                unsafe { GetLastError() }
            ));
        }
        // SAFETY: handle 有效。
        unsafe {
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let ok = SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                &mut info as *mut _ as *mut c_void,
                mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );
            if ok == 0 {
                CloseHandle(handle);
                return Err(anyhow!("SetInformationJobObject failed: {}", GetLastError()));
            }
        }
        Ok(Self { handle })
    }

    pub fn terminate(&self) {
        // SAFETY: handle 有效。
        unsafe {
            TerminateJobObject(self.handle, 1);
        }
    }

    pub fn raw_handle(&self) -> HANDLE {
        self.handle
    }
}

impl Drop for Job {
    fn drop(&mut self) {
        // SAFETY: handle 有效；关闭触发 KILL_ON_JOB_CLOSE。
        unsafe {
            CloseHandle(self.handle);
        }
    }
}

// HANDLE 只是不透明内核句柄，跨线程终止/关闭是安全的。
unsafe impl Send for Job {}
unsafe impl Sync for Job {}

/// 进程句柄包装（Send/Sync），Drop 时关闭句柄。
pub struct ProcessHandle(HANDLE);

// HANDLE 只是不透明内核句柄，跨线程等待/关闭是安全的。
unsafe impl Send for ProcessHandle {}
unsafe impl Sync for ProcessHandle {}

impl ProcessHandle {
    /// 阻塞等待进程退出并读取退出码（调用方在 spawn_blocking 中调用）。
    pub fn wait_and_read_exit_code(&self) -> Option<i32> {
        // SAFETY: self.0 有效。
        unsafe {
            WaitForSingleObject(self.0, INFINITE);
            let mut code: u32 = 0;
            if GetExitCodeProcess(self.0, &mut code) == 0 {
                None
            } else {
                Some(code as i32)
            }
        }
    }

    #[allow(dead_code)]
    pub fn raw(&self) -> HANDLE {
        self.0
    }
}

impl Drop for ProcessHandle {
    fn drop(&mut self) {
        // SAFETY: self.0 有效。
        unsafe {
            if !self.0.is_null() && self.0 != INVALID_HANDLE_VALUE {
                CloseHandle(self.0);
            }
        }
    }
}

/// 沙盒化子进程句柄集合。stdout/stderr 为匿名管道读端，供上层流式读取。
pub struct SandboxChild {
    pub pid: u32,
    pub stdout: Option<std::fs::File>,
    pub stderr: Option<std::fs::File>,
    process: ProcessHandle,
    job: Job,
}

impl SandboxChild {
    pub fn pid(&self) -> u32 {
        self.pid
    }

    /// 终止整棵进程树（Job Object 一键全杀）。
    pub fn terminate(&self) {
        self.job.terminate();
    }

    /// 阻塞等待进程退出并读取退出码。
    pub fn wait_and_read_exit_code(&self) -> Option<i32> {
        self.process.wait_and_read_exit_code()
    }

    /// 读取当前退出码（不等待）。
    #[allow(dead_code)]
    pub fn read_exit_code(&self) -> Option<i32> {
        let mut code: u32 = 0;
        // SAFETY: process 有效。
        let ok = unsafe { GetExitCodeProcess(self.process.raw(), &mut code) };
        if ok == 0 {
            None
        } else {
            Some(code as i32)
        }
    }
}

/// 创建一对匿名管道，返回 (读端, 写端)。写端可继承，读端不可继承。
unsafe fn create_inheritable_pipe() -> Result<(HANDLE, HANDLE)> {
    let mut sa = SECURITY_ATTRIBUTES {
        nLength: mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: std::ptr::null_mut(),
        bInheritHandle: 1,
    };
    let mut read: HANDLE = std::ptr::null_mut();
    let mut write: HANDLE = std::ptr::null_mut();
    let ok = CreatePipe(&mut read, &mut write, &mut sa, 0);
    if ok == 0 {
        return Err(anyhow!("CreatePipe failed: {}", GetLastError()));
    }
    // 读端不继承，仅父进程持有。
    SetHandleInformation(read, HANDLE_FLAG_INHERIT, 0);
    Ok((read, write))
}

/// 以受限令牌创建进程，stdio 走匿名管道并进入 Job Object。
///
/// `command`：argv（用于 powershell/sh 等，走 CRT 引号拼接）。
/// `raw_cmdline`：若为 Some，则直接作为 lpCommandLine 原样使用（用于 cmd 嵌套引号透传）。
/// `lpDesktop` 显式指定为 `Winsta0\Default`（与 codex 一致），避免受限令牌下
/// 部分进程（如 PowerShell）出现 STATUS_DLL_INIT_FAILED。
#[allow(clippy::too_many_arguments)]
pub fn create_sandboxed_process(
    h_token: HANDLE,
    command: &[String],
    raw_cmdline: Option<&str>,
    cwd: &Path,
    env: &BTreeMap<String, String>,
    desktop: &str,
) -> Result<SandboxChild> {
    let cmdline_str = match raw_cmdline {
        Some(raw) => raw.to_string(),
        None => argv_to_command_line(command),
    };
    let mut cmdline: Vec<u16> = to_wide(&cmdline_str);
    let mut env_block = make_env_block(env);
    let mut cwd_wide = to_wide(cwd.to_string_lossy().as_ref());
    let mut desktop_wide = to_wide(desktop);

    let job = Job::create().context("create job object")?;

    // 进程创建即入 Job：若系统无法满足（如父 Job 禁止嵌套），让 spawn 失败，
    // 而不是短暂运行一个未被包含的沙盒进程树。
    let mut attr_list =
        ProcThreadAttributeList::new(1).context("alloc proc thread attribute list")?;
    attr_list.set_job(job.raw_handle()).context("set job attribute")?;

    // stdout/stderr 匿名管道。
    let (stdout_read, stdout_write) = unsafe { create_inheritable_pipe() }?;
    let (stderr_read, stderr_write) = unsafe { create_inheritable_pipe() }?;

    // SAFETY: STARTUPINFOEXW 初始化后传给系统调用；attr_list 在调用期间保持存活。
    unsafe {
        let mut si: STARTUPINFOEXW = mem::zeroed();
        si.StartupInfo.cb = mem::size_of::<STARTUPINFOEXW>() as u32;
        si.StartupInfo.lpDesktop = desktop_wide.as_mut_ptr();
        si.StartupInfo.dwFlags |= STARTF_USESTDHANDLES;
        // stdin 无输入（与 GUI 宿主一致）；stdout/stderr 接到管道写端。
        si.StartupInfo.hStdInput = std::ptr::null_mut();
        si.StartupInfo.hStdOutput = stdout_write;
        si.StartupInfo.hStdError = stderr_write;
        si.lpAttributeList = attr_list.as_mut_ptr();

        let mut pi: PROCESS_INFORMATION = mem::zeroed();
        let ok = CreateProcessAsUserW(
            h_token,
            std::ptr::null(),
            cmdline.as_mut_ptr(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            1, // bInheritHandles
            CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT,
            env_block.as_mut_ptr() as *mut c_void,
            cwd_wide.as_mut_ptr(),
            &si.StartupInfo,
            &mut pi,
        );
        if ok == 0 {
            let err = GetLastError();
            // 失败时清理管道写端。
            CloseHandle(stdout_write);
            CloseHandle(stderr_write);
            CloseHandle(stdout_read);
            CloseHandle(stderr_read);
            return Err(anyhow!(
                "CreateProcessAsUserW failed: {} | cwd={} | cmd={}",
                err,
                cwd.display(),
                cmdline_str
            ));
        }

        let pid = pi.dwProcessId;
        // 线程句柄无需保留。
        CloseHandle(pi.hThread);
        // 父进程关闭写端，读端才能收到 EOF。
        CloseHandle(stdout_write);
        CloseHandle(stderr_write);

        let stdout_file = std::fs::File::from_raw_handle(stdout_read as RawHandle);
        let stderr_file = std::fs::File::from_raw_handle(stderr_read as RawHandle);

        Ok(SandboxChild {
            process: ProcessHandle(pi.hProcess),
            job,
            stdout: Some(stdout_file),
            stderr: Some(stderr_file),
            pid,
        })
    }
}

/// 确保当前进程 std 句柄可继承（保留给未来 ConPTY/继承模式使用）。
#[allow(dead_code)]
unsafe fn setup_inherited_stdio(si: &mut STARTUPINFOW) -> Result<()> {
    for kind in [STD_OUTPUT_HANDLE, STD_ERROR_HANDLE] {
        let h = GetStdHandle(kind);
        if h.is_null() || h == INVALID_HANDLE_VALUE {
            return Err(anyhow!("GetStdHandle({kind}) failed: {}", GetLastError()));
        }
        if SetHandleInformation(h, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT) == 0 {
            return Err(anyhow!("SetHandleInformation failed: {}", GetLastError()));
        }
    }
    si.dwFlags |= STARTF_USESTDHANDLES;
    si.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
    si.hStdError = GetStdHandle(STD_ERROR_HANDLE);
    Ok(())
}
