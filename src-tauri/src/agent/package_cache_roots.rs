//! 包管理器缓存目录自动豁免（terminal 沙箱的可写根扩展）。
//!
//! 背景（研究结论）：npm/pnpm/cargo 等安装命令都是「先写用户级缓存目录，再复制到
//! 项目 node_modules」。缓存目录在 workspace 之外，默认写隔离会拦截——表现为
//! `npm install` 报 EACCES/EPERM mkdir '~/.npm/_cacache/...'。
//!
//! 主流 agent 的统一做法（Claude Code `sandbox.filesystem.allowWrite`、Codex
//! `[sandbox_workspace_write] writable_roots`）都是「显式把这些目录加入沙箱可写根」，
//! 由 OS 层强制生效。本模块在运行前**动态探测**用户真实的包管理器缓存目录，并把它
//! 追加为沙箱 extra_roots；对齐上述官方做法，但无需用户手写配置。
//!
//! 探测来源（按优先级）：
//!   1. 环境变量显式覆盖（npm_config_cache / CARGO_HOME / PIP_CACHE_DIR ...）；
//!   2. 各平台默认缓存位置；
//!   3. `npm config get cache` / `pnpm store path` 权威探测（捕捉 .npmrc /
//!      pnpm store-dir 自定义——pnpm 的 store 常被改到别的盘符，默认猜不到）。
//!
//! 安全考量：
//!   - 只有「存在、或对应工具在 PATH 且能创建」的目录才加入；
//!   - 目录是 workspace 的祖先（含 workspace）时**跳过**——绝不让 `~` 或某个盘根
//!     因为 pnpm store-dir=... 被配置成整树可写；
//!   - 权威探测（npm/pnpm config）只读「用户级/全局」配置，显式排除项目级 .npmrc
//!     （npm 用 --location=user，且探测进程 cwd 强制指向用户主目录），防止仓库通过
//!     项目 .npmrc 的 cache=/store-dir= 把任意目录声明为缓存可写根；
//!   - 已在 workspace / 已有 extra_roots 覆盖内的目录跳过（去重）；
//!   - 探测结果进程内缓存（TTL 10 分钟），避免每条命令都付出探测开销。

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// 探测结果缓存时长。
const TTL: Duration = Duration::from_secs(600);

#[derive(Default)]
struct DetectionCache {
    detected_at: Option<Instant>,
    roots: Vec<PathBuf>,
}

static CACHE: Mutex<DetectionCache> = Mutex::new(DetectionCache {
    detected_at: None,
    roots: Vec::new(),
});

/// 串行化探测：缓存过期时若多条沙箱命令并发触发，只跑一轮真实探测。
static DETECT_LOCK: Mutex<()> = Mutex::new(());

// ==================== 对外接口 ====================

/// 清空缓存（测试用）。
#[cfg(test)]
pub(crate) fn clear_cache() {
    CACHE.lock().unwrap().detected_at = None;
}

/// 强制重探并返回结果（诊断用）。
pub fn refresh() -> Vec<PathBuf> {
    let roots = detect();
    *CACHE.lock().unwrap() = DetectionCache {
        detected_at: Some(Instant::now()),
        roots: roots.clone(),
    };
    roots
}

/// 供测试注入固定结果，避免依赖真实环境变量/本机工具链。
#[cfg(test)]
pub(crate) fn set_roots_for_test(roots: Vec<PathBuf>) {
    *CACHE.lock().unwrap() = DetectionCache {
        detected_at: Some(Instant::now()),
        roots,
    };
}

/// 读取（必要时刷新）探测结果。
fn cached_roots() -> Vec<PathBuf> {
    let mut guard = CACHE.lock().unwrap();
    let stale = guard
        .detected_at
        .map_or(true, |t| t.elapsed() > TTL);
    if stale {
        let roots = detect();
        guard.detected_at = Some(Instant::now());
        guard.roots = roots.clone();
        return roots;
    }
    guard.roots.clone()
}

/// 针对某个 workspace 过滤出「可安全追加的缓存可写根」。
///
/// 过滤规则：
///   - 必须是已存在目录（检测阶段已尽量补齐）；
///   - 跳过 workspace 内部/已被 workspace 覆盖的（重复授予无意义）；
///   - 跳过 workspace 的祖先目录（防止把 `~`、盘根等变成可写）；
///   - 跳过与已有 extra_roots 同路径的（去重）。
pub fn cache_roots_for_workspace(workspace: &Path, existing_roots: &[PathBuf]) -> Vec<PathBuf> {
    let ws = crate::sandbox::paths::canonicalize_path(workspace);
    let mut out: Vec<PathBuf> = Vec::new();
    for p in cached_roots() {
        if !p.is_dir() {
            continue;
        }
        // 1. workspace 包含该目录（或相同）→ workspace 已覆盖，无需追加
        if crate::sandbox::paths::root_contains_path(&ws, &p) {
            continue;
        }
        // 2. 该目录包含 workspace → 危险（祖先整树可写），必须跳过
        if crate::sandbox::paths::root_contains_path(&p, &ws) {
            continue;
        }
        // 3. 去重：已有 extra_roots 与本列表
        let key = crate::sandbox::paths::canonical_path_key(&p);
        let covered_by_existing = existing_roots
            .iter()
            .any(|e| crate::sandbox::paths::canonical_path_key(e) == key);
        if covered_by_existing {
            continue;
        }
        let already_pushed = out
            .iter()
            .any(|o| crate::sandbox::paths::canonical_path_key(o) == key);
        if already_pushed {
            continue;
        }
        out.push(p);
    }
    out
}

// ==================== 探测实现 ====================

/// 候选目录的去重写入。
fn push_unique(out: &mut Vec<PathBuf>, p: PathBuf) {
    let key = crate::sandbox::paths::canonical_path_key(&p);
    if !out.iter().any(|o| crate::sandbox::paths::canonical_path_key(o) == key) {
        out.push(p);
    }
}

/// 加入一个候选缓存根：已存在直接收；不存在但对应工具在 PATH → 由父进程补建后收。
fn consider(out: &mut Vec<PathBuf>, p: Option<PathBuf>, tool: Option<&str>) {
    let Some(raw) = p else { return };
    let path = crate::sandbox::paths::canonicalize_path(&raw);
    if path.is_dir() {
        push_unique(out, path);
        return;
    }
    if let Some(t) = tool {
        if is_tool_on_path(t) && std::fs::create_dir_all(&path).is_ok() && path.is_dir() {
            push_unique(out, path);
        }
    }
}

/// 工具是否出现在 PATH 上（Windows 顺带按可执行扩展名探测）。
fn is_tool_on_path(tool: &str) -> bool {
    let Some(paths) = std::env::var_os("PATH") else {
        return false;
    };
    let candidates: Vec<String> = if cfg!(target_os = "windows") {
        vec![
            tool.to_string(),
            format!("{tool}.exe"),
            format!("{tool}.cmd"),
            format!("{tool}.bat"),
            format!("{tool}.ps1"),
        ]
    } else {
        vec![tool.to_string()]
    };
    std::env::split_paths(&paths).any(|dir| {
        candidates
            .iter()
            .any(|name| dir.join(name).is_file())
    })
}

/// 短超时运行一条只读探测命令，捕获 stdout 首行（超时/失败返回 None）。
fn run_capture_script(script: &str) -> Option<String> {
    #[cfg(target_os = "windows")]
    let (cmd, args): (&str, Vec<String>) = (
        "cmd",
        vec!["/d".into(), "/s".into(), "/c".into(), script.into()],
    );
    #[cfg(not(target_os = "windows"))]
    let (cmd, args): (&str, Vec<String>) = ("/bin/sh", vec!["-c".into(), script.into()]);

    let mut builder = std::process::Command::new(cmd);
    builder.args(&args);
    // 探测进程 cwd 强制指向用户主目录：确保 npm/pnpm 只读用户级 ~/.npmrc（或全局），
    // 不读（可能被仓库控制/篡改的）项目级 .npmrc，防止项目配置把任意目录声明为缓存可写根。
    if let Some(home) = probe_home_dir() {
        builder.current_dir(home);
    }
    let mut child = builder
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .ok()?;
    let mut stdout = child.stdout.take()?;

    use std::io::Read;
    let (tx, rx) = std::sync::mpsc::channel::<String>();
    let reader = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = stdout.read_to_string(&mut s);
        let _ = tx.send(s);
    });

    let deadline = Instant::now() + Duration::from_millis(2500);
    loop {
        if let Ok(s) = rx.try_recv() {
            let _ = child.kill();
            let _ = reader.join();
            return (!s.trim().is_empty()).then_some(s);
        }
        if child.try_wait().ok().flatten().is_some() {
            break;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            break;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    let s = rx.recv_timeout(Duration::from_millis(200)).unwrap_or_default();
    let _ = reader.join();
    if s.trim().is_empty() {
        None
    } else {
        Some(s)
    }
}

/// 探测进程使用的工作目录（用户主目录）：让 npm/pnpm 只读用户级配置，
/// 不读（可能被仓库控制/篡改的）项目级 .npmrc。
fn probe_home_dir() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        env_path("USERPROFILE").or_else(|| env_path("HOME"))
    }
    #[cfg(not(target_os = "windows"))]
    {
        env_path("HOME")
    }
}

/// 权威探测：`npm config get cache` / `pnpm store path`。
fn probe_config(tool: &str, query: &str) -> Option<PathBuf> {
    if !is_tool_on_path(tool) {
        return None;
    }
    let script = format!("{tool} {query}");
    let out = run_capture_script(&script)?;
    let line = out.lines().next()?.trim();
    if line.is_empty() {
        return None;
    }
    let p = PathBuf::from(line);
    if p.is_absolute() {
        Some(p)
    } else {
        None
    }
}

/// 读环境变量为绝对路径（未设置/为空返回 None）。
fn env_path(name: &str) -> Option<PathBuf> {
    let v = std::env::var_os(name)?;
    if v.is_empty() {
        return None;
    }
    let p = PathBuf::from(v);
    if p.is_absolute() {
        Some(p)
    } else {
        None
    }
}

/// 全平台通用收集：环境变量显式覆盖 + npm/pnpm 权威探测。
fn collect_common(out: &mut Vec<PathBuf>) {
    // 环境变量覆盖（值即目录，tool 用于缺失时补建判断）
    let env_map: &[(&str, &str)] = &[
        ("npm_config_cache", "npm"),
        ("npm_config_store_dir", "pnpm"),
        ("YARN_CACHE_FOLDER", "yarn"),
        ("BUN_INSTALL_CACHE_DIR", "bun"),
        ("CARGO_HOME", "cargo"),
        ("PIP_CACHE_DIR", "pip"),
        ("UV_CACHE_DIR", "uv"),
        ("DENO_DIR", "deno"),
        ("GOMODCACHE", "go"),
        ("GOCACHE", "go"),
    ];
    for (var, tool) in env_map {
        consider(out, env_path(var), Some(tool));
    }

    // 权威探测：捕捉 .npmrc / pnpm store-dir 的自定义位置。
    // 只读用户级/全局配置（npm 用 --location=user；pnpm 靠探测进程 cwd 指向主目录），
    // 显式排除项目级 .npmrc，避免仓库把任意目录声明为缓存可写根。
    consider(out, probe_config("npm", "config get cache --location=user"), Some("npm"));
    consider(out, probe_config("pnpm", "store path"), Some("pnpm"));
}

/// Windows：默认缓存目录（无环境变量覆盖时）。
#[cfg(target_os = "windows")]
fn collect_platform_defaults(out: &mut Vec<PathBuf>) {
    let userprofile = env_path("USERPROFILE");
    let localappdata = env_path("LOCALAPPDATA");
    let home = |p: Option<&PathBuf>, sub: &str| p.map(|b| b.join(sub));
    consider(
        out,
        home(localappdata.as_ref(), "npm-cache"),
        Some("npm"),
    );
    // pnpm store 默认猜不到（常被自定义），只在 pnpm 存在时给一个兜底默认
    consider(
        out,
        home(localappdata.as_ref(), "pnpm/store"),
        Some("pnpm"),
    );
    consider(out, home(localappdata.as_ref(), "Yarn/Cache"), Some("yarn"));
    consider(out, home(userprofile.as_ref(), ".bun/install/cache"), Some("bun"));
    consider(out, home(userprofile.as_ref(), ".cargo"), Some("cargo"));
    consider(out, home(localappdata.as_ref(), "pip/Cache"), Some("pip"));
    consider(out, home(localappdata.as_ref(), "uv/cache"), Some("uv"));
    consider(out, home(localappdata.as_ref(), "deno"), Some("deno"));
    consider(out, home(userprofile.as_ref(), "go/pkg/mod"), Some("go"));
    consider(out, home(localappdata.as_ref(), "go-build"), Some("go"));
}

/// Unix 主目录与缓存基目录。
#[cfg(any(target_os = "macos", target_os = "linux"))]
fn unix_dirs() -> (Option<PathBuf>, Option<PathBuf>) {
    let home = env_path("HOME");
    let cache_root = home.as_ref().and_then(|h| {
        if cfg!(target_os = "macos") {
            Some(h.join("Library/Caches"))
        } else {
            Some(h.join(".cache"))
        }
    });
    (home, cache_root)
}

/// macOS / Linux：默认缓存目录（无环境变量覆盖时）。
#[cfg(any(target_os = "macos", target_os = "linux"))]
fn collect_platform_defaults(out: &mut Vec<PathBuf>) {
    let (home, cache_root) = unix_dirs();
    consider(out, home.as_ref().map(|h| h.join(".npm")), Some("npm"));
    // pnpm store：Linux 走 XDG_DATA_HOME 默认值 ~/.local/share；macOS 默认 ~/Library/pnpm/store。
    // 权威值由 `pnpm store path` 探测兜底；此处仅在探测失败时给默认。
    #[cfg(target_os = "macos")]
    consider(
        out,
        home.as_ref().map(|h| h.join("Library/pnpm/store")),
        Some("pnpm"),
    );
    #[cfg(target_os = "linux")]
    consider(
        out,
        home.as_ref().map(|h| h.join(".local/share/pnpm/store")),
        Some("pnpm"),
    );
    consider(out, cache_root.as_ref().map(|c| c.join("yarn")), Some("yarn"));
    consider(out, home.as_ref().map(|h| h.join(".cargo")), Some("cargo"));
    consider(out, cache_root.as_ref().map(|c| c.join("pip")), Some("pip"));
    consider(out, cache_root.as_ref().map(|c| c.join("uv")), Some("uv"));
    consider(out, cache_root.as_ref().map(|c| c.join("deno")), Some("deno"));
    consider(out, home.as_ref().map(|h| h.join("go/pkg/mod")), Some("go"));
    consider(
        out,
        cache_root.as_ref().map(|c| c.join("go-build")),
        Some("go"),
    );
}

/// 汇总一次完整探测（探测含子进程等待，外层调用方应放 spawn_blocking）。
fn detect() -> Vec<PathBuf> {
    let _guard = DETECT_LOCK.lock().unwrap();
    let mut out: Vec<PathBuf> = Vec::new();
    collect_common(&mut out);
    collect_platform_defaults(&mut out);
    out
}

// ==================== 测试 ====================

#[cfg(test)]
mod tests {
    use super::*;

    fn unique_dir(prefix: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "virlen-pkgcache-{prefix}-{}",
            std::process::id()
        ))
    }

    #[test]
    #[cfg(target_os = "windows")]
    fn env_override_becomes_a_root() {
        let base = unique_dir("env");
        let cache = base.join("fake-npm-cache");
        std::fs::create_dir_all(&cache).unwrap();
        std::env::set_var("npm_config_cache", &cache);
        clear_cache();
        let roots = refresh();
        std::env::remove_var("npm_config_cache");
        clear_cache();
        let _ = std::fs::remove_dir_all(&base);
        assert!(
            roots
                .iter()
                .any(|r| crate::sandbox::paths::same_path_key(r, &cache)),
            "env override 的缓存目录应被探测到: {roots:?}"
        );
    }

    #[test]
    fn workspace_ancestors_are_skipped_and_siblings_kept() {
        let base = unique_dir("ws");
        let ws = base.join("proj");
        let inside = ws.join("sub"); // workspace 内部 → 已覆盖，跳过
        let sibling = base.join("sibling"); // 普通区外目录 → 保留
        std::fs::create_dir_all(&inside).unwrap();
        std::fs::create_dir_all(&sibling).unwrap();

        // base 是 workspace 的祖先，绝不能作为额外可写根加入
        set_roots_for_test(vec![
            base.clone(),
            inside.clone(),
            sibling.clone(),
        ]);
        let out = cache_roots_for_workspace(&ws, &[]);
        assert_eq!(out.len(), 1, "应只剩 sibling: {out:?}");
        assert!(crate::sandbox::paths::same_path_key(&out[0], &sibling));

        // 已在 existing_roots 中的根会去重
        set_roots_for_test(vec![sibling.clone()]);
        let out2 = cache_roots_for_workspace(&ws, &[sibling.clone()]);
        assert!(out2.is_empty(), "重复根应被去重: {out2:?}");

        let _ = std::fs::remove_dir_all(&base);
    }

    /// 真机 E2E：探测到的缓存根应能作为沙箱额外写根使用——受限 PowerShell
    /// 在该目录内写文件应成功（对应 `npm install` 写 ~/.npm 缓存的场景）。
    #[test]
    #[cfg(target_os = "windows")]
    fn e2e_detected_cache_root_is_writable_in_sandbox() {
        use std::collections::BTreeMap;
        use std::io::Read;

        use crate::sandbox::state::SandboxState;
        use crate::sandbox::{SandboxRequest, SandboxSession};

        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let base = std::env::temp_dir().join(format!(
            "virlen-pkgcache-e2e-{}-{nanos}",
            std::process::id()
        ));
        let ws = base.join("workspace");
        let cache = base.join("fake-npm-cache");
        std::fs::create_dir_all(&ws).unwrap();
        std::fs::create_dir_all(&cache).unwrap();
        let state = SandboxState::new(base.join("state")).unwrap();

        // 注入 npm 缓存位置（模拟用户实际缓存目录），触发探测。
        std::env::set_var("npm_config_cache", &cache);
        clear_cache();
        let all_roots = cache_roots_for_workspace(&ws, &[]);
        clear_cache();
        std::env::remove_var("npm_config_cache");

        assert!(
            all_roots
                .iter()
                .any(|r| crate::sandbox::paths::same_path_key(r, &cache)),
            "npm_config_cache 目录应被探测为缓存根: {all_roots:?}"
        );
        // 只把本次临时目录内的缓存根加入沙盒（避免测试去改真实 npm-cache 的 ACL）。
        let extra: Vec<PathBuf> = all_roots
            .into_iter()
            .filter(|p| crate::sandbox::paths::root_contains_path(&base, p))
            .collect();
        assert!(!extra.is_empty(), "至少应有一个临时缓存根");

        let session = SandboxSession::prepare(
            &SandboxRequest {
                cwd: ws.clone(),
                extra_roots: extra,
                protect: vec![],
                readonly: false,
            },
            &state,
        )
        .expect("prepare 应成功");

        // 受限令牌 + CLM 下用基础 cmdlet 写文件到缓存根。
        let probe = cache.join("probe.txt");
        let script = format!(
            "Set-Content -LiteralPath '{}' -Value 'ok'",
            probe.to_string_lossy()
        );
        let argv_owned: Vec<String> = vec![
            "powershell".into(),
            "-NoProfile".into(),
            "-Command".into(),
            script,
        ];
        let mut child = session.spawn(&argv_owned, None, &BTreeMap::new()).unwrap();
        let mut err = Vec::new();
        if let Some(mut f) = child.stderr.take() {
            let _ = f.read_to_end(&mut err);
        }
        let code = child.wait_and_read_exit_code();
        assert_eq!(
            code,
            Some(0),
            "缓存根写文件应成功；stderr={}",
            String::from_utf8_lossy(&err)
        );
        assert!(probe.exists(), "缓存根内 probe.txt 应被创建");

        let _ = std::fs::remove_dir_all(&base);
    }
}
