//! 远程操作（fetch / pull / push / ls-remote）与**凭据策略 = SSH**。
//!
//! 策略只有一条：**认证全靠本机 ssh**（私钥 / ssh-agent / `~/.ssh/config`）。应用里没有凭据输入框，
//! 也不保存任何密码或令牌。由此推出三条硬口径：
//!
//! 1. **必须能立刻失败**。非交互进程里的 `ssh` / `git` 一旦等输入就是永久卡住（界面上没有地方能回答它）。
//!    所以网络命令一律带 `ssh -o BatchMode=yes`（agent 里已有密钥 → 成功；缺密钥 → 立即
//!    `Permission denied (publickey)`），并把 `GIT_ASKPASS` / `SSH_ASKPASS` 清空、`GIT_TERMINAL_PROMPT=0`
//!    （见 [`super::cli::GitCmd::network`]）。
//! 2. **不替用户改配置**。`core.sshCommand` 与进程环境里的 `GIT_SSH_COMMAND` 是用户的显式选择，一律沿用
//!    （只在其中**还没有** `BatchMode` 时补一个）—— 覆盖它就会造出「界面能 fetch、终端 fetch 不了」的反向分叉。
//! 3. **HTTPS 远程只能当匿名的**。凭据策略是 SSH，我们不提供任何 https 认证；私有仓库会失败，
//!    那时给的是「把远程改成 SSH 地址」的指引（[`hint_for`]），而不是去猜令牌。
//!
//! 其余口径与其它模块一致：cwd = 仓库根、stderr 原样透传、只识别**明确模式**才补一句指引（不猜原因）。

use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use super::cli::{GitCmd, GitError, GitOutput};
use super::repo::root_of;
use super::{RemoteInfo, RemoteKind, SyncResult, WriteGate};

/// 回传界面的输出上限（字符）。`push` 上万个对象的进度能刷出几 MB，全塞进 IPC 没有意义。
const MAX_OUTPUT_CHARS: usize = 8000;

// ==================== 远程列表 ====================

/// 列出远程仓库（`git remote -v`）。
pub fn list(dir: &str) -> Result<Vec<RemoteInfo>, GitError> {
    let root = root_of(dir)?;
    let out = GitCmd::read(&root)
        .arg("remote")
        .arg("-v")
        .run()?
        .into_result("remote -v")?;
    Ok(parse_remotes(&out.stdout_str()))
}

/// `git remote -v` 输出 → 远程列表（纯函数）。同名 fetch / push 合并成一条记录。
///
/// 每行形如 `<name>\t<url> (fetch)`，url 里的 userinfo 在这里就抹掉（见 [`redact_url`]）。
pub fn parse_remotes(text: &str) -> Vec<RemoteInfo> {
    let mut list: Vec<RemoteInfo> = Vec::new();
    for line in text.lines() {
        let Some((name, rest)) = line.split_once('\t') else {
            continue;
        };
        let (url, is_push) = if let Some(u) = rest.strip_suffix(" (push)") {
            (u, true)
        } else if let Some(u) = rest.strip_suffix(" (fetch)") {
            (u, false)
        } else {
            continue;
        };
        let url = redact_url(url.trim());
        match list.iter_mut().find(|r| r.name == name) {
            Some(existing) => {
                if is_push {
                    existing.push_url = url;
                } else {
                    existing.kind = remote_kind(&url);
                    existing.url = url;
                }
            }
            None => list.push(RemoteInfo {
                name: name.to_string(),
                kind: remote_kind(&url),
                url: url.clone(),
                push_url: url,
            }),
        }
    }
    // 只配了一个方向（罕见的 `remote.<name>.pushurl` 单边配置）时，另一个方向跟随它
    for r in &mut list {
        if r.url.is_empty() {
            r.url = r.push_url.clone();
        }
        if r.push_url.is_empty() {
            r.push_url = r.url.clone();
        }
    }
    list
}

/// 选一个远程：显式指定 → 必须存在；否则 `origin` → 只有一个时用它 → 都不是就报错。
///
/// 有多个远程又没指定时**不猜**：推错仓库是不可逆的（推上去的分支别人就能看到）。
pub fn pick(list: &[RemoteInfo], name: Option<&str>) -> Result<RemoteInfo, GitError> {
    if let Some(n) = name.map(str::trim).filter(|s| !s.is_empty()) {
        return list.iter().find(|r| r.name == n).cloned().ok_or_else(|| {
            GitError::new(format!("没有名为「{}」的远程仓库", n))
        });
    }
    if let Some(origin) = list.iter().find(|r| r.name == "origin") {
        return Ok(origin.clone());
    }
    match list {
        [] => Err(GitError::new(
            "这个仓库还没有配置远程仓库：先在终端里 git remote add origin <地址>",
        )),
        [only] => Ok(only.clone()),
        many => Err(GitError::new(format!(
            "仓库有 {} 个远程仓库，请指定用哪一个",
            many.len()
        ))),
    }
}

/// 远程地址的种类（纯函数）。
pub fn remote_kind(url: &str) -> RemoteKind {
    let u = url.trim();
    if u.is_empty() {
        return RemoteKind::Other;
    }
    let lower = u.to_ascii_lowercase();
    for (prefix, kind) in [
        ("ssh://", RemoteKind::Ssh),
        ("https://", RemoteKind::Https),
        ("http://", RemoteKind::Http),
        ("git://", RemoteKind::Git),
        ("file://", RemoteKind::File),
    ] {
        if lower.starts_with(prefix) {
            return kind;
        }
    }
    match u.find(':') {
        // `C:/repo` / `D:\repo`：盘符不是 scp 风格地址的分隔符
        Some(i) if i == 1 && u.is_char_boundary(1) && u[..1].chars().all(|c| c.is_ascii_alphabetic()) => {
            RemoteKind::File
        }
        // `git@github.com:owner/repo.git`（冒号前没有路径分隔符 = scp 风格）
        Some(i) if !u[..i].contains(['/', '\\']) => RemoteKind::Ssh,
        Some(_) => RemoteKind::Other,
        // 没有协议也没有冒号：`/srv/repo.git`、`../bare.git` 都是本地路径
        None => RemoteKind::File,
    }
}

/// 抹掉 URL 里的 userinfo：`https://user:token@host/x` → `https://host/x`。
///
/// ⚠️ 远程地址要显示在界面上，令牌绝不能跟着走（安全红线：界面 / 埋点 / 日志都不得出现密钥）。
pub fn redact_url(url: &str) -> String {
    let Some(scheme_end) = url.find("://") else {
        return url.to_string();
    };
    let rest_start = scheme_end + 3;
    let rest = &url[rest_start..];
    let host_end = rest.find('/').unwrap_or(rest.len());
    match rest[..host_end].rfind('@') {
        Some(at) => format!("{}{}", &url[..rest_start], &rest[at + 1..]),
        None => url.to_string(),
    }
}

// ==================== 网络命令的统一姿势 ====================

/// 网络命令（写）：fetch / pull / push 会改本地 refs，走 per-repo 写锁。
fn net_write(root: &str) -> GitCmd {
    with_ssh(GitCmd::write(root).network(), root)
}

/// 网络命令（读）：`ls-remote` 不动本地任何东西，别占写锁。
fn net_read(root: &str) -> GitCmd {
    with_ssh(GitCmd::read(root).network(), root)
}

fn with_ssh(mut cmd: GitCmd, root: &str) -> GitCmd {
    // ⚠️ 凭据策略 = SSH：连 credential helper 一起停掉。否则 https 远程会悄悄拉起一个
    //    本应用之外的弹窗（GCM / 存盘密码），用户不知道是谁弹的，也不知道为什么又回到交互。
    //    停掉后失败会落到「改成 SSH 地址」那句指引（见 `hint_for`）。
    cmd = cmd.arg("-c").arg("credential.helper=");
    match ssh_command(root) {
        Some(ssh) => cmd.env("GIT_SSH_COMMAND", ssh),
        None => cmd,
    }
}

/// 本次调用要用的 `GIT_SSH_COMMAND`（`None` = 别动，让 git 自己决定）。
///
/// 取值的优先级体现「不替用户改配置」：环境变量已设 → 完全不插手（连 BatchMode 也由用户决定）；
/// 否则用 `core.sshCommand`（用户可能写了 `-i <私钥>`），再否则用 `ssh`。
pub fn ssh_command(root: &str) -> Option<String> {
    if std::env::var_os("GIT_SSH_COMMAND").is_some() {
        return None;
    }
    let configured = GitCmd::read(root)
        .arg("config")
        .arg("--get")
        .arg("core.sshCommand")
        .run()
        .ok()
        .filter(GitOutput::ok)
        .map(|o| o.stdout_str().trim().to_string())
        .filter(|s| !s.is_empty());
    let base = configured.unwrap_or_else(|| "ssh".to_string());
    if base.contains("BatchMode") {
        return Some(base);
    }
    Some(format!("{} -o BatchMode=yes", base))
}

/// 当前分支名；游离 HEAD / 空仓库（unborn）回 `None`。
fn current_branch(root: &str) -> Result<Option<String>, GitError> {
    let out = GitCmd::read(root)
        .arg("symbolic-ref")
        .arg("--quiet")
        .arg("--short")
        .arg("HEAD")
        .run()?;
    if !out.ok() {
        return Ok(None);
    }
    let name = out.stdout_str().trim().to_string();
    Ok(if name.is_empty() { None } else { Some(name) })
}

/// 分支有没有上游（没有就 `push -u`，让第一次推送顺手把跟踪关系建起来）。
fn has_upstream(root: &str, branch: &str) -> Result<bool, GitError> {
    let out = GitCmd::read(root)
        .arg("rev-parse")
        .arg("--abbrev-ref")
        .arg("--symbolic-full-name")
        .arg(format!("{}@{{u}}", branch))
        .run()?;
    Ok(out.ok())
}

/// 把 git 的 stderr 翻译成「下一步做什么」——**只在识别出明确模式时补一句**，其余原样透传。
pub fn hint_for(stderr: &str) -> Option<&'static str> {
    let s = stderr.to_ascii_lowercase();
    if s.contains("host key verification failed") {
        return Some(
            "该主机的 SSH 指纹还没有被信任：先在本机终端里执行一次 ssh -T git@<主机> 确认指纹，再回来重试。",
        );
    }
    if s.contains("permission denied (publickey") {
        return Some(
            "SSH 认证失败：确认公钥已加到远程账户，且私钥已在 ssh-agent 里（ssh-add -l 能列出它）。本应用不会弹密码框（凭据策略 = SSH）。",
        );
    }
    if s.contains("no such identity") {
        return Some("找不到私钥文件：检查 ~/.ssh/config 与 core.sshCommand 里的 -i 路径。");
    }
    if s.contains("could not resolve hostname") || s.contains("name or service not known") {
        return Some("域名解析失败：检查网络 / 代理设置。");
    }
    if s.contains("connection timed out")
        || s.contains("connection refused")
        || s.contains("network is unreachable")
        || s.contains("operation timed out")
    {
        return Some("连不上远程主机：检查网络 / 代理 / 防火墙。");
    }
    if s.contains("could not read username")
        || s.contains("could not read password")
        || s.contains("authentication failed")
        || s.contains("terminal prompts disabled")
    {
        return Some(
            "远程是 HTTPS 地址，而本应用的凭据策略是 SSH（不做凭据交互）：把远程改成 SSH 地址即可，例如 git remote set-url origin git@<主机>:<owner>/<repo>.git",
        );
    }
    None
}

/// 失败时补一句指引（`stderr` 原文保留，不加工）
fn classify(e: GitError) -> GitError {
    match hint_for(&e.stderr) {
        Some(hint) => GitError {
            message: format!("{}\n{}", e.message, hint),
            ..e
        },
        None => e,
    }
}

fn result_of(info: &RemoteInfo, branch: Option<String>, out: &GitOutput) -> SyncResult {
    let mut text = out.stdout_str();
    text.push_str(&out.stderr);
    let text = text.trim();
    let too_long = text.chars().count() > MAX_OUTPUT_CHARS;
    let mut output: String = text.chars().take(MAX_OUTPUT_CHARS).collect();
    if too_long {
        output.push_str("\n…（输出过长，已截断）");
    }
    SyncResult {
        remote: info.name.clone(),
        url: info.url.clone(),
        branch,
        output,
    }
}

// ==================== 三个动作 ====================

/// `git fetch <remote>`：只更新远程跟踪分支，**不动工作区、不动本地分支**。
pub fn fetch(
    dir: &str,
    gate: &WriteGate,
    remote: Option<&str>,
    cancel: Option<&Arc<AtomicBool>>,
) -> Result<SyncResult, GitError> {
    gate.ensure()?;
    let root = root_of(dir)?;
    let info = pick(&list(&root)?, remote)?;
    let out = net_write(&root)
        .arg("fetch")
        .arg(&info.name)
        .cancel_opt(cancel)
        .run()?
        .into_result("fetch")
        .map_err(classify)?;
    Ok(result_of(&info, None, &out))
}

/// `git pull --ff-only <remote> <branch>`。
///
/// ⚠️ **只允许快进**：合并 / 变基会把冲突留在工作区，而解决冲突不在本面板的能力范围内
/// （三栏冲突解决是 P2）。快进不了时就如实失败 —— 用户需要的是「知道分叉了」，不是一条被偷偷
/// 合进来的 merge 提交。
pub fn pull(
    dir: &str,
    gate: &WriteGate,
    remote: Option<&str>,
    cancel: Option<&Arc<AtomicBool>>,
) -> Result<SyncResult, GitError> {
    gate.ensure()?;
    let root = root_of(dir)?;
    let info = pick(&list(&root)?, remote)?;
    let branch = current_branch(&root)?.ok_or_else(|| {
        GitError::new("当前是游离 HEAD（不在任何分支上）：先切回一个本地分支再拉取")
    })?;
    let out = net_write(&root)
        .arg("pull")
        .arg("--ff-only")
        .arg(&info.name)
        .arg(&branch)
        .cancel_opt(cancel)
        .run()?
        .into_result("pull")
        .map_err(classify)?;
    Ok(result_of(&info, Some(branch), &out))
}

/// `git push <remote> <branch>`（该分支还没有上游时自动带 `-u`，把跟踪关系建起来）。
///
/// ⚠️ **不提供强制推送**：`--force` 会改写别人的历史，界面上没有「确认框」能表达它的后果。
pub fn push(
    dir: &str,
    gate: &WriteGate,
    remote: Option<&str>,
    cancel: Option<&Arc<AtomicBool>>,
) -> Result<SyncResult, GitError> {
    gate.ensure()?;
    let root = root_of(dir)?;
    let info = pick(&list(&root)?, remote)?;
    let branch = current_branch(&root)?.ok_or_else(|| {
        GitError::new("当前是游离 HEAD（不在任何分支上）：先切回一个本地分支再推送")
    })?;
    let mut cmd = net_write(&root).arg("push");
    if !has_upstream(&root, &branch)? {
        cmd = cmd.arg("--set-upstream");
    }
    let out = cmd
        .arg(&info.name)
        .arg(&branch)
        .cancel_opt(cancel)
        .run()?
        .into_result("push")
        .map_err(classify)?;
    Ok(result_of(&info, Some(branch), &out))
}

/// 连一下远程（`git ls-remote`）：只读、不动本地任何 refs，用来验证 SSH 密钥 / 主机指纹 / 网络。
///
/// 输出只留前 20 行（引用清单动辄上千行），界面上它就是一个「连接正常 / 为什么不通」。
pub fn test_connection(
    dir: &str,
    remote: Option<&str>,
    cancel: Option<&Arc<AtomicBool>>,
) -> Result<SyncResult, GitError> {
    let root = root_of(dir)?;
    let info = pick(&list(&root)?, remote)?;
    let out = net_read(&root)
        .arg("ls-remote")
        .arg(&info.name)
        .cancel_opt(cancel)
        .run()?
        .into_result("ls-remote")
        .map_err(classify)?;
    let text = out.stdout_str();
    let head: Vec<&str> = text.lines().take(20).collect();
    Ok(SyncResult {
        remote: info.name.clone(),
        url: info.url.clone(),
        branch: None,
        output: head.join("\n"),
    })
}
