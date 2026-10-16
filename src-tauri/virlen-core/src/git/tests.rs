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
use super::{ChangeEntry, DiffScope, EntryKind, HeadInfo, StatusSnapshot, WriteGate};
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
        if !git_available() {
            eprintln!("[git tests] 未检测到 git，跳过真仓库用例");
            return None;
        }
        let dir = std::env::temp_dir().join(format!("virlen_git_test_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).ok()?;
        let repo = Self { dir };
        repo.git(&["init", "-q"]);
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
    let switched = branch::switch(&repo.path(), &gate, "feature", true, None);
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

    let after = branch::switch(&repo.path(), &gate, "feature/x", true, None).unwrap();
    assert_eq!(after.head.branch.as_deref(), Some("feature/x"));

    let list = branch::list(&repo.path()).unwrap();
    let names: Vec<&str> = list.iter().map(|b| b.name.as_str()).collect();
    assert!(names.contains(&"feature/x"));
    assert!(names.contains(&first.as_str()));
    assert!(list[0].is_head, "当前分支必须排在最前");
    assert_eq!(list[0].name, "feature/x");

    let back = branch::switch(&repo.path(), &gate, &first, false, None).unwrap();
    assert_eq!(back.head.branch.as_deref(), Some(first.as_str()));
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
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\u{1f}aaaaaaa\u{1f}张三\u{1f}z@example.com\u{1f}2026-10-16T10:29:46+08:00\u{1f}fix: 优化 diff\0",
        "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\u{1f}bbbbbbb\u{1f}virlen test\u{1f}t@example.com\u{1f}2026-10-15T18:05:15+08:00\u{1f}feat: 标题里带 \u{1f} 的情况\0",
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
    // subject 是唯一的自由文本：里面含 US 也只会留在最后一段（不许把字段数切乱）
    assert_eq!(list[1].subject, "feat: 标题里带 \u{1f} 的情况");
    assert_eq!(list[1].author_name, "virlen test");

    // 字段不够的残缺记录直接丢掉（不编造半条记录）
    assert!(parse_log(b"only-one-field\0").is_empty());
    assert!(parse_log(b"").is_empty());
    // 记录首尾的换行要削掉（某些形态下 NUL 后会跟着一个换行），但**空格不许削**
    // ⚠️ 字节串里只能用 `\x1f`（`\u{…}` 不能出现在字节串里）
    let padded = b"\ncccccccccccccccccccccccccccccccccccccccc\x1fccccccc\x1fA\x1fa@b.c\x1f2026-01-01T00:00:00+08:00\x1f leading and trailing \r\n";
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
        super::log::log(&repo.path(), 0, 50, None)
            .unwrap()
            .is_empty(),
        "还没有任何提交时应当是空列表（unborn HEAD 不是错误）"
    );

    for i in 1..=3 {
        repo.write("a.txt", &format!("line {}\n", i));
        super::stage::stage(&repo.path(), &gate, &["a.txt".to_string()]).unwrap();
        super::commit::commit(&repo.path(), &gate, &format!("feat: 第 {} 次提交\n", i)).unwrap();
    }

    let all = super::log::log(&repo.path(), 0, 50, None).unwrap();
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
    let page = super::log::log(&repo.path(), 1, 1, None).unwrap();
    assert_eq!(page.len(), 1);
    assert_eq!(page[0].subject, "feat: 第 2 次提交");

    // 越界的一页 = 空列表（界面据此收掉「加载更多」），不是错误
    assert!(super::log::log(&repo.path(), 10, 50, None).unwrap().is_empty());
    // limit 传 0 也不许把 `--max-count` 变成 0（夹到 1）
    assert_eq!(super::log::log(&repo.path(), 0, 0, None).unwrap().len(), 1);
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
    let list = super::log::log(&sub, 0, 50, None).unwrap();
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].subject, "init");
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
