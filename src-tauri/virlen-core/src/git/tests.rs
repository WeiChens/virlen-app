//! git 模块的用例 —— 分两类：
//!
//! 1. **固定字节**（纯函数）：钉住 porcelain=v2 的字段布局，尤其是类型 `2` 的**双路径**
//!    与含空格的路径（这两处错了只会在特定文件上静默出错）；
//! 2. **真仓库**（端到端）：`git init` 一个临时仓库，造齐各类变更，断言解析结果 ——
//!    这是方案 §10 第 6 条要求的「不许凭记忆写解析」。
//!
//! 真仓库用例在本机没有 git 时**跳过**（CI 若无 git 不该因此变红），跳过会打印一行说明。

use super::branch::{self, parse_refs};
use super::cli::GitCmd;
use super::log::parse_log;
use super::status::parse_status;
use super::{ChangeEntry, DiffScope, EntryKind, HeadInfo, LogScope, RemoteKind, StatusSnapshot, WriteGate};
use std::path::PathBuf;

// ==================== 一、固定字节（纯函数） ====================

/// 类型 1 / 2 / u / ? 各一条，含：含空格的路径、中文路径、rename 的双路径
#[test]
fn parse_status_pins_field_layout() {
    let raw = concat!(
        "# branch.oid 1111111111111111111111111111111111111111\0",
        "# branch.head main\0",
        "# branch.upstream origin/main\0",
        "# branch.ab +2 -3\0",
        // 已暂存修改 + 工作区又改了（XY = MM）
        "1 MM N... 100644 100644 100644 aaa bbb dir/a file.txt\0",
        // 已暂存新增
        "1 A. N... 000000 100644 100644 0000 ccc 中文 文件.txt\0",
        // rename：旧路径是**紧随其后的下一条 NUL 记录**
        "2 R. N... 100644 100644 100644 ddd eee R100 renamed.txt\0old name.txt\0",
        // 冲突（u 记录：4 个 mode + **3 个** hash + 路径）
        "u UU N... 100644 100644 100644 100644 fff 111 222 conflict.txt\0",
        // 未跟踪
        "? untracked.txt\0",
    )
    .as_bytes();

    let snap = parse_status(raw, super::status::MAX_ENTRIES).unwrap();

    assert_eq!(snap.head.branch.as_deref(), Some("main"));
    assert_eq!(snap.head.upstream.as_deref(), Some("origin/main"));
    assert_eq!((snap.head.ahead, snap.head.behind), (2, 3));
    assert_eq!(
        snap.head.oid.as_deref(),
        Some("1111111111111111111111111111111111111111")
    );
    assert!(!snap.truncated);
    assert_eq!(snap.entries.len(), 5);

    // 含空格的路径必须整体保留（按空白全切会只剩最后一段）
    let spaced = &snap.entries[0];
    assert_eq!(spaced.path, "dir/a file.txt");
    assert_eq!((spaced.x, spaced.y), ('M', 'M'));
    assert_eq!(spaced.kind, EntryKind::Ordinary);

    assert_eq!(snap.entries[1].path, "中文 文件.txt");
    assert_eq!((snap.entries[1].x, snap.entries[1].y), ('A', '.'));

    // rename：新路径 + 旧路径，且**没有**多出第五条「旧路径」记录
    let renamed = &snap.entries[2];
    assert_eq!(renamed.kind, EntryKind::Renamed);
    assert_eq!(renamed.path, "renamed.txt");
    assert_eq!(renamed.orig_path.as_deref(), Some("old name.txt"));

    assert_eq!(snap.entries[3].kind, EntryKind::Unmerged);
    assert_eq!(snap.entries[3].path, "conflict.txt");

    assert_eq!(snap.entries[4].kind, EntryKind::Untracked);
    assert_eq!(snap.entries[4].path, "untracked.txt");
}

/// 空仓库：`(initial)` 与 `(detached)` 必须落成 `None`（不是字符串 `"(initial)"`）
#[test]
fn parse_status_normalizes_sentinels() {
    let raw = b"# branch.oid (initial)\0# branch.head main\0? a.txt\0";
    let snap = parse_status(raw, 100).unwrap();
    assert!(snap.head.oid.is_none());
    assert_eq!(snap.head.branch.as_deref(), Some("main"));

    let detached =
        b"# branch.oid 2222222222222222222222222222222222222222\0# branch.head (detached)\0";
    let snap = parse_status(detached, 100).unwrap();
    assert!(snap.head.branch.is_none());
    assert!(snap.head.oid.is_some());
}

/// 超过上限即截断并**置位 `truncated`**（不静默截断）
#[test]
fn parse_status_reports_truncation() {
    let raw = b"? a.txt\0? b.txt\0? c.txt\0";
    let snap = parse_status(raw, 2).unwrap();
    assert_eq!(snap.entries.len(), 2);
    assert!(snap.truncated);
}

/// `%(upstream:track)` 的三种取值：无 upstream / 有落差 / upstream 已删
#[test]
fn track_field_parsing() {
    // ⚠️ `for-each-ref` 的记录分隔符是**换行**（不是 NUL）—— 写成 NUL 会全部挤成一条
    let text = concat!(
        "refs/heads/main\tmain\t*\t1111111\torigin/main\t[ahead 1, behind 2]\t2026-01-01T00:00:00+08:00\tfirst\n",
        "refs/heads/clean\tclean\t \t2222222\t\t\t2026-01-02T00:00:00+08:00\tsecond\n",
        "refs/heads/gone\tgone\t \t3333333\torigin/gone\t[gone]\t2026-01-03T00:00:00+08:00\tthird\n",
        "refs/remotes/origin/HEAD\torigin/HEAD\t \t4444444\t\t\t2026-01-04T00:00:00+08:00\tremote head\n",
    );
    let list = parse_refs(text);
    // 符号引用 origin/HEAD 必须被丢掉，其余三条按「当前分支 → 本地 → 远程」排
    assert_eq!(list.len(), 3);
    assert_eq!(list[0].name, "main");
    assert!(list[0].is_head);
    assert_eq!((list[0].ahead, list[0].behind), (1, 2));
    assert!(!list[0].upstream_gone);

    assert_eq!(list[1].name, "clean");
    assert_eq!(list[1].upstream, None);
    assert!(!list[1].upstream_gone, "没有 upstream 不等于 upstream 被删");

    assert_eq!(list[2].name, "gone");
    assert!(list[2].upstream_gone);
}

// ==================== 二、真仓库（端到端） ====================

/// 临时仓库：`Drop` 时删目录（用例失败也不留垃圾）
struct TempRepo {
    dir: PathBuf,
}

impl TempRepo {
    fn new() -> Option<Self> {
        Self::new_with(&[])
    }

    /// 裸仓库（`--bare`，没有工作区）—— 远程用例的「服务器」：用**本机路径**当远程，不碰网络也不碰凭据
    fn new_bare() -> Option<Self> {
        Self::new_with(&["--bare"])
    }

    fn new_with(init_args: &[&str]) -> Option<Self> {
        if !git_available() {
            eprintln!("[git tests] 未检测到 git，跳过真仓库用例");
            return None;
        }
        let dir = std::env::temp_dir().join(format!("virlen_git_test_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).ok()?;
        let repo = Self { dir };
        let mut init = vec!["init", "-q"];
        init.extend_from_slice(init_args);
        repo.git(&init);
        // 身份与签名都钉在**本仓库**上：不依赖开发机的全局配置，也不给用例留下「改了全局配置」的副作用
        repo.git(&["config", "user.email", "test@example.com"]);
        repo.git(&["config", "user.name", "virlen test"]);
        repo.git(&["config", "commit.gpgsign", "false"]);
        Some(repo)
    }

    fn path(&self) -> String {
        self.dir.to_string_lossy().replace('\\', "/")
    }

    /// 跑一条 git 并断言成功（用例内部用，失败即 panic）
    fn git(&self, args: &[&str]) -> String {
        let out = GitCmd::write(&self.path())
            .args(args.iter().map(|s| s.to_string()))
            .run()
            .expect("git 起不来");
        assert!(
            out.ok(),
            "git {:?} 失败: {}",
            args,
            out.stderr.trim()
        );
        out.stdout_str()
    }

    fn write(&self, rel: &str, content: &str) {
        let full = self.dir.join(rel);
        if let Some(parent) = full.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(full, content).unwrap();
    }
}

impl Drop for TempRepo {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn git_available() -> bool {
    super::cli::run_bare(&["--version"], super::cli::READ_TIMEOUT)
        .map(|o| o.ok())
        .unwrap_or(false)
}

/// 两条路径是否指向**同一个目录**。
///
/// ⚠️ 不能直接比字符串：`git rev-parse --show-toplevel` 回的是**规范路径**，而我们传进去的目录可能
/// 是另一个写法——两种形态都在 CI 上真发生过：
/// - macOS：`TEMP` 给 `/var/folders/...`，git 给 `/private/var/folders/...`（`/var` 是符号链接）；
/// - Windows：`TEMP` 给 8.3 短名 `C:/Users/RUNNER~1/...`，git 给长名 `C:/Users/runneradmin/...`。
///
/// 这只是在用例层面抹平「同一目录的多种写法」，不是把断言放宽：符号链接 / 短名都靠
/// `canonicalize` 解开，不同目录仍然不等。
fn same_path(actual: &str, expected: &str) -> bool {
    let normalize = |value: &str| {
        std::fs::canonicalize(value)
            .map(|path| {
                let text = path
                    .to_string_lossy()
                    // `canonicalize` 在 Windows 上加的 verbatim 前缀，与 git 的输出对不上
                    .trim_start_matches(r"\\?\")
                    .replace('\\', "/");
                // ⚠️ 只在 Windows 折大小写：macOS / Linux 可能是大小写敏感卷，
                // 无条件折成小写会把两个真不同的目录判等。
                if cfg!(target_os = "windows") {
                    text.to_lowercase()
                } else {
                    text.to_string()
                }
            })
            .unwrap_or_else(|_| value.replace('\\', "/"))
    };
    normalize(actual) == normalize(expected)
}

/// 符号链接的字面路径与目标路径必须判等（macOS / Linux 的临时目录就是这个形态：
/// `/var/...` vs `/private/var/...`）。只在能**无特权**建符号链接的 unix 上跑：
/// Windows 上建链接需要开发者模式 / 管理员，不能作为用例前提。
#[cfg(unix)]
#[test]
fn same_path_resolves_symlinked_temp_root() {
    let base = std::env::temp_dir().join(format!("virlen_same_path_{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&base).unwrap();
    let link = base.with_extension("link");
    let _ = std::fs::remove_file(&link);
    std::os::unix::fs::symlink(&base, &link).unwrap();

    assert!(
        same_path(&link.to_string_lossy(), &base.to_string_lossy()),
        "符号链接与目标应判为同一目录"
    );

    // 不同目录（含父子关系）不能被抹平
    let child = base.join("sub");
    std::fs::create_dir_all(&child).unwrap();
    assert!(!same_path(&child.to_string_lossy(), &base.to_string_lossy()));

    let _ = std::fs::remove_file(&link);
    let _ = std::fs::remove_dir_all(&base);
}

/// 一个仓库跑齐五类变更，断言与 git 自己的判定一致
#[test]
fn status_end_to_end_on_real_repo() {
    let Some(repo) = TempRepo::new() else { return };
    repo.write("tracked.txt", "one\n");
    repo.write("中文 文件名.txt", "原始\n");
    repo.write("to-rename.txt", "rename me\n");
    repo.write("to-delete.txt", "bye\n");
    repo.git(&["add", "-A"]);
    repo.git(&["commit", "-q", "-m", "init"]);

    // ① 已跟踪改动（未暂存）
    repo.write("tracked.txt", "one\ntwo\n");
    // ② 中文 + 空格路径的改动
    repo.write("中文 文件名.txt", "改过了\n");
    // ③ 暂存新增
    repo.write("staged-new.txt", "new\n");
    repo.git(&["add", "staged-new.txt"]);
    // ④ rename（`git mv` = 已暂存的改名，porcelain 类型 2）
    repo.git(&["mv", "to-rename.txt", "renamed.txt"]);
    // ⑤ 删除（未暂存）
    std::fs::remove_file(repo.dir.join("to-delete.txt")).unwrap();
    // ⑥ 未跟踪
    repo.write("untracked.txt", "x\n");

    let snap = super::status::status(&repo.path()).expect("status 失败");

    let find = |p: &str| snap.entries.iter().find(|e| e.path == p);

    let modified = find("tracked.txt").expect("缺 tracked.txt");
    assert_eq!((modified.x, modified.y), ('.', 'M'), "未暂存的改动应在 Y 侧");

    let cjk = find("中文 文件名.txt").expect("缺中文路径（core.quotepath 没关？）");
    assert_eq!(cjk.y, 'M');

    let staged = find("staged-new.txt").expect("缺 staged-new.txt");
    assert_eq!(staged.x, 'A');
    assert_eq!(staged.y, '.');

    let renamed = find("renamed.txt").expect("缺 renamed.txt");
    assert_eq!(renamed.kind, EntryKind::Renamed);
    assert_eq!(renamed.x, 'R');
    assert_eq!(
        renamed.orig_path.as_deref(),
        Some("to-rename.txt"),
        "rename 的旧路径必须解析出来（类型 2 的第二条 NUL 记录）"
    );
    // 旧路径不能自己变成一条独立记录
    assert!(
        find("to-rename.txt").is_none() || find("to-rename.txt").unwrap().kind != EntryKind::Untracked,
        "旧路径不该被解析成独立变更"
    );

    let deleted = find("to-delete.txt").expect("缺 to-delete.txt");
    assert_eq!(deleted.y, 'D');

    let untracked = find("untracked.txt").expect("缺 untracked.txt");
    assert_eq!(untracked.kind, EntryKind::Untracked);

    assert!(!snap.truncated);
    assert!(snap.head.oid.is_some());
    assert!(snap.head.branch.is_some());
}

/// 空仓库（unborn HEAD）：能出快照，且分支名有、oid 无
#[test]
fn status_on_unborn_head() {
    let Some(repo) = TempRepo::new() else { return };
    repo.write("a.txt", "hello\n");
    let snap = super::status::status(&repo.path()).unwrap();
    assert!(snap.head.oid.is_none(), "尚无提交时 oid 应为 None");
    assert!(snap.head.branch.is_some(), "unborn HEAD 仍有分支名");
    assert_eq!(snap.entries.len(), 1);
    assert_eq!(snap.entries[0].kind, EntryKind::Untracked);
}

/// 首次提交前「取消暂存」必须走 `rm --cached` 分支（`restore --staged` 在这里会失败）
#[test]
fn unstage_before_first_commit() {
    let Some(repo) = TempRepo::new() else { return };
    repo.write("a.txt", "hello\n");
    let gate = WriteGate::new(true);

    let staged = super::stage::stage(&repo.path(), &gate, &["a.txt".to_string()]).unwrap();
    assert_eq!(staged.entries[0].x, 'A');

    let back = super::stage::unstage(&repo.path(), &gate, &["a.txt".to_string()]).unwrap();
    assert_eq!(back.entries[0].kind, EntryKind::Untracked);
}

/// 暂存 → 提交 → 工作区干净
#[test]
fn stage_commit_roundtrip() {
    let Some(repo) = TempRepo::new() else { return };
    repo.write("a.txt", "hello\n");
    let gate = WriteGate::new(true);
    super::stage::stage(&repo.path(), &gate, &["a.txt".to_string()]).unwrap();

    let result = super::commit::commit(&repo.path(), &gate, "feat: 第一次提交\n").unwrap();
    assert_eq!(result.oid.len(), 40, "返回的 oid 应是完整的 40 位");
    assert_eq!(result.summary, "feat: 第一次提交");

    let snap = super::status::status(&repo.path()).unwrap();
    assert!(snap.entries.is_empty(), "提交后工作区应当干净");
    assert_eq!(snap.head.oid.as_deref(), Some(result.oid.as_str()));
}

/// 只读沙盒模式：写操作必须被拒（fail-closed）
#[test]
fn write_gate_rejects_when_readonly() {
    let Some(repo) = TempRepo::new() else { return };
    repo.write("a.txt", "hello\n");
    let gate = WriteGate::new(false);

    let staged = super::stage::stage(&repo.path(), &gate, &["a.txt".to_string()]);
    assert!(staged.is_err(), "只读模式下暂存必须失败");
    let committed = super::commit::commit(&repo.path(), &gate, "x");
    assert!(committed.is_err(), "只读模式下提交必须失败");
    let switched = branch::switch(&repo.path(), &gate, "feature", true, None, false);
    assert!(switched.is_err(), "只读模式下切分支必须失败");
    // 只读命令不受影响
    assert!(super::status::status(&repo.path()).is_ok());
}

/// 差异的两侧内容：未暂存 = INDEX ↔ 工作区；已暂存 = HEAD ↔ INDEX
#[test]
fn diff_sides_scope_semantics() {
    let Some(repo) = TempRepo::new() else { return };
    let gate = WriteGate::new(true);
    repo.write("a.txt", "one\ntwo\n");
    super::stage::stage(&repo.path(), &gate, &["a.txt".to_string()]).unwrap();
    super::commit::commit(&repo.path(), &gate, "init").unwrap();

    // 已暂存侧：HEAD（one/two）→ INDEX（one/two/three）
    repo.write("a.txt", "one\ntwo\nthree\n");
    super::stage::stage(&repo.path(), &gate, &["a.txt".to_string()]).unwrap();
    let staged = super::diff::sides(&repo.path(), "a.txt", DiffScope::Index, None).unwrap();
    assert_eq!(staged.old_text.as_deref(), Some("one\ntwo\n"));
    assert_eq!(staged.new_text.as_deref(), Some("one\ntwo\nthree\n"));
    assert!(!staged.binary);

    // 未暂存侧：INDEX（one/two/three）→ 工作区（改过）
    repo.write("a.txt", "one\ntwo\nthree\nfour\n");
    let work = super::diff::sides(&repo.path(), "a.txt", DiffScope::Worktree, None).unwrap();
    assert_eq!(work.old_text.as_deref(), Some("one\ntwo\nthree\n"));
    assert_eq!(work.new_text.as_deref(), Some("one\ntwo\nthree\nfour\n"));
}

/// ⚠️ 换行格式**不许进差异**（两侧一律归一化成 LF）—— 实测反馈：「更改」里的文件 diff 没起作用，
/// 而 `git add` 之后（两侧都来自对象库）又正常了。根因：旧侧是对象库里的 LF，新侧是工作区磁盘上的
/// CRLF（Windows + `core.autocrlf=true` 的常规形态），不归一化就是「每一行都不同」= 整文件一片红绿。
#[test]
fn diff_sides_normalizes_line_endings() {
    let Some(repo) = TempRepo::new() else { return };
    let gate = WriteGate::new(true);
    repo.write("a.txt", "one\ntwo\n");
    super::stage::stage(&repo.path(), &gate, &["a.txt".to_string()]).unwrap();
    super::commit::commit(&repo.path(), &gate, "init").unwrap();

    // 工作区换成 CRLF 并不真的只改了一处：改动只有 `three` 那一行
    repo.write("a.txt", "one\r\ntwo\r\nthree\r\n");
    let work = super::diff::sides(&repo.path(), "a.txt", DiffScope::Worktree, None).unwrap();
    assert_eq!(
        work.old_text.as_deref(),
        Some("one\ntwo\n"),
        "旧侧（index）不该带 \\r"
    );
    assert_eq!(
        work.new_text.as_deref(),
        Some("one\ntwo\nthree\n"),
        "新侧（工作区）也归一到 LF：否则每一行都会被算成改动"
    );
    assert!(!work.truncated);

    // 已暂存侧同理（两侧都来自对象库，换行已经一致——这条守着归一化不破坏既有语义）
    super::stage::stage(&repo.path(), &gate, &["a.txt".to_string()]).unwrap();
    let staged = super::diff::sides(&repo.path(), "a.txt", DiffScope::Index, None).unwrap();
    assert_eq!(staged.old_text.as_deref(), Some("one\ntwo\n"));
    assert_eq!(staged.new_text.as_deref(), Some("one\ntwo\nthree\n"));
}

/// ⚠️ **删除的文件没有「新侧」** —— 界面据此整栏不画「新文件」（`domain/git::singleSideOf`）。
/// 契约点：删除时新侧必须是 `None`（**不是空串**）；写成 `Some("")` 界面就会画出一栏空白。
#[test]
fn diff_sides_deleted_file_leaves_new_side_empty() {
    let Some(repo) = TempRepo::new() else { return };
    let gate = WriteGate::new(true);
    repo.write("a.txt", "one\ntwo\n");
    super::stage::stage(&repo.path(), &gate, &["a.txt".to_string()]).unwrap();
    super::commit::commit(&repo.path(), &gate, "init").unwrap();

    // 工作区删除（未暂存侧）：旧 = index，新 = 没了
    std::fs::remove_file(repo.dir.join("a.txt")).unwrap();
    let work = super::diff::sides(&repo.path(), "a.txt", DiffScope::Worktree, None).unwrap();
    assert_eq!(work.old_text.as_deref(), Some("one\ntwo\n"));
    assert!(work.new_text.is_none(), "工作区已删的文件不该有「新侧」内容");

    // 暂存删除（已暂存侧）：旧 = HEAD，新 = index 里也没了
    super::stage::stage(&repo.path(), &gate, &["a.txt".to_string()]).unwrap();
    let staged = super::diff::sides(&repo.path(), "a.txt", DiffScope::Index, None).unwrap();
    assert_eq!(staged.old_text.as_deref(), Some("one\ntwo\n"));
    assert!(staged.new_text.is_none(), "已暂存的删除同样只有旧侧");
}

/// 二进制文件不拉正文
#[test]
fn diff_sides_flags_binary() {
    let Some(repo) = TempRepo::new() else { return };
    let gate = WriteGate::new(true);
    repo.write("a.txt", "text\n");
    super::stage::stage(&repo.path(), &gate, &["a.txt".to_string()]).unwrap();
    super::commit::commit(&repo.path(), &gate, "init").unwrap();

    std::fs::write(repo.dir.join("bin.dat"), [0x00u8, 0x01, 0x02, 0x00]).unwrap();
    super::stage::stage(&repo.path(), &gate, &["bin.dat".to_string()]).unwrap();
    let sides = super::diff::sides(&repo.path(), "bin.dat", DiffScope::Index, None).unwrap();
    assert!(sides.binary);
    assert!(sides.old_text.is_none() && sides.new_text.is_none());
}

/// 分支：新建 / 列出 / 切回；非法名字被 `check-ref-format` 拒掉
#[test]
fn branch_create_list_switch() {
    let Some(repo) = TempRepo::new() else { return };
    let gate = WriteGate::new(true);
    repo.write("a.txt", "hello\n");
    super::stage::stage(&repo.path(), &gate, &["a.txt".to_string()]).unwrap();
    super::commit::commit(&repo.path(), &gate, "init").unwrap();

    let first = super::status::status(&repo.path()).unwrap().head.branch.unwrap();

    let after = branch::switch(&repo.path(), &gate, "feature/x", true, None, false).unwrap();
    assert_eq!(after.head.branch.as_deref(), Some("feature/x"));

    let list = branch::list(&repo.path()).unwrap();
    let names: Vec<&str> = list.iter().map(|b| b.name.as_str()).collect();
    assert!(names.contains(&"feature/x"));
    assert!(names.contains(&first.as_str()));
    assert!(list[0].is_head, "当前分支必须排在最前");
    assert_eq!(list[0].name, "feature/x");

    let back = branch::switch(&repo.path(), &gate, &first, false, None, false).unwrap();
    assert_eq!(back.head.branch.as_deref(), Some(first.as_str()));
}

/// ⚠️ 切**远程分支**：`git switch origin/x` 会直接 fatal（「a branch is expected, got remote branch」，
/// 退出码 128）—— git 的 switch 只收本地分支名。这就是线上那条报错（实测反馈）。
/// 只有 `--detach` 能落到它的提交上；detach 之后必须还能切回本地分支（否则一去不返）。
#[test]
fn switch_remote_branch_detaches() {
    let Some(repo) = TempRepo::new() else { return };
    let gate = WriteGate::new(true);
    repo.write("a.txt", "hello\n");
    super::stage::stage(&repo.path(), &gate, &["a.txt".to_string()]).unwrap();
    super::commit::commit(&repo.path(), &gate, "init").unwrap();

    let snap = super::status::status(&repo.path()).unwrap();
    let oid = snap.head.oid.clone().unwrap();
    let local = snap.head.branch.clone().unwrap();

    // 造一个「远程有、本地没有」的分支（`git fetch` 之后就是这个形态）
    repo.git(&["update-ref", "refs/remotes/origin/feature-x", &oid]);
    let list = branch::list(&repo.path()).unwrap();
    assert!(
        list.iter()
            .any(|b| b.is_remote && b.name == "origin/feature-x"),
        "远程分支必须在列表里 —— 界面就是从这里拿到名字的"
    );

    // 不 detach = 线上那条报错
    let plain = branch::switch(&repo.path(), &gate, "origin/feature-x", false, None, false);
    assert!(plain.is_err(), "git switch <远程分支> 必须失败");

    // detach：落在那个提交上，且 HEAD 不在任何分支上
    let detached =
        branch::switch(&repo.path(), &gate, "origin/feature-x", false, None, true).unwrap();
    assert_eq!(detached.head.branch, None, "detach 之后 HEAD 不在任何分支上");
    assert_eq!(detached.head.oid.as_deref(), Some(oid.as_str()));

    // 回得来：面板上那个「游离 HEAD」入口就靠这条
    let back = branch::switch(&repo.path(), &gate, &local, false, None, false).unwrap();
    assert_eq!(back.head.branch.as_deref(), Some(local.as_str()));

    // 两个动作互斥（界面不会这么传，但闸门要拦住）
    assert!(branch::switch(&repo.path(), &gate, "x", true, None, true).is_err());
}

/// ⚠️ 冲突路径在 index 里**没有 stage 0**：`git show :<path>` 直接 128，而取不到的一侧会被当成「空」
/// —— 旧实现在界面上就是「整份文件（连 `<<<<<<<` 标记）显示成全新增」（实测反馈）。
/// 两栏必须取 stage 2（ours）/ stage 3（theirs）。
#[test]
fn conflict_diff_shows_ours_and_theirs() {
    let Some(repo) = TempRepo::new() else { return };
    repo.write("a.txt", "base\n");
    repo.git(&["add", "-A"]);
    repo.git(&["commit", "-q", "-m", "base"]);
    let base = repo.git(&["rev-parse", "--abbrev-ref", "HEAD"]).trim().to_string();

    repo.git(&["checkout", "-q", "-b", "feature"]);
    repo.write("a.txt", "feature\n");
    repo.git(&["commit", "-q", "-am", "feature"]);

    repo.git(&["checkout", "-q", &base]);
    repo.write("a.txt", "main\n");
    repo.git(&["commit", "-q", "-am", "main"]);

    // 两边改同一行 → merge 必然冲突（退出码 1）：这里要一条**允许失败**的调用
    //（`TempRepo::git` 断言成功，用不了）
    let merged = super::cli::GitCmd::write(&repo.path())
        .args(["merge", "feature"])
        .run()
        .expect("git 起不来");
    assert!(!merged.ok(), "两边改同一行，merge 必须冲突");

    let snap = super::status::status(&repo.path()).unwrap();
    assert!(
        snap.entries
            .iter()
            .any(|e| e.path == "a.txt" && e.kind == super::EntryKind::Unmerged),
        "工作区必须处于未合并状态（否则这条用例测不到目标分支）"
    );

    let sides =
        super::diff::sides(&repo.path(), "a.txt", super::DiffScope::Worktree, None).unwrap();
    let old = sides.old_text.clone().unwrap_or_default();
    let new = sides.new_text.clone().unwrap_or_default();
    assert_eq!(old, "main\n", "旧侧 = ours（当前分支）");
    assert_eq!(new, "feature\n", "新侧 = theirs（合入的那边）");
    assert!(
        !old.contains("<<<<<<<") && !new.contains("<<<<<<<"),
        "不许把冲突标记当内容摆进差异"
    );
}

/// 提交详情：清单**相对第一个父提交**，两侧内容取 `<oid>^` / `<oid>`。
/// root 提交没有父 —— 旧侧为空、清单全是新增（这一支不写清，“点第一个提交”就崩）。
#[test]
fn commit_detail_and_file_sides() {
    let Some(repo) = TempRepo::new() else { return };
    repo.write("a.txt", "one\n");
    repo.write("b.txt", "bye\n");
    repo.git(&["add", "-A"]);
    repo.git(&["commit", "-q", "-m", "init\n\n正文第二段"]);

    // 第二个提交：改 a.txt、删 b.txt、加 c.txt
    repo.write("a.txt", "one\ntwo\n");
    std::fs::remove_file(repo.dir.join("b.txt")).unwrap();
    repo.write("c.txt", "new\n");
    repo.git(&["add", "-A"]);
    repo.git(&["commit", "-q", "-m", "second"]);

    let snap = super::status::status(&repo.path()).unwrap();
    let oid = snap.head.oid.clone().unwrap();
    let detail = super::show::detail(&repo.path(), &oid).unwrap();
    assert!(detail.short_oid.len() >= 7, "短 oid 由 git 自己给");
    assert_eq!(detail.message, "second");
    assert_eq!(detail.parents.len(), 1);
    let mut statuses: Vec<(&str, char)> = detail
        .files
        .iter()
        .map(|f| (f.path.as_str(), f.status))
        .collect();
    statuses.sort();
    assert_eq!(
        statuses,
        vec![("a.txt", 'M'), ("b.txt", 'D'), ("c.txt", 'A')]
    );

    let sides = super::show::file_sides(&repo.path(), &oid, "a.txt", None, None).unwrap();
    assert_eq!(sides.old_text.as_deref(), Some("one\n"));
    assert_eq!(sides.new_text.as_deref(), Some("one\ntwo\n"));

    // 删除的文件：新侧不存在 → 空侧（界面上就是单栏）
    let gone = super::show::file_sides(&repo.path(), &oid, "b.txt", None, None).unwrap();
    assert_eq!(gone.old_text.as_deref(), Some("bye\n"));
    assert_eq!(gone.new_text, None);

    // root 提交：没有 `<oid>^`，旧侧为空、清单全量新增
    let root_oid = detail.parents[0].clone();
    let root = super::show::detail(&repo.path(), &root_oid).unwrap();
    assert!(root.parents.is_empty());
    assert_eq!(root.files.len(), 2);
    assert!(root.files.iter().all(|f| f.status == 'A'));
    assert!(
        root.message.starts_with("init"),
        "详情要的是**完整**信息（含正文），不是列表里的单行标题"
    );
    let root_sides =
        super::show::file_sides(&repo.path(), &root_oid, "a.txt", None, None).unwrap();
    assert_eq!(root_sides.old_text, None, "root 提交没有父 → 旧侧空");
    assert_eq!(root_sides.new_text.as_deref(), Some("one\n"));
}

/// amend：把暂存内容并入上一条（不多出一条提交）；undo：撤掉提交但**改动留在暂存区**。
/// root 提交那一支单独守：`HEAD~1` 在只有一条提交时不存在，得走 `update-ref -d HEAD`。
#[test]
fn amend_and_undo_last_commit() {
    let Some(repo) = TempRepo::new() else { return };
    let gate = WriteGate::new(true);
    repo.write("a.txt", "one\n");
    super::stage::stage(&repo.path(), &gate, &["a.txt".to_string()]).unwrap();
    super::commit::commit(&repo.path(), &gate, "init").unwrap();

    // amend：改内容 + 改信息，仍然只有一条提交
    repo.write("a.txt", "one\ntwo\n");
    super::stage::stage(&repo.path(), &gate, &["a.txt".to_string()]).unwrap();
    let amended = super::commit::amend(&repo.path(), &gate, "init (amended)").unwrap();
    assert_eq!(amended.summary, "init (amended)");
    let log = super::log::log(&repo.path(), 0, 10, super::LogScope::Head, None).unwrap();
    assert_eq!(log.len(), 1, "amend 不许造出第二条提交");
    let sides =
        super::show::file_sides(&repo.path(), &log[0].oid, "a.txt", None, None).unwrap();
    assert_eq!(sides.new_text.as_deref(), Some("one\ntwo\n"));

    // undo（root 提交）：HEAD 回到 unborn，文件仍在 index 里（x = 'A'）
    let snap = super::commit::undo_last(&repo.path(), &gate).unwrap();
    assert_eq!(snap.head.oid, None, "唯一一条提交被撤掉 → unborn HEAD");
    assert!(
        snap.entries.iter().any(|e| e.path == "a.txt" && e.x == 'A'),
        "改动必须留在暂存区（reset --soft 的语义）"
    );
    // 再撤一次：没有可撤的（不能把失败吞成「成功」）
    assert!(super::commit::undo_last(&repo.path(), &gate).is_err());

    // 两条提交时撤的是最后一条（普通分支）
    super::commit::commit(&repo.path(), &gate, "first").unwrap();
    repo.write("b.txt", "new\n");
    super::stage::stage(&repo.path(), &gate, &["b.txt".to_string()]).unwrap();
    super::commit::commit(&repo.path(), &gate, "second").unwrap();
    let back = super::commit::undo_last(&repo.path(), &gate).unwrap();
    assert!(
        back.entries.iter().any(|e| e.path == "b.txt" && e.x == 'A'),
        "被撤提交的内容要回到暂存区"
    );
    let log = super::log::log(&repo.path(), 0, 10, super::LogScope::Head, None).unwrap();
    assert_eq!(log[0].subject, "first");
}

/// 删 / 改分支：`-d` 必须拦住未合并的分支（安全网），删当前分支必须被拒，新名字要过正法校验。
#[test]
fn branch_delete_and_rename() {
    let Some(repo) = TempRepo::new() else { return };
    let gate = WriteGate::new(true);
    repo.write("a.txt", "hi\n");
    super::stage::stage(&repo.path(), &gate, &["a.txt".to_string()]).unwrap();
    super::commit::commit(&repo.path(), &gate, "init").unwrap();
    let cur = super::status::status(&repo.path())
        .unwrap()
        .head
        .branch
        .unwrap();

    // 造一个「未合并」的分支（有它自己的提交，且没合回当前分支）
    branch::switch(&repo.path(), &gate, "wip", true, None, false).unwrap();
    repo.write("a.txt", "wip\n");
    repo.git(&["commit", "-qam", "wip"]);
    branch::switch(&repo.path(), &gate, &cur, false, None, false).unwrap();

    // `-d` 拦未合并（这层安全网不能被默默换成 `-D`）
    assert!(branch::delete(&repo.path(), &gate, "wip", false).is_err());
    let list = branch::delete(&repo.path(), &gate, "wip", true).unwrap();
    assert!(!list.iter().any(|b| b.name == "wip"));

    // 删当前分支：git 会拒，我们如实回传（不做「先切走再删」）
    assert!(branch::delete(&repo.path(), &gate, &cur, false).is_err());

    // 重命名（含当前分支）
    branch::switch(&repo.path(), &gate, "topic", true, None, false).unwrap();
    let list = branch::rename(&repo.path(), &gate, "topic", "topic2").unwrap();
    assert!(list.iter().any(|b| b.name == "topic2"));
    assert!(!list.iter().any(|b| b.name == "topic"));
    // 新名字不合法直接拒（不用等 git 报 128）
    assert!(branch::rename(&repo.path(), &gate, "topic2", "bad name").is_err());
}

/// `git init`：初始化后能探测到；只读沙盒模式直接拒（fail-closed，不往磁盘写 `.git`）
#[test]
fn init_makes_a_repository() {
    if !git_available() {
        return;
    }
    let mk = || {
        let dir = std::env::temp_dir().join(format!("virlen_git_init_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        (dir.clone(), dir.to_string_lossy().replace('\\', "/"))
    };

    let (dir, path) = mk();
    let info = super::repo::init(&path, &WriteGate::new(true)).unwrap();
    assert!(
        same_path(&info.root, &path),
        "init 后的仓库根应为 {path}，实际 {}",
        info.root
    );
    assert!(!info.bare);
    // 目录不存在 → 明确报错（而不是静默建一个新目录）
    assert!(super::repo::init(
        &format!("{}/nope", path),
        &WriteGate::new(true)
    )
    .is_err());
    let _ = std::fs::remove_dir_all(&dir);

    let (dir2, path2) = mk();
    assert!(super::repo::init(&path2, &WriteGate::new(false)).is_err());
    assert!(
        !std::path::Path::new(&path2).join(".git").exists(),
        "只读沙盒模式下不该建出 .git"
    );
    let _ = std::fs::remove_dir_all(&dir2);
}

#[test]
fn check_ref_format_rejects_invalid_names() {
    let Some(repo) = TempRepo::new() else { return };
    assert!(branch::check_ref_format(&repo.path(), "feature/ok-1").unwrap());
    assert!(!branch::check_ref_format(&repo.path(), "").unwrap());
    assert!(!branch::check_ref_format(&repo.path(), "bad name").unwrap());
    assert!(!branch::check_ref_format(&repo.path(), "bad..name").unwrap());
    assert!(!branch::check_ref_format(&repo.path(), "-leading-dash").unwrap());
    assert!(!branch::check_ref_format(&repo.path(), "trailing.lock").unwrap());
}

/// ⚠️ 工作目录是**仓库子目录**时也必须一切正常 —— 这是「git add 路径错位（退出码 128）」那个
/// 线上 bug 的回归用例（根因与复现见 `docs/agents/14-git-management.md` §11.53 ⑫）：
/// `git status --porcelain=v2` 的路径**随 cwd 变**（子目录里得到 `../top.txt`），而 `git add` /
/// `git restore` 又按 cwd 解释收到的路径 —— 旧实现没统一基准，于是「界面上是 `confnose/package.json`、
/// git 却按 `usercustom/confnose/package.json` 去找」，报 `pathspec ... did not match any files`。
#[test]
fn subdirectory_workspace_uses_repo_root_paths() {
    let Some(repo) = TempRepo::new() else { return };
    let gate = WriteGate::new(true);
    let sub = format!("{}/sub", repo.path());

    repo.write("top.txt", "top\n");
    repo.write("sub/inner.txt", "inner\n");
    repo.git(&["add", "-A"]);
    repo.git(&["commit", "-q", "-m", "init"]);

    repo.write("top.txt", "top changed\n");
    repo.write("sub/inner.txt", "inner changed\n");

    // ① 快照路径必须**仓库根相对**：子目录内外都不许出现 `..`
    let snap = super::status::status(&sub).expect("子目录工作目录下的 status 失败");
    let paths: Vec<&str> = snap.entries.iter().map(|e| e.path.as_str()).collect();
    assert!(
        paths.contains(&"top.txt"),
        "工作目录之外的文件也要用根相对路径：{:?}",
        paths
    );
    assert!(paths.contains(&"sub/inner.txt"), "工作目录内的文件：{:?}", paths);
    assert!(
        paths.iter().all(|p| super::status::is_root_relative(p)),
        "路径不该带 `..`（否则写操作会被 git 按别的目录解释）：{:?}",
        paths
    );

    // ② 用根相对路径暂存 —— 旧实现这里正是 128 `pathspec ... did not match any files`
    let after = super::stage::stage(&sub, &gate, &["top.txt".to_string()]).unwrap();
    let top = after.entries.iter().find(|e| e.path == "top.txt").unwrap();
    assert_eq!(top.x, 'M', "暂存必须落到正确的文件上（而不是报 did not match）");

    // ③ 差异：`<rev>:<path>` 取仓库根相对路径（旧实现写 `:./<path>` = cwd 相对 → unknown revision）
    let work = super::diff::sides(&sub, "sub/inner.txt", DiffScope::Worktree, None).unwrap();
    assert_eq!(work.old_text.as_deref(), Some("inner\n"));
    assert_eq!(work.new_text.as_deref(), Some("inner changed\n"));
    let staged = super::diff::sides(&sub, "top.txt", DiffScope::Index, None).unwrap();
    assert_eq!(staged.old_text.as_deref(), Some("top\n"));
    assert_eq!(staged.new_text.as_deref(), Some("top changed\n"));

    // ④ 分支与提交同样接受「仓库内的任意目录」作为工作目录
    assert!(!branch::list(&sub).unwrap().is_empty());
    assert!(branch::check_ref_format(&sub, "feature/subdir").unwrap());
    // 两个文件都暂存后再提交（上一步只暂存了 top.txt）—— 提交后工作区才是干净的
    super::stage::stage(&sub, &gate, &["sub/inner.txt".to_string()]).unwrap();
    let result = super::commit::commit(&sub, &gate, "feat: 子目录工作目录提交\n").unwrap();
    assert_eq!(result.summary, "feat: 子目录工作目录提交");
    assert!(
        super::status::status(&sub).unwrap().entries.is_empty(),
        "提交后工作区应当干净"
    );
}

/// ⚠️ `-z` 不只是分隔符 —— 它同时决定**路径基准**：porcelain=v2 **不带 `-z`** 时路径相对 cwd
///（子目录工作目录下得到 `../top.txt`），**带 `-z`** 才是仓库根相对。我们对外承诺「路径一律
/// 仓库根相对」，所以 `status` 里的 `-z` 不能删（删了写操作就会 128）—— 删了的话
/// `ensure_root_relative` 也会当场报错，不会静默交付。
#[test]
fn porcelain_v2_path_basis_depends_on_z() {
    let Some(repo) = TempRepo::new() else { return };
    repo.write("top.txt", "top\n");
    repo.write("sub/inner.txt", "inner\n");
    repo.git(&["add", "-A"]);
    repo.git(&["commit", "-q", "-m", "init"]);
    repo.write("top.txt", "changed\n");

    let sub = format!("{}/sub", repo.path());
    let run = |extra: &[&str]| -> Vec<String> {
        let mut cmd = GitCmd::read(&sub).arg("status").arg("--porcelain=v2");
        for a in extra {
            cmd = cmd.arg(*a);
        }
        let out = cmd.run().expect("git status 起不来");
        parse_status(&out.stdout, 100)
            .unwrap()
            .entries
            .iter()
            .map(|e| e.path.clone())
            .collect()
    };

    // 不带 `-z`：路径相对 cwd（工作目录是子目录 → `../top.txt`）
    assert_eq!(
        run(&["--untracked-files=all"]),
        vec!["../top.txt".to_string()],
        "不带 -z 时 porcelain 的路径是 cwd 相对"
    );
    // 带 `-z`：路径变成仓库根相对
    assert_eq!(
        run(&["-z", "--untracked-files=all"]),
        vec!["top.txt".to_string()],
        "带 -z 时是仓库根相对（我们依赖的口径）"
    );
    // 对外入口永远走后者 → 路径基准是稳定的
    assert_eq!(
        super::status::status(&sub).unwrap().entries[0].path,
        "top.txt"
    );
}

// ==================== 三、提交记录（`git log`） ====================

/// `git log -z` 的布局：**NUL 分隔记录**（末尾那个空段要丢掉）、**US 分隔字段**、subject 在末位。
///
/// ⚠️ 不带 `-z` 时 git 用换行分隔记录（实测：输出里一个 NUL 都没有）—— 这条用例钉住「必须按 NUL 切」。
#[test]
fn parse_log_pins_record_and_field_layout() {
    let raw = concat!(
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\u{1f}aaaaaaa\u{1f}张三\u{1f}z@example.com\u{1f}2026-10-16T10:29:46+08:00\u{1f}\u{1f}\u{1f}fix: 优化 diff\0",
        "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\u{1f}bbbbbbb\u{1f}virlen test\u{1f}t@example.com\u{1f}2026-10-15T18:05:15+08:00\u{1f}1111111111111111111111111111111111111111 2222222222222222222222222222222222222222\u{1f}HEAD -> refs/heads/master, refs/remotes/origin/master\u{1f}feat: 标题里带 \u{1f} 的情况\0",
    )
    .as_bytes();

    let list = parse_log(raw);
    assert_eq!(list.len(), 2, "末尾的 NUL 不该多切出一条空记录");
    assert_eq!(list[0].oid.len(), 40);
    assert_eq!(list[0].short_oid, "aaaaaaa");
    assert_eq!(list[0].author_name, "张三");
    assert_eq!(list[0].author_email, "z@example.com");
    assert_eq!(list[0].author_time, "2026-10-16T10:29:46+08:00");
    assert_eq!(list[0].subject, "fix: 优化 diff");
    // root 提交的 `%P` / `%D` 都是空串 → **空数组**，不许切出一个空元素（否则图会给它连一条空线）
    assert!(list[0].parents.is_empty());
    assert!(list[0].refs.is_empty());
    // merge 的父是**空格分隔**的两个 oid；`%D` 是 `, ` 分隔，`HEAD -> …` 原样保留（拆解在前端）
    assert_eq!(list[1].parents.len(), 2);
    assert_eq!(list[1].parents[0].len(), 40);
    assert_eq!(
        list[1].refs,
        vec![
            "HEAD -> refs/heads/master".to_string(),
            "refs/remotes/origin/master".to_string()
        ]
    );
    // subject 是唯一的自由文本：里面含 US 也只会留在最后一段（不许把字段数切乱）
    assert_eq!(list[1].subject, "feat: 标题里带 \u{1f} 的情况");
    assert_eq!(list[1].author_name, "virlen test");

    // 字段不够的残缺记录直接丢掉（不编造半条记录）
    assert!(parse_log(b"only-one-field\0").is_empty());
    assert!(parse_log(b"").is_empty());
    // 记录首尾的换行要削掉（某些形态下 NUL 后会跟着一个换行），但**空格不许削**
    // ⚠️ 字节串里只能用 `\x1f`（`\u{…}` 不能出现在字节串里）
    let padded = b"\ncccccccccccccccccccccccccccccccccccccccc\x1fccccccc\x1fA\x1fa@b.c\x1f2026-01-01T00:00:00+08:00\x1f\x1f\x1f leading and trailing \r\n";
    let one = parse_log(padded);
    assert_eq!(one.len(), 1);
    assert_eq!(one[0].oid.len(), 40, "记录前的换行必须被削掉");
    assert_eq!(one[0].subject, " leading and trailing ", "标题首尾的空格是用户真写的");
}

/// 真仓库：HEAD 最新在前、作者 / 时间 / oid 齐备、分页（`--skip` / `--max-count`）与越界页。
/// 空仓（unborn HEAD）必须回**空列表而不是错误**（`git log` 在这里以 128 退出）。
#[test]
fn log_end_to_end_on_real_repo() {
    let Some(repo) = TempRepo::new() else { return };
    let gate = WriteGate::new(true);

    assert!(
        super::log::log(&repo.path(), 0, 50, LogScope::Head, None)
            .unwrap()
            .is_empty(),
        "还没有任何提交时应当是空列表（unborn HEAD 不是错误）"
    );

    for i in 1..=3 {
        repo.write("a.txt", &format!("line {}\n", i));
        super::stage::stage(&repo.path(), &gate, &["a.txt".to_string()]).unwrap();
        super::commit::commit(&repo.path(), &gate, &format!("feat: 第 {} 次提交\n", i)).unwrap();
    }

    let all = super::log::log(&repo.path(), 0, 50, LogScope::Head, None).unwrap();
    assert_eq!(all.len(), 3);
    assert_eq!(all[0].subject, "feat: 第 3 次提交", "最新的提交必须排在最前");
    assert_eq!(all[2].subject, "feat: 第 1 次提交");
    assert_eq!(all[0].author_name, "virlen test");
    assert_eq!(all[0].author_email, "test@example.com");
    assert!(
        all[0].author_time.starts_with("20") && all[0].author_time.contains('T'),
        "作者时间应是 ISO 8601：{}",
        all[0].author_time
    );
    assert_eq!(all[0].oid.len(), 40);
    assert!(all[0].oid.starts_with(&all[0].short_oid));

    // 分页：skip = 已经拿过多少条（界面「加载更多」就是把它往前推）
    let page = super::log::log(&repo.path(), 1, 1, LogScope::Head, None).unwrap();
    assert_eq!(page.len(), 1);
    assert_eq!(page[0].subject, "feat: 第 2 次提交");

    // 越界的一页 = 空列表（界面据此收掉「加载更多」），不是错误
    assert!(super::log::log(&repo.path(), 10, 50, LogScope::Head, None)
        .unwrap()
        .is_empty());
    // limit 传 0 也不许把 `--max-count` 变成 0（夹到 1）
    assert_eq!(
        super::log::log(&repo.path(), 0, 0, LogScope::Head, None)
            .unwrap()
            .len(),
        1
    );
}

/// 路径不变式对读操作同样成立：**仓库子目录**也能拿到同一份提交记录（cwd 统一到仓库根）
#[test]
fn log_accepts_subdirectory_workspace() {
    let Some(repo) = TempRepo::new() else { return };
    let gate = WriteGate::new(true);
    repo.write("sub/inner.txt", "inner\n");
    super::stage::stage(&repo.path(), &gate, &["sub/inner.txt".to_string()]).unwrap();
    super::commit::commit(&repo.path(), &gate, "init").unwrap();

    let sub = format!("{}/sub", repo.path());
    let list = super::log::log(&sub, 0, 50, LogScope::Head, None).unwrap();
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].subject, "init");
}

/// 提交图（`LogScope::All`）在真仓库上的形状 —— 四条都是**实测出来**的差别，少一条图就不对：
///
/// 1. **merge 的父有两个**且都在同一份列表里（否则线是断的）；root 的父是空数组；
/// 2. **引用取全名**（`--decorate=full`）：`HEAD -> refs/heads/x` / `refs/tags/x`；
///    短名分不出本地与远程（本地分支名可以含 `/`）；
/// 3. **别的分支的提交只在 All 里**（`Head` 范围与「提交记录」弹窗行为完全一致）；
/// 4. **stash 的 WIP 提交不进图** —— 不是「我们没搜到」而是「有意排除」：`git log --all` 确实会带上它
///    （用例先断言这个前提），而它有两个父、画出来是一团乱麻。
#[test]
fn log_all_graph_shape_on_real_repo() {
    let Some(repo) = TempRepo::new() else { return };
    repo.write("a.txt", "1\n");
    repo.git(&["add", "-A"]);
    repo.git(&["commit", "-q", "-m", "A"]);
    // 默认分支名交给 git 自己报（master / main 都行）
    let main = repo.git(&["rev-parse", "--abbrev-ref", "HEAD"]).trim().to_string();

    // 一条分叉出去、又合回来的历史（图上的一个菱形）
    repo.git(&["checkout", "-q", "-b", "feat/x"]);
    repo.write("b.txt", "2\n");
    repo.git(&["add", "-A"]);
    repo.git(&["commit", "-q", "-m", "B"]);
    repo.git(&["checkout", "-q", &main]);
    repo.write("c.txt", "3\n");
    repo.git(&["add", "-A"]);
    repo.git(&["commit", "-q", "-m", "C"]);
    repo.git(&["merge", "-q", "--no-ff", "-m", "M", "feat/x"]);
    repo.git(&["tag", "v1.0"]);

    // 另一条**没有合进来**的分支：它是「All 与 Head 有差别」的判据
    repo.git(&["checkout", "-q", "-b", "side", "HEAD~1"]);
    repo.write("d.txt", "4\n");
    repo.git(&["add", "-A"]);
    repo.git(&["commit", "-q", "-m", "D"]);
    let side_oid = repo.git(&["rev-parse", "HEAD"]).trim().to_string();
    repo.git(&["checkout", "-q", &main]);

    let all = super::log::log(&repo.path(), 0, 50, LogScope::All, None).unwrap();
    // ⚠️ 不按「第 0 条」找 merge：另一条没合进来的分支 D 比它新，`--date-order` 会把 D 排在最前
    // （这本身也是「All 范围真的把并行分支放进来了」的旁证）
    let merge = all
        .iter()
        .find(|e| e.subject == "M")
        .expect("merge 提交要在列表里");
    assert_eq!(merge.parents.len(), 2, "merge 提交有两个父（连线靠它）");
    let oids: Vec<&str> = all.iter().map(|e| e.oid.as_str()).collect();
    for p in &merge.parents {
        assert!(
            oids.contains(&p.as_str()),
            "父 {} 必须也在同一份列表里，否则线是断的",
            p
        );
    }
    assert_eq!(merge.refs.len(), 2, "HEAD 那条 + 标签那条：{:?}", merge.refs);
    assert!(merge
        .refs
        .contains(&format!("HEAD -> refs/heads/{}", main)));
    // ⚠️ 标签带 `tag: ` 前缀（轻量标签也一样）—— 实测：`tag: refs/tags/v1.0`（不带 --decorate=full 时
    // 是 `tag: v1.0`）。前端的引用解析必须这个前缀当「标签」的判据，不能只看 `refs/tags/`
    assert!(merge.refs.contains(&"tag: refs/tags/v1.0".to_string()));

    // root 提交的父是空数组（不是 `[""]`）
    let root = all
        .iter()
        .find(|e| e.subject == "A")
        .expect("root 提交要在列表里");
    assert!(root.parents.is_empty(), "root 没有父");

    // 没合进来的分支：All 里有、Head 里没有
    assert!(oids.contains(&side_oid.as_str()), "All 范围要包含别的分支");
    let head_only = super::log::log(&repo.path(), 0, 50, LogScope::Head, None).unwrap();
    assert!(!head_only.iter().any(|e| e.oid == side_oid));

    // 布局前提：父必须排在子之后（`--date-order` 的保证，见模块头第 6 条）
    for (i, e) in all.iter().enumerate() {
        for p in &e.parents {
            if let Some(j) = all.iter().position(|x| &x.oid == p) {
                assert!(j > i, "父 {} 排在了子 {} 之前（第 {} 行）", p, e.oid, i);
            }
        }
    }

    // stash 的 WIP 提交：`--all` 会带上（先钉住这个前提），我们有意排除
    repo.write("dirty.txt", "dirty\n");
    repo.git(&["add", "-A"]);
    repo.git(&["stash", "-q"]);
    let stash_oid = repo.git(&["rev-parse", "refs/stash"]).trim().to_string();
    assert!(
        repo.git(&["log", "--all", "--format=%H"]).contains(&stash_oid),
        "前提：`git log --all` 确实会带上 stash（否则这条断言没有意义）"
    );
    let with_stash = super::log::log(&repo.path(), 0, 50, LogScope::All, None).unwrap();
    assert!(
        !with_stash.iter().any(|e| e.oid == stash_oid),
        "stash 的 WIP 提交不该画进提交图"
    );
}

/// 路径不变式的谓词与自检：非仓库根相对路径必须被拒（fail-closed）。
/// 静默交付这种路径，用户点暂存只会看到 128 的 `did not match`，且无从自查。
#[test]
fn root_relative_invariant_is_enforced() {
    assert!(super::status::is_root_relative("a/b.txt"));
    assert!(super::status::is_root_relative("中文 文件.txt"));
    assert!(!super::status::is_root_relative(""));
    assert!(!super::status::is_root_relative(".."));
    assert!(!super::status::is_root_relative("../a.txt"));
    assert!(!super::status::is_root_relative("a/../b.txt"));
    assert!(!super::status::is_root_relative("a/.."));

    let entry = |path: &str, orig: Option<&str>| ChangeEntry {
        path: path.to_string(),
        orig_path: orig.map(|s| s.to_string()),
        x: 'M',
        y: '.',
        kind: EntryKind::Ordinary,
    };
    let head = || HeadInfo {
        oid: None,
        branch: None,
        upstream: None,
        ahead: 0,
        behind: 0,
    };
    let ok = StatusSnapshot {
        head: head(),
        entries: vec![entry("a.txt", None)],
        truncated: false,
    };
    assert!(super::status::ensure_root_relative(&ok).is_ok());

    let bad = StatusSnapshot {
        head: head(),
        entries: vec![entry("../a.txt", None)],
        truncated: false,
    };
    assert!(super::status::ensure_root_relative(&bad).is_err());

    let bad_orig = StatusSnapshot {
        head: head(),
        entries: vec![entry("new.txt", Some("../old.txt"))],
        truncated: false,
    };
    assert!(
        super::status::ensure_root_relative(&bad_orig).is_err(),
        "rename 的旧路径也要查"
    );
}

// ==================== 四、远程（凭据策略 = SSH） ====================

/// 地址分类：SSH 的两种写法都得认，盘符不能被当成 scp 风格
#[test]
fn remote_kind_classification() {
    assert_eq!(super::remote::remote_kind("git@github.com:a/b.git"), RemoteKind::Ssh);
    assert_eq!(super::remote::remote_kind("ssh://git@host:22/a/b.git"), RemoteKind::Ssh);
    assert_eq!(super::remote::remote_kind("https://github.com/a/b.git"), RemoteKind::Https);
    assert_eq!(super::remote::remote_kind("http://host/a.git"), RemoteKind::Http);
    assert_eq!(super::remote::remote_kind("git://host/a.git"), RemoteKind::Git);
    assert_eq!(super::remote::remote_kind("file:///srv/a.git"), RemoteKind::File);
    // 本地路径：Windows 盘符**不是** scp 地址（冒号前只有一个字母）
    assert_eq!(super::remote::remote_kind("C:/repos/a.git"), RemoteKind::File);
    assert_eq!(super::remote::remote_kind("D:\\repos\\a.git"), RemoteKind::File);
    assert_eq!(super::remote::remote_kind("/srv/repos/a.git"), RemoteKind::File);
    assert_eq!(super::remote::remote_kind("../bare.git"), RemoteKind::File);
    assert_eq!(super::remote::remote_kind(""), RemoteKind::Other);
}

/// 界面 / 埋点里不允许出现令牌：userinfo 必须被抹掉，@ 之后的地址原样保留
#[test]
fn redact_url_strips_credentials() {
    assert_eq!(
        super::remote::redact_url("https://user:token@github.com/a/b.git"),
        "https://github.com/a/b.git"
    );
    assert_eq!(
        super::remote::redact_url("https://tok@host/a/b.git"),
        "https://host/a/b.git"
    );
    // 没有 userinfo / 没有协议 → 原样
    assert_eq!(
        super::remote::redact_url("https://github.com/a/b.git"),
        "https://github.com/a/b.git"
    );
    // `git@host:path` 里的 `git` 是用户名（不是密钥），保留
    assert_eq!(
        super::remote::redact_url("git@github.com:a/b.git"),
        "git@github.com:a/b.git"
    );
}

/// `git remote -v` 的 fetch / push 两行合并成一条；只有单边时另一个方向跟随
#[test]
fn parse_remotes_pairs_fetch_and_push() {
    let text = concat!(
        "origin\tgit@github.com:a/b.git (fetch)\n",
        "origin\tgit@github.com:a/b.git (push)\n",
        "backup\thttps://user:tok@host/b.git (fetch)\n",
    );
    let list = super::remote::parse_remotes(text);
    assert_eq!(list.len(), 2);
    assert_eq!(list[0].name, "origin");
    assert_eq!(list[0].kind, RemoteKind::Ssh);
    assert_eq!(list[0].push_url, "git@github.com:a/b.git");
    // 只有 fetch 行的远程：push_url 跟随 fetch
    assert_eq!(list[1].name, "backup");
    assert_eq!(list[1].push_url, "https://host/b.git");
    assert_eq!(list[1].url, "https://host/b.git", "令牌不能进界面");
}

/// 选远程：显式 → origin → 唯一一个 → 其余情况**不猜**
#[test]
fn pick_remote_prefers_origin_and_refuses_to_guess() {
    let one = super::remote::parse_remotes("origin\tgit@h:a/b.git (fetch)\n");
    assert_eq!(super::remote::pick(&one, None).unwrap().name, "origin");

    let two = super::remote::parse_remotes(concat!(
        "a\tgit@h:a/x.git (fetch)\n",
        "b\tgit@h:a/y.git (fetch)\n",
    ));
    assert!(
        super::remote::pick(&two, None).is_err(),
        "有多个远程又没指定时必须报错，不能猜"
    );
    assert_eq!(super::remote::pick(&two, Some("b")).unwrap().name, "b");
    assert!(super::remote::pick(&two, Some("nope")).is_err());
    assert!(super::remote::pick(&[], None).is_err());
}

/// 失败指引只对**明确模式**生效，其余原样透传（不猜原因）
#[test]
fn hint_for_maps_known_failures() {
    let hint = |s: &str| super::remote::hint_for(s).unwrap_or("");
    assert!(hint("git@github.com: Permission denied (publickey).").contains("ssh-agent"));
    assert!(hint("Host key verification failed.").contains("ssh -T"));
    assert!(hint("ssh: Could not resolve hostname github.com").contains("域名解析"));
    assert!(hint("fatal: could not read Username for 'https://x': terminal prompts disabled")
        .contains("SSH"));
    assert_eq!(hint("fatal: something unexpected"), "", "没把握的错不补话");
}

/// 推送 → 获取 → 拉取（快进）→ 分叉后拉取必须被拒。远程用**本机裸仓库路径**，不碰网络与凭据。
#[test]
fn remote_push_fetch_pull_against_local_remote() {
    let Some(up) = TempRepo::new_bare() else { return };
    let Some(repo) = TempRepo::new() else { return };
    let Some(other) = TempRepo::new() else { return };
    let gate = WriteGate::new(true);
    let url = up.path();

    repo.git(&["symbolic-ref", "HEAD", "refs/heads/main"]);
    repo.git(&["remote", "add", "origin", &url]);
    repo.write("a.txt", "one\n");
    repo.git(&["add", "-A"]);
    repo.git(&["commit", "-q", "-m", "init"]);

    let remotes = super::remote::list(&repo.path()).unwrap();
    assert_eq!(remotes.len(), 1);
    assert_eq!(remotes[0].name, "origin");
    assert_eq!(remotes[0].kind, RemoteKind::File, "本机路径远程");

    // 首次推送：自动 `-u`，跟踪关系随之建立（否则面板永远显示不了 ↑↓）
    let pushed = super::remote::push(&repo.path(), &gate, None, None).unwrap();
    assert_eq!(pushed.remote, "origin");
    assert_eq!(pushed.branch.as_deref(), Some("main"));
    let head = branch::list(&repo.path())
        .unwrap()
        .into_iter()
        .find(|b| b.is_head)
        .expect("缺当前分支");
    assert_eq!(head.upstream.as_deref(), Some("origin/main"));

    // 另一个仓库：fetch 只更新远程跟踪分支，**不动工作区**
    other.git(&["symbolic-ref", "HEAD", "refs/heads/main"]);
    other.git(&["remote", "add", "origin", &url]);
    super::remote::fetch(&other.path(), &gate, None, None).unwrap();
    assert!(
        !other.dir.join("a.txt").exists(),
        "fetch 不该碰工作区（那是 pull 的事）"
    );
    let tracked = other.git(&["rev-parse", "--verify", "refs/remotes/origin/main"]);
    assert!(!tracked.trim().is_empty(), "fetch 应当写下 origin/main");

    // pull（快进）把工作区带过来（比较前归一换行：Windows 上 `core.autocrlf=true` 会落 CRLF）
    super::remote::pull(&other.path(), &gate, None, None).unwrap();
    assert_eq!(
        std::fs::read_to_string(other.dir.join("a.txt"))
            .unwrap()
            .replace("\r\n", "\n"),
        "one\n"
    );

    // 分叉：两边各提交一次 → 快进不了，`--ff-only` 必须失败（不许偷偷造一条 merge 提交）
    repo.write("a.txt", "remote side\n");
    repo.git(&["commit", "-q", "-am", "remote change"]);
    super::remote::push(&repo.path(), &gate, None, None).unwrap();
    other.write("b.txt", "local side\n");
    other.git(&["add", "-A"]);
    other.git(&["commit", "-q", "-m", "local change"]);
    assert!(
        super::remote::pull(&other.path(), &gate, None, None).is_err(),
        "分叉时只允许快进失败，不许自动 merge"
    );
    assert_eq!(
        other.git(&["rev-list", "--count", "HEAD"]).trim(),
        "2",
        "失败的 pull 不能在本地留下 merge 提交"
    );

    // 连接测试（SSH 方案下验证密钥 / 指纹 / 网络的那条命令）也能跑通
    let test = super::remote::test_connection(&other.path(), None, None).unwrap();
    assert!(test.output.contains("refs/heads/main"));
}

/// 游离 HEAD 上拉取 / 推送必须被拒（按名字操作，没有名字就没法干）；写门禁也守着它们
#[test]
fn remote_refuses_detached_head_and_readonly_gate() {
    let Some(up) = TempRepo::new_bare() else { return };
    let Some(repo) = TempRepo::new() else { return };
    let gate = WriteGate::new(true);
    repo.git(&["symbolic-ref", "HEAD", "refs/heads/main"]);
    repo.git(&["remote", "add", "origin", &up.path()]);
    repo.write("a.txt", "one\n");
    repo.git(&["add", "-A"]);
    repo.git(&["commit", "-q", "-m", "init"]);
    repo.git(&["checkout", "-q", "--detach"]);

    assert!(super::remote::push(&repo.path(), &gate, None, None).is_err());
    assert!(super::remote::pull(&repo.path(), &gate, None, None).is_err());
    // fetch 不要求分支，但**过只读门禁**：fetch 也会写 refs/remotes
    assert!(super::remote::fetch(&repo.path(), &gate, None, None).is_ok());
    let readonly = WriteGate::new(false);
    assert!(super::remote::fetch(&repo.path(), &readonly, None, None).is_err());
}

// ==================== 三、行数统计（numstat） ====================

/// `--numstat -z` 的两种记录：普通改动 + rename（三列后紧跟旧 / 新路径）
#[test]
fn parse_numstat_pins_rename_and_binary_layout() {
    let raw = concat!(
        "12\t3\tsrc/a.rs\0",
        // rename：第三列为空，旧路径与新路径各占一条 NUL 记录
        "2\t0\t\0old name.txt\0new name.txt\0",
        // 二进制：两个 `-` → None（不是 0 行）
        "-\t-\tlogo.png\0",
    )
    .as_bytes();

    let list = super::numstat::parse_numstat(raw);
    assert_eq!(list.len(), 3, "rename 的旧 / 新路径不能被当成独立条目");

    assert_eq!(list[0].path, "src/a.rs");
    assert_eq!((list[0].added, list[0].deleted), (Some(12), Some(3)));
    assert_eq!(list[0].orig_path, None);

    assert_eq!(list[1].path, "new name.txt");
    assert_eq!(list[1].orig_path.as_deref(), Some("old name.txt"));
    assert_eq!((list[1].added, list[1].deleted), (Some(2), Some(0)));

    assert_eq!(list[2].path, "logo.png");
    assert_eq!((list[2].added, list[2].deleted), (None, None));
}

/// 真仓库：已暂存与未暂存分开统计；未跟踪按行数直接数；二进制不给数字
#[test]
fn numstat_end_to_end_splits_staged_and_worktree() {
    let Some(repo) = TempRepo::new() else { return };
    repo.write("tracked.txt", "one\ntwo\nthree\n");
    repo.write("staged.txt", "a\n");
    repo.git(&["add", "-A"]);
    repo.git(&["commit", "-q", "-m", "init"]);

    // 已暂存：+1
    repo.write("staged.txt", "a\nb\n");
    repo.git(&["add", "staged.txt"]);
    // 未暂存：改 1 行（two → TWO）+ 加 1 行
    repo.write("tracked.txt", "one\nTWO\nthree\nfour\n");
    // 未跟踪：2 行（末尾没换行也算一行）
    repo.write("untracked.txt", "x\ny");
    // 二进制：NUL 字节
    std::fs::write(repo.dir.join("bin.dat"), [0u8, 1, 2, 3]).unwrap();

    let report = super::numstat::stats(&repo.path()).unwrap();

    let staged = report
        .staged
        .iter()
        .find(|s| s.path == "staged.txt")
        .expect("已暂存的改动要在 staged 里");
    assert_eq!((staged.added, staged.deleted), (Some(1), Some(0)));
    assert!(
        !report.staged.iter().any(|s| s.path == "tracked.txt"),
        "未暂存的改动不能混进 staged"
    );

    let tracked = report
        .worktree
        .iter()
        .find(|s| s.path == "tracked.txt")
        .expect("未暂存的改动要在 worktree 里");
    assert_eq!((tracked.added, tracked.deleted), (Some(2), Some(1)));

    let untracked = report
        .worktree
        .iter()
        .find(|s| s.path == "untracked.txt")
        .expect("未跟踪文件也要有行数（它不在 diff 里，得自己数）");
    assert_eq!((untracked.added, untracked.deleted), (Some(2), Some(0)));

    let binary = report
        .worktree
        .iter()
        .find(|s| s.path == "bin.dat")
        .expect("二进制文件也要在列表里");
    assert_eq!((binary.added, binary.deleted), (None, None));

    // rename：`-z` 下是「三列 + 旧路径 + 新路径」，解析错了只会在改过名的文件上静默出错
    repo.git(&["mv", "staged.txt", "renamed.txt"]);
    let report = super::numstat::stats(&repo.path()).unwrap();
    let renamed = report
        .staged
        .iter()
        .find(|s| s.path == "renamed.txt")
        .expect("改名后的新路径要在 staged 里");
    assert_eq!(renamed.orig_path.as_deref(), Some("staged.txt"));
    assert!(
        !report.staged.iter().any(|s| s.path == "staged.txt"),
        "旧路径不能单独成一条（否则界面会多出一个『凭空删除』的文件）"
    );
}

// ==================== 三、贮藏（stash） ====================

/// `stash list --format` 的 NUL 布局：上一条的换行会粘在下一条 oid 前，消息里可以有空格
#[test]
fn parse_stash_entries_pins_nul_layout() {
    let raw = concat!(
        "1111111111111111111111111111111111111111\0stash@{0}\0On main: 第一行 第二行\0",
        "2026-10-18T09:11:30+08:00\0\n",
        "2222222222222222222222222222222222222222\0stash@{1}\0WIP on main: abc1234 初始提交\0",
        "2026-10-18T09:11:29+08:00\0\n",
    );
    let list = super::stash::parse_entries(raw);
    assert_eq!(list.len(), 2);
    assert_eq!(list[0].oid, "1111111111111111111111111111111111111111");
    assert_eq!(list[0].selector, "stash@{0}");
    assert_eq!(list[0].message, "On main: 第一行 第二行");
    assert_eq!(list[0].time, "2026-10-18T09:11:30+08:00");
    assert_eq!(list[1].oid, "2222222222222222222222222222222222222222");
    assert_eq!(list[1].message, "WIP on main: abc1234 初始提交");
}

/// 空输出（`refs/stash` 不存在）= 空列表，不是错误
#[test]
fn parse_stash_entries_accepts_empty_output() {
    assert!(super::stash::parse_entries("").is_empty());
    assert!(super::stash::parse_entries("\n\n").is_empty());
}

/// 贮藏 → 应用（保留条目）→ 删除 → 恢复（`stash store` 放回栈顶）
#[test]
fn stash_push_apply_drop_restore_roundtrip() {
    let Some(repo) = TempRepo::new() else { return };
    repo.write("a.txt", "one\n");
    repo.git(&["add", "-A"]);
    repo.git(&["commit", "-q", "-m", "init"]);
    let gate = WriteGate::new(true);

    repo.write("a.txt", "one\ntwo\n");
    let pushed = super::stash::push(&repo.path(), &gate, Some("第一条 贮藏"), false, false, &[])
        .expect("push 应成功");
    assert_eq!(pushed.stashes.len(), 1);
    assert!(pushed.stashes[0].message.contains("第一条 贮藏"));
    assert!(
        pushed.snapshot.entries.is_empty(),
        "贮藏后工作区应当干净"
    );
    let oid = pushed.stashes[0].oid.clone();
    assert_eq!(oid.len(), 40, "oid 应是完整的 40 位");

    let applied = super::stash::apply(&repo.path(), &gate, &oid, false, false)
        .expect("apply 应成功");
    assert_eq!(applied.snapshot.entries.len(), 1, "应用后改动应回到工作区");
    assert_eq!(applied.stashes.len(), 1, "apply 不删除条目");

    let dropped = super::stash::drop(&repo.path(), &gate, &oid).expect("drop 应成功");
    assert_eq!(dropped.oid, oid);
    assert!(dropped.stashes.is_empty());

    let restored = super::stash::restore(&repo.path(), &gate, &oid, &dropped.message)
        .expect("restore 应成功");
    assert_eq!(restored.len(), 1);
    assert_eq!(restored[0].oid, oid, "stash store 恢复的应是同一条提交");
}

/// 未跟踪文件默认不进贮藏；只有未跟踪时给可读原因；勾 `-u` 后能应用回来
#[test]
fn stash_untracked_needs_explicit_flag() {
    let Some(repo) = TempRepo::new() else { return };
    repo.write("tracked.txt", "one\n");
    repo.git(&["add", "-A"]);
    repo.git(&["commit", "-q", "-m", "init"]);
    let gate = WriteGate::new(true);

    repo.write("u.txt", "u\n");
    let denied = super::stash::push(&repo.path(), &gate, None, false, false, &[]);
    assert!(
        denied.is_err(),
        "只有未跟踪文件且没勾「包含未跟踪」时必须拒绝（不能装作成功）"
    );

    let pushed = super::stash::push(&repo.path(), &gate, None, true, false, &[])
        .expect("带 -u 应成功");
    assert_eq!(pushed.stashes.len(), 1);
    assert!(
        pushed.snapshot.entries.is_empty(),
        "-u 要把未跟踪文件也收走"
    );

    let applied = super::stash::apply(
        &repo.path(),
        &gate,
        &pushed.stashes[0].oid,
        false,
        true,
    )
    .expect("pop 应成功");
    assert!(
        applied
            .snapshot
            .entries
            .iter()
            .any(|entry| entry.path == "u.txt" && entry.kind == EntryKind::Untracked),
        "应用后未跟踪文件要回到工作区"
    );
    assert!(applied.stashes.is_empty(), "pop 成功后条目应删除");
}

/// 只贮藏选中的文件：其余改动留在工作区（pathspec）；应用回来后两边都在
#[test]
fn stash_push_restricts_to_selected_paths() {
    let Some(repo) = TempRepo::new() else { return };
    repo.write("a.txt", "one\n");
    repo.write("b.txt", "one\n");
    repo.git(&["add", "-A"]);
    repo.git(&["commit", "-q", "-m", "init"]);
    let gate = WriteGate::new(true);

    repo.write("a.txt", "one\ntwo\n");
    repo.write("b.txt", "one\ntwo\n");
    let pushed = super::stash::push(
        &repo.path(),
        &gate,
        None,
        false,
        false,
        &["a.txt".to_string()],
    )
    .expect("按路径贮藏应成功");
    assert_eq!(pushed.stashes.len(), 1);
    let left: Vec<&str> = pushed
        .snapshot
        .entries
        .iter()
        .map(|entry| entry.path.as_str())
        .collect();
    assert_eq!(left, vec!["b.txt"], "没选中的改动必须留在工作区: {:?}", left);

    let applied = super::stash::apply(&repo.path(), &gate, &pushed.stashes[0].oid, false, true)
        .expect("pop 应成功");
    let mut back: Vec<&str> = applied
        .snapshot
        .entries
        .iter()
        .map(|entry| entry.path.as_str())
        .collect();
    back.sort();
    assert_eq!(back, vec!["a.txt", "b.txt"], "两个文件的改动都要在");
}

/// 越界路径直接拒绝：`..` / 绝对路径 / 盘符不许进 pathspec
#[test]
fn stash_rejects_out_of_root_paths() {
    let Some(repo) = TempRepo::new() else { return };
    repo.write("a.txt", "one\n");
    repo.git(&["add", "-A"]);
    repo.git(&["commit", "-q", "-m", "init"]);
    repo.write("a.txt", "one\ntwo\n");

    for bad in ["../outside.txt", "/etc/passwd", "C:/Windows/win.ini"] {
        let err = super::stash::push(
            &repo.path(),
            &WriteGate::new(true),
            None,
            false,
            false,
            &[bad.to_string()],
        )
        .expect_err("越界路径必须拒绝");
        assert!(
            err.message.contains("仓库相对路径") || err.message.contains(".."),
            "{} 的错误要说清原因: {}",
            bad,
            err.message
        );
    }
}

// ==================== 三·五、合并（merge） ====================

/// 快进合并 → 再合一次就是「已是最新」；`--no-ff` 则强制生成合并提交
#[test]
fn merge_fast_forward_then_up_to_date_then_no_ff() {
    let Some(repo) = TempRepo::new() else { return };
    repo.write("a.txt", "one\n");
    repo.git(&["add", "-A"]);
    repo.git(&["commit", "-q", "-m", "init"]);
    // 默认分支名按 git 版本 / 全局配置会变（master / main）—— 统一成 main，不依赖开发机配置
    repo.git(&["branch", "-M", "main"]);
    repo.git(&["checkout", "-q", "-b", "feat"]);
    repo.write("b.txt", "feat\n");
    repo.git(&["add", "-A"]);
    repo.git(&["commit", "-q", "-m", "feat: b"]);
    repo.git(&["checkout", "-q", "main"]);
    let gate = WriteGate::new(true);

    let ff = super::merge::merge(&repo.path(), &gate, "feat", false).expect("快进应成功");
    assert!(ff.fast_forward, "线性历史应当快进：{}", ff.output);
    assert!(!ff.up_to_date);
    assert!(
        ff.snapshot.entries.is_empty(),
        "合并后工作区应当是干净的"
    );

    let again = super::merge::merge(&repo.path(), &gate, "feat", false).expect("重复合并不报错");
    assert!(again.up_to_date, "已合过的分支再合就是 Already up to date");
    assert!(!again.fast_forward);

    // `--no-ff`：即使能快进也生成一个合并提交（HEAD 与 被合并提交 不同）
    repo.git(&["checkout", "-q", "feat"]);
    repo.write("c.txt", "feat2\n");
    repo.git(&["add", "-A"]);
    repo.git(&["commit", "-q", "-m", "feat: c"]);
    repo.git(&["checkout", "-q", "main"]);
    let merged = super::merge::merge(&repo.path(), &gate, "feat", true).expect("--no-ff 应成功");
    assert!(!merged.fast_forward, "--no-ff 不应快进：{}", merged.output);
    assert_eq!(
        repo.git(&["rev-list", "--count", "HEAD"]).trim(),
        "4",
        "init / feat:b / feat:c / 合并提交 = 4 条（--no-ff 必须多出一条）"
    );
}

/// 冲突：退出码 1 但**冲突清单在 stdout** —— 必须带回；且能用 `--abort` 回到合并前
#[test]
fn merge_conflict_reports_stdout_and_aborts() {
    let Some(repo) = TempRepo::new() else { return };
    repo.write("a.txt", "base\n");
    repo.git(&["add", "-A"]);
    repo.git(&["commit", "-q", "-m", "init"]);
    repo.git(&["branch", "-M", "main"]);
    let gate = WriteGate::new(true);

    repo.git(&["checkout", "-q", "-b", "feat"]);
    repo.write("a.txt", "feat-side\n");
    repo.git(&["commit", "-q", "-am", "feat: 改 a"]);
    repo.git(&["checkout", "-q", "main"]);
    repo.write("a.txt", "main-side\n");
    repo.git(&["commit", "-q", "-am", "main: 改 a"]);

    let err = super::merge::merge(&repo.path(), &gate, "feat", false)
        .expect_err("两边改同一文件必须冲突");
    assert!(err.code != 0);
    assert!(
        err.message.contains("冲突"),
        "错误要说清是冲突: {}",
        err.message
    );
    assert!(
        err.stderr.contains("CONFLICT"),
        "冲突清单在 stdout，必须一起带回来: {}",
        err.stderr
    );

    // 合并中：再合别的分支要被拒（提示下一步），state 为真
    assert!(super::merge::state(&repo.path()).expect("state 应可读"));
    let again = super::merge::merge(&repo.path(), &gate, "feat", false)
        .expect_err("合并中不能再合");
    assert!(
        again.message.contains("还没有结束"),
        "错误要给出下一步: {}",
        again.message
    );

    let after = super::merge::abort(&repo.path(), &gate).expect("abort 应成功");
    assert!(after.entries.is_empty(), "中止后工作区应当干净");
    assert!(!super::merge::state(&repo.path()).expect("state 应可读"));
    assert!(
        std::fs::read_to_string(std::path::Path::new(&repo.path()).join("a.txt"))
            .unwrap()
            .contains("main-side"),
        "中止后应回到 main 侧的内容"
    );
    // 没有合并中时再 abort：说清事实，而不是让 git 报一句难懂的话
    let none = super::merge::abort(&repo.path(), &gate).expect_err("没有合并时应拒绝");
    assert!(none.message.contains("没有进行中的合并"));
}

/// 不存在的分支 / 以 `-` 开头的「引用」一律在 Rust 侧拒掉
#[test]
fn merge_rejects_bad_references() {
    let Some(repo) = TempRepo::new() else { return };
    repo.write("a.txt", "one\n");
    repo.git(&["add", "-A"]);
    repo.git(&["commit", "-q", "-m", "init"]);
    let gate = WriteGate::new(true);

    let missing = super::merge::merge(&repo.path(), &gate, "no-such-branch", false)
        .expect_err("不存在的分支必须拒");
    assert!(missing.message.contains("找不到"));

    let dashed = super::merge::merge(&repo.path(), &gate, "--abort", false)
        .expect_err("以 - 开头的引用必须拒");
    assert!(dashed.message.contains("- 开头"));

    let empty = super::merge::merge(&repo.path(), &gate, "   ", false)
        .expect_err("空引用必须拒");
    assert!(empty.message.contains("没有指定"));
}

/// 干净工作区：`stash push` 退出码是 0，这里必须靠快照拒绝
#[test]
fn stash_rejects_when_nothing_to_save() {
    let Some(repo) = TempRepo::new() else { return };
    repo.write("a.txt", "one\n");
    repo.git(&["add", "-A"]);
    repo.git(&["commit", "-q", "-m", "init"]);

    let err = super::stash::push(&repo.path(), &WriteGate::new(true), None, false, false, &[])
        .expect_err("干净工作区不能贮藏");
    assert!(err.message.contains("没有可贮藏"), "错误要说清原因: {}", err.message);
}

/// 未诞生 HEAD：git 直接失败（`You do not have the initial commit yet`）
#[test]
fn stash_rejects_before_first_commit() {
    let Some(repo) = TempRepo::new() else { return };
    repo.write("a.txt", "one\n");

    let err = super::stash::push(&repo.path(), &WriteGate::new(true), None, false, false, &[])
        .expect_err("没有提交时不能贮藏");
    assert!(err.message.contains("还没有提交"), "错误要说清原因: {}", err.message);
}

/// 冲突状态下不能贮藏；`pop` 冲突时条目保留、工作区留下冲突标记
#[test]
fn stash_pop_conflict_keeps_entry_and_blocks_push() {
    let Some(repo) = TempRepo::new() else { return };
    repo.write("a.txt", "base\n");
    repo.git(&["add", "-A"]);
    repo.git(&["commit", "-q", "-m", "init"]);
    let gate = WriteGate::new(true);

    // 造冲突：先贮藏「stash 侧」，再把同一文件提交成另一个版本，最后 pop 回来
    repo.write("a.txt", "stash-side\n");
    let pushed = super::stash::push(&repo.path(), &gate, None, false, false, &[]).unwrap();
    let oid = pushed.stashes[0].oid.clone();
    repo.write("a.txt", "commit-side\n");
    repo.git(&["commit", "-q", "-a", "-m", "B"]);

    let err = super::stash::apply(&repo.path(), &gate, &oid, false, true)
        .expect_err("内容冲突时 pop 必须失败");
    assert!(err.code != 0);

    let after = super::stash::list(&repo.path()).unwrap();
    assert_eq!(after.len(), 1, "pop 冲突时条目必须保留（git 语义）");
    assert_eq!(after[0].oid, oid);

    let snap = super::status::status(&repo.path()).unwrap();
    assert!(
        snap.entries.iter().any(|entry| entry.kind == EntryKind::Unmerged),
        "冲突时工作区会留下 UU 标记（前端要提示用户）"
    );

    let denied = super::stash::push(&repo.path(), &gate, None, false, false, &[]);
    assert!(denied.is_err(), "有未解决冲突时 push 必须被拒");
}

/// 身份：三条里删中间那条，剩下的在新编号下仍能按 oid 精确定位
#[test]
fn stash_identity_survives_selector_renumbering() {
    let Some(repo) = TempRepo::new() else { return };
    repo.write("a.txt", "0\n");
    repo.git(&["add", "-A"]);
    repo.git(&["commit", "-q", "-m", "init"]);
    let gate = WriteGate::new(true);

    for i in 1..=3 {
        repo.write("a.txt", &format!("{}\n", i));
        super::stash::push(&repo.path(), &gate, Some(&format!("第 {} 条", i)), false, false, &[])
            .unwrap();
    }
    let list = super::stash::list(&repo.path()).unwrap();
    assert_eq!(list.len(), 3);
    // 列表是新 → 旧：第 3 条在 stash@{0}
    let middle = list[1].oid.clone();
    assert!(list[1].message.contains("第 2 条"));

    let dropped = super::stash::drop(&repo.path(), &gate, &middle).unwrap();
    assert!(dropped.message.contains("第 2 条"), "返回的消息要能用于撤销");

    let after = super::stash::list(&repo.path()).unwrap();
    assert_eq!(after.len(), 2);
    assert!(
        !after.iter().any(|entry| entry.oid == middle),
        "删的必须是指定 oid 那一条（不能只看 stash@n）"
    );
    assert_eq!(after[0].selector, "stash@{0}");
    assert_eq!(after[1].selector, "stash@{1}");

    // 新编号下仍能按 oid 解析出正确的 selector
    let applied = super::stash::apply(&repo.path(), &gate, &after[1].oid, false, false)
        .expect("剩余条目应能应用");
    assert!(!applied.snapshot.entries.is_empty());

    // 不存在的 oid：给可读错误，而不是删错东西
    let missing = super::stash::drop(&repo.path(), &gate, "deadbeefdeadbeef");
    assert!(missing.is_err());
}

/// `--keep-index`：已暂存的内容**既进贮藏、又留在索引 / 工作区**
#[test]
fn stash_keep_index_keeps_staged_work() {
    let Some(repo) = TempRepo::new() else { return };
    repo.write("a.txt", "one\n");
    repo.git(&["add", "-A"]);
    repo.git(&["commit", "-q", "-m", "init"]);
    let gate = WriteGate::new(true);

    repo.write("a.txt", "one\nstaged\n");
    repo.git(&["add", "a.txt"]);
    repo.write("a.txt", "one\nstaged\nunstaged\n");

    let pushed = super::stash::push(&repo.path(), &gate, None, false, true, &[])
        .expect("keep-index 应成功");
    assert_eq!(pushed.stashes.len(), 1);
    let entry = pushed
        .snapshot
        .entries
        .iter()
        .find(|entry| entry.path == "a.txt")
        .expect("已暂存内容应留在索引里");
    assert_eq!(entry.x, 'M', "--keep-index 必须把已暂存内容留在索引里");
    assert_eq!(entry.y, '.', "未暂存的那一层已被收进贮藏");
}

/// 消息含中文与换行（git 把换行折成空格）、路径含中文与空格
#[test]
fn stash_message_and_cjk_path_roundtrip() {
    let Some(repo) = TempRepo::new() else { return };
    repo.write("中文 文件.txt", "base\n");
    repo.git(&["add", "-A"]);
    repo.git(&["commit", "-q", "-m", "init"]);
    let gate = WriteGate::new(true);

    repo.write("中文 文件.txt", "base\n改过了\n");
    let pushed = super::stash::push(&repo.path(), &gate, Some("第一行\n第二行"), false, false, &[])
        .expect("push 应成功");
    assert!(
        pushed.stashes[0].message.contains("第一行 第二行"),
        "git 把消息里的换行折成空格（实测）: {}",
        pushed.stashes[0].message
    );

    let applied = super::stash::apply(
        &repo.path(),
        &gate,
        &pushed.stashes[0].oid,
        false,
        true,
    )
    .expect("pop 应成功");
    assert!(
        applied
            .snapshot
            .entries
            .iter()
            .any(|entry| entry.path == "中文 文件.txt"),
        "改动要落回原来的中文路径"
    );
}

/// 只读沙盒：贮藏的写操作全部拒绝，读不受影响
#[test]
fn stash_write_gate_rejects_when_readonly() {
    let Some(repo) = TempRepo::new() else { return };
    repo.write("a.txt", "one\n");
    repo.git(&["add", "-A"]);
    repo.git(&["commit", "-q", "-m", "init"]);

    // 先用真 gate 造一条，供 apply / drop / restore 验证
    repo.write("a.txt", "one\ntwo\n");
    let pushed = super::stash::push(&repo.path(), &WriteGate::new(true), None, false, false, &[])
        .unwrap();
    let oid = pushed.stashes[0].oid.clone();

    let gate = WriteGate::new(false);
    assert!(
        super::stash::push(&repo.path(), &gate, None, false, false, &[]).is_err(),
        "只读模式下贮藏必须失败"
    );
    assert!(super::stash::apply(&repo.path(), &gate, &oid, false, true).is_err());
    assert!(super::stash::drop(&repo.path(), &gate, &oid).is_err());
    assert!(super::stash::restore(&repo.path(), &gate, &oid, "x").is_err());
    // 读不受影响
    assert!(super::stash::list(&repo.path()).is_ok());
}

