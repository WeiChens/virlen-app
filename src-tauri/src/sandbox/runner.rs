//! 编排：把「命令 + cwd + 可写根 + 保护路径」变成一个沙盒化执行会话。
//!
//! 对应 codex spawn_prep.rs / unified_exec 免提权路径。二改点：拆成
//! `prepare`（算根、应用 ACL、建受限令牌）+ `spawn`（拉起进程），以便上层
//! 在 async 环境里分别接入流式读取 / 超时 / 取消。

use std::collections::BTreeMap;
use std::collections::BTreeSet;
use std::ffi::c_void;
use std::path::Path;
use std::path::PathBuf;

use anyhow::{bail, Context, Result};
use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};

use crate::sandbox::acl::{add_deny_write_ace, allow_null_device, ensure_allow_write_aces};
use crate::sandbox::cap;
use crate::sandbox::paths::{canonicalize_path, root_contains_path};
use crate::sandbox::spawn::{create_sandboxed_process, current_env, SandboxChild};
use crate::sandbox::state::SandboxState;
use crate::sandbox::token::{create_write_restricted_token_with_caps, LocalSid};
use crate::sandbox::{DEFAULT_PROTECTED_SUBDIRS, INTERACTIVE_DESKTOP};

/// 一次沙盒执行的请求描述。
#[derive(Debug, Clone)]
pub struct SandboxRequest {
    /// 命令工作目录 = 主可写根。
    pub cwd: PathBuf,
    /// 附加可写根。
    pub extra_roots: Vec<PathBuf>,
    /// 附加 deny-write 绝对路径（不存在则创建，防止沙盒先写再被保护）。
    pub protect: Vec<PathBuf>,
    /// 只读模式：不授予任何写根能力 SID。
    pub readonly: bool,
}

struct Prepared {
    /// 规范化的命令 cwd（也是主可写根）
    cwd: PathBuf,
    /// (规范化的可写根, 能力 SID 字符串)，readonly 模式为空
    write_roots: Vec<(PathBuf, String)>,
    /// 需要加 deny-write 的路径
    deny_paths: Vec<PathBuf>,
    /// readonly 模式使用的只读能力 SID
    readonly_sid: Option<String>,
}

/// 已准备就绪的沙盒会话：持有受限令牌句柄，可反复 spawn 子进程。
pub struct SandboxSession {
    /// 规范化的命令 cwd
    pub cwd: PathBuf,
    /// 是否只读模式
    pub readonly: bool,
    h_token: HANDLE,
}

impl Drop for SandboxSession {
    fn drop(&mut self) {
        // SAFETY: h_token 由 CreateRestrictedToken 创建。
        unsafe {
            if !self.h_token.is_null() {
                CloseHandle(self.h_token);
            }
        }
    }
}

// HANDLE（受限令牌）只在 prepare/spawn（同步）与 Drop（CloseHandle，线程安全）中使用，
// 标记 Send/Sync 以便沙盒会话可安全跨 await 持有。
unsafe impl Send for SandboxSession {}
unsafe impl Sync for SandboxSession {}

impl SandboxSession {
    /// 解析路径、应用 ACL、构建受限令牌。失败返回 Err（上层据此降级裸跑）。
    pub fn prepare(req: &SandboxRequest, state: &SandboxState) -> Result<Self> {
        let prepared = prepare_paths(req, state)?;
        let readonly_mode = prepared.readonly_sid.is_some();

        if readonly_mode {
            // 只读模式同样走受限令牌，restricting SIDs = [readonly cap, logon, everyone]，
            // 但没有任何 ACL 授予 readonly cap 写权限。
            let sid = LocalSid::from_string(prepared.readonly_sid.as_deref().unwrap())?;
            allow_null_device(sid.as_ptr());
            let h_token =
                unsafe { create_write_restricted_token_with_caps(&[sid.as_ptr()]) }
                    .context("create restricted token")?;
            return Ok(Self {
                cwd: prepared.cwd,
                readonly: true,
                h_token,
            });
        }

        // ---- write 模式：逐个根生成 LocalSid（顺序与 prepared.write_roots 一致）----
        let mut roots: Vec<(PathBuf, LocalSid)> = Vec::with_capacity(prepared.write_roots.len());
        for (root, sid_str) in &prepared.write_roots {
            roots.push((root.clone(), LocalSid::from_string(sid_str)?));
        }

        // 应用 Allow-Write ACE。第 0 个根是 cwd（主写根，失败则整体降级）；其余为 extra root，
        // 采用 best-effort：无法改 ACL（如系统目录、无 WRITE_DAC）时跳过，不拖垮整个沙盒。
        let mut active: Vec<usize> = Vec::new();
        for (i, (root, sid)) in roots.iter().enumerate() {
            match ensure_allow_write_aces(root, sid.as_ptr()) {
                Ok(_) => active.push(i),
                Err(e) if i > 0 => {
                    eprintln!(
                        "[sandbox] skip extra root {} (grant write ACE failed): {e:#}",
                        root.display()
                    );
                }
                Err(e) => {
                    return Err(e)
                        .with_context(|| format!("grant write ACE on {}", root.display()));
                }
            }
        }

        // 重建过滤后的 (root, sid 字符串) 与 sid_ptrs：deny / token 只针对 active 的根。
        let active_roots: Vec<(PathBuf, String)> = active
            .iter()
            .map(|&i| prepared.write_roots[i].clone())
            .collect();
        let sid_ptrs: Vec<*mut c_void> = active.iter().map(|&i| roots[i].1.as_ptr()).collect();

        // deny-write ACE（基于 active 的根）
        for deny_path in &prepared.deny_paths {
            let targets = overlapping_roots(deny_path, &active_roots);
            let local_idx: Vec<usize> = active_roots
                .iter()
                .enumerate()
                .filter(|(_, (_, s))| targets.contains(&s.as_str()))
                .map(|(i, _)| i)
                .collect();
            for i in local_idx {
                add_deny_write_ace(deny_path, sid_ptrs[i])
                    .with_context(|| format!("deny write ACE on {}", deny_path.display()))?;
            }
        }
        for psid in &sid_ptrs {
            allow_null_device(*psid);
        }

        let h_token =
            unsafe { create_write_restricted_token_with_caps(&sid_ptrs) }
                .context("create restricted token")?;

        Ok(Self {
            cwd: prepared.cwd,
            readonly: false,
            h_token,
        })
    }

    /// 以受限令牌拉起子进程。`raw_cmdline` 为 Some 时原样透传（cmd 路径）。
    pub fn spawn(
        &self,
        command: &[String],
        raw_cmdline: Option<&str>,
        env_extra: &BTreeMap<String, String>,
    ) -> Result<SandboxChild> {
        let mut env = current_env();
        for (k, v) in env_extra {
            env.insert(k.clone(), v.clone());
        }
        create_sandboxed_process(
            self.h_token,
            command,
            raw_cmdline,
            &self.cwd,
            &env,
            INTERACTIVE_DESKTOP,
        )
    }
}

fn prepare_paths(req: &SandboxRequest, state: &SandboxState) -> Result<Prepared> {
    // 1) 主 cwd 必须存在且为目录
    let cwd = dunce::canonicalize(&req.cwd).with_context(|| {
        format!(
            "cwd {} does not exist or cannot be canonicalized",
            req.cwd.display()
        )
    })?;
    if !cwd.is_dir() {
        bail!("cwd is not a directory: {}", cwd.display());
    }

    // 2) 收集可写根（去重）
    let mut root_keys: BTreeSet<String> = BTreeSet::new();
    let mut roots: Vec<PathBuf> = Vec::new();
    let mut push_root = |p: PathBuf| {
        let key = crate::sandbox::paths::canonical_path_key(&p);
        if root_keys.insert(key) {
            roots.push(p);
        }
    };
    push_root(cwd.clone());
    for extra in &req.extra_roots {
        let canon = dunce::canonicalize(extra)
            .with_context(|| format!("extra root {} does not exist", extra.display()))?;
        if !canon.is_dir() {
            bail!("extra root is not a directory: {}", canon.display());
        }
        push_root(canon);
    }

    // 3) deny-write 集合
    let mut deny_paths: BTreeSet<PathBuf> = BTreeSet::new();
    for root in &roots {
        for name in DEFAULT_PROTECTED_SUBDIRS {
            let candidate = root.join(name);
            if candidate.exists() {
                deny_paths.insert(canonicalize_path(&candidate));
            }
        }
    }
    for p in &req.protect {
        if !p.exists() {
            // 显式保护路径必须先存在，否则沙盒可先写文件再被保护。
            std::fs::create_dir_all(p)
                .with_context(|| format!("create protect path {}", p.display()))?;
        }
        deny_paths.insert(canonicalize_path(p));
    }

    if req.readonly {
        if !req.extra_roots.is_empty() {
            bail!("readonly mode cannot combine with extra roots");
        }
        return Ok(Prepared {
            cwd: cwd.clone(),
            write_roots: Vec::new(),
            deny_paths: deny_paths.into_iter().collect(),
            readonly_sid: Some(cap::readonly_cap_sid(&state.state_dir)?),
        });
    }

    // 4) 生成每个写根的能力 SID
    let caps = cap::write_root_capability_sids(&state.state_dir, &cwd, &roots)?;
    if caps.is_empty() {
        bail!("no writable roots were configured");
    }
    Ok(Prepared {
        cwd: cwd.clone(),
        write_roots: caps,
        deny_paths: deny_paths.into_iter().collect(),
        readonly_sid: None,
    })
}

/// deny 路径需要拒绝的能力 SID：命中某根 → 拒重叠根；不在任何根内 → 拒全部根。
fn overlapping_roots<'a>(path: &Path, roots: &'a [(PathBuf, String)]) -> Vec<&'a str> {
    let hit: Vec<&str> = roots
        .iter()
        .filter(|(root, _)| root_contains_path(root, path))
        .map(|(_, sid)| sid.as_str())
        .collect();
    if hit.is_empty() {
        roots.iter().map(|(_, sid)| sid.as_str()).collect()
    } else {
        hit
    }
}
