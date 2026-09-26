//! **交互向导原语** —— 让 `provider` / `agent` 这类「多步录入」命令有一份可测的问答设施
//!
//! 为什么不复用 `run/ask.rs`：那里的 `ask_user` 是**引擎事件**的应答器（一问一答、fail-closed、
//! 给桥协议载荷），而配置向导需要的是别的东西 —— **带默认值、可重问、可多选、密文输入、
//! 步步回显**。两者的「一问一答」形状相近，但约束完全不同（前者宁可拒绝也不能猜，后者必须
//! 让用户输对了才放行）。混在一起会让两边都变难懂。
//!
//! ## 三条硬约束
//!
//! 1. **输入全从注入的 `BufRead` 走**，输出全从注入的 `Write` 走 —— 单测直接喂脚本
//!    （`Vec<&str>`）就能把整条流程跑一遍，不需要真终端（与 crate 既有约定一致）。
//! 2. **EOF 不是空值**：`read_line` 读到 0 字节返回 `None` → 立刻以可读错误结束，
//!    绝不进入「空输入 → 重问」的无限循环（管道里跑交互命令的典型死法）。
//! 3. **密文输入只在真终端上关回显**（`tty` 由调用方传入）：测试里必须是 `false`，
//!    否则用例会去读**真实控制台**，把 `cargo test` 挂住。

use std::io::{BufRead, Write};

/// 读到 EOF（stdin 被关闭 / 管道结束）时的统一文案
const EOF_MSG: &str = "输入结束（stdin 已关闭）";

/// 交互问答器
pub(crate) struct Prompter<'a> {
    input: &'a mut dyn BufRead,
    out: &'a mut dyn Write,
    /// stdin 是不是真终端 —— 只影响「密文输入」能否走 raw mode。
    /// 测试恒传 `false`（见文件头约束 3）。
    tty: bool,
}

impl<'a> Prompter<'a> {
    pub(crate) fn new(input: &'a mut dyn BufRead, out: &'a mut dyn Write, tty: bool) -> Self {
        Self { input, out, tty }
    }

    // ==================== 输出 ====================

    /// 打印一行说明 / 进度（向导的「人话」通道）
    pub(crate) fn say(&mut self, msg: &str) {
        let _ = writeln!(self.out, "{}", msg);
    }

    /// 打印一步的分隔标题（`第 3 步：API 地址`）
    ///
    /// 只有序号、没有「共 N 步」：有的步会被跳过（模板不支持切协议、没勾任何推理档位），写死的总数后面
    /// 会与序号对不上，反而像 bug。
    pub(crate) fn step(&mut self, idx: usize, title: &str) {
        let _ = writeln!(self.out, "\n── 第 {} 步：{} ──", idx, title);
    }

    // ==================== 输入 ====================

    /// 读一行（去掉行尾换行）；EOF / 出错 → `None`
    fn read_line(&mut self) -> Option<String> {
        let mut line = String::new();
        match self.input.read_line(&mut line) {
            Ok(0) => None,
            Ok(_) => Some(line.trim_end_matches(['\r', '\n']).to_string()),
            Err(_) => None,
        }
    }

    /// 必填单行：空输入取默认值；没有默认值则重问
    pub(crate) fn text(&mut self, label: &str, default: Option<&str>) -> Result<String, String> {
        self.text_with(label, default, |v| {
            if v.trim().is_empty() {
                Err("不能为空".to_string())
            } else {
                Ok(())
            }
        })
    }

    /// 可空单行（如 Agent 的「身份 / 性格」）
    pub(crate) fn text_opt(&mut self, label: &str, default: Option<&str>) -> Result<String, String> {
        self.text_with(label, default, |_| Ok(()))
    }

    /// 单行 + 自定义校验：**校验不过就重问**，并把原因打在上一行下面
    pub(crate) fn text_with(
        &mut self,
        label: &str,
        default: Option<&str>,
        validate: impl Fn(&str) -> Result<(), String>,
    ) -> Result<String, String> {
        loop {
            self.prompt_line(label, default);
            let raw = self.read_line().ok_or_else(|| EOF_MSG.to_string())?;
            let value = if raw.trim().is_empty() {
                default.unwrap_or("").trim().to_string()
            } else {
                raw.trim().to_string()
            };
            match validate(&value) {
                Ok(()) => return Ok(value),
                Err(e) => {
                    let _ = writeln!(self.out, "  ✗ {}", e);
                }
            }
        }
    }

    /// 密文单行（必填）：真终端上关回显，每敲一个字符回显 `*`
    pub(crate) fn secret(&mut self, label: &str) -> Result<String, String> {
        loop {
            if let Some(v) = self.secret_opt(label)? {
                return Ok(v);
            }
            let _ = writeln!(self.out, "  ✗ 不能为空");
        }
    }

    /// 密文单行，**允许留空**：返回 `None` = 用户直接回车。
    ///
    /// 编辑场景靠它区分「保留旧值」（回车）与「改成一个新值」（输入）—— 而不能把旧值当
    /// 默认值回显（那等于把 apiKey 抄到屏幕上，正是关回显要防的事）。
    pub(crate) fn secret_opt(&mut self, label: &str) -> Result<Option<String>, String> {
        self.prompt_line(label, None);
        let raw = if self.tty {
            let _ = self.out.flush();
            hidden::read_line(self.out)?
        } else {
            self.read_line().ok_or_else(|| EOF_MSG.to_string())?
        };
        let value = raw.trim();
        if value.is_empty() {
            Ok(None)
        } else {
            Ok(Some(value.to_string()))
        }
    }

    /// 单选：输编号（或选项原文）；空输入取默认项
    pub(crate) fn choose(
        &mut self,
        label: &str,
        options: &[String],
        default: usize,
    ) -> Result<usize, String> {
        loop {
            let _ = writeln!(self.out, "{}", label);
            for (i, o) in options.iter().enumerate() {
                let mark = if i == default { "（默认）" } else { "" };
                let _ = writeln!(self.out, "  {}) {}{}", i + 1, o, mark);
            }
            let _ = write!(self.out, "选择 [{}]: ", default + 1);
            let raw = self.read_line().ok_or_else(|| EOF_MSG.to_string())?;
            let t = raw.trim();
            if t.is_empty() {
                return Ok(default);
            }
            match parse_index(t, options.len()) {
                Some(i) => return Ok(i),
                None => {
                    if let Some(i) = options.iter().position(|o| o.eq_ignore_ascii_case(t)) {
                        return Ok(i);
                    }
                    let _ = writeln!(self.out, "  ✗ 请输入 1..={}（或选项原文）", options.len());
                }
            }
        }
    }

    /// 多选：编号用逗号 / 空格分隔；`all` = 全选、`none` / `-` = 全不选；空输入取默认
    pub(crate) fn multi(
        &mut self,
        label: &str,
        options: &[String],
        default: &[usize],
    ) -> Result<Vec<usize>, String> {
        loop {
            let _ = writeln!(self.out, "{}", label);
            for (i, o) in options.iter().enumerate() {
                let mark = if default.contains(&i) { "(*)" } else { "( )" };
                let _ = writeln!(self.out, "  {} {}) {}", mark, i + 1, o);
            }
            let _ = write!(
                self.out,
                "选择（逗号分隔；all = 全选，none = 全不选）[{}]: ",
                join_indexes(default)
            );
            let raw = self.read_line().ok_or_else(|| EOF_MSG.to_string())?;
            match parse_multi(&raw, options.len(), default) {
                Ok(picked) => return Ok(picked),
                Err(e) => {
                    let _ = writeln!(self.out, "  ✗ {}", e);
                }
            }
        }
    }

    /// 是否继续（`y/N`）
    pub(crate) fn confirm(&mut self, label: &str, default: bool) -> Result<bool, String> {
        loop {
            let hint = if default { "Y/n" } else { "y/N" };
            let _ = write!(self.out, "{} [{}]: ", label, hint);
            let raw = self.read_line().ok_or_else(|| EOF_MSG.to_string())?;
            let t = raw.trim().to_ascii_lowercase();
            match t.as_str() {
                "" => return Ok(default),
                "y" | "yes" | "是" => return Ok(true),
                "n" | "no" | "否" => return Ok(false),
                _ => {
                    let _ = writeln!(self.out, "  ✗ 请输入 y 或 n");
                }
            }
        }
    }

    /// 打印 `标签 [默认值]: `（默认值为空时只打印 `标签: `）
    fn prompt_line(&mut self, label: &str, default: Option<&str>) {
        match default.map(str::trim).filter(|d| !d.is_empty()) {
            Some(d) => {
                let _ = write!(self.out, "{} [{}]: ", label, d);
            }
            None => {
                let _ = write!(self.out, "{}: ", label);
            }
        }
    }
}

// ==================== 纯解析（可单测） ====================

/// `"3"` → `Some(2)`；非数字 / 越界 → `None`
fn parse_index(token: &str, len: usize) -> Option<usize> {
    let n: usize = token.parse().ok()?;
    if n >= 1 && n <= len {
        Some(n - 1)
    } else {
        None
    }
}

/// 多选解析：分隔符接受中英文逗号 / 分号 / 空白
fn parse_multi(raw: &str, len: usize, default: &[usize]) -> Result<Vec<usize>, String> {
    let t = raw.trim();
    if t.is_empty() {
        return Ok(default.to_vec());
    }
    let lower = t.to_ascii_lowercase();
    if lower == "all" || t == "全部" {
        return Ok((0..len).collect());
    }
    if lower == "none" || t == "-" || t == "无" {
        return Ok(Vec::new());
    }
    let mut picked: Vec<usize> = Vec::new();
    for token in t.split([',', '，', ';', '；', ' ', '\t']) {
        let tok = token.trim();
        if tok.is_empty() {
            continue;
        }
        match parse_index(tok, len) {
            Some(i) => {
                if !picked.contains(&i) {
                    picked.push(i);
                }
            }
            None => return Err(format!("无效选项: {}（请输入 1..={}）", tok, len)),
        }
    }
    picked.sort_unstable();
    Ok(picked)
}

/// 把下标列表渲染成 `1,3,5`（用于「当前默认」提示）
fn join_indexes(idx: &[usize]) -> String {
    if idx.is_empty() {
        return "无".to_string();
    }
    idx.iter()
        .map(|i| (i + 1).to_string())
        .collect::<Vec<_>>()
        .join(",")
}

// ==================== 密文输入（只在真终端上启用） ====================

/// raw-mode 下逐字符读取（关回显）
///
/// 与 `tui/input.rs` 同一套机制，两条既有经验照搬：
/// - `KeyEventKind::Release` 在 Windows 上会跟着 `Press` 一起来 → 不滤会变成「按一次出两个字符」；
/// - raw mode 必须**无条件**恢复 → 用 Drop 守卫（`term.rs` 的 panic 钩子同理）。
mod hidden {
    use ratatui::crossterm::event::{read, Event, KeyCode, KeyEventKind, KeyModifiers};
    use ratatui::crossterm::terminal::{disable_raw_mode, enable_raw_mode};
    use std::io::Write;

    /// raw mode 守卫：任何路径离开（含 `?` 提前返回）都会恢复终端
    struct RawGuard;

    impl RawGuard {
        fn enter() -> io::Result<Self> {
            enable_raw_mode()?;
            Ok(Self)
        }
    }

    impl Drop for RawGuard {
        fn drop(&mut self) {
            let _ = disable_raw_mode();
        }
    }

    use std::io;

    /// 读一行密文。Esc / Ctrl+C 返回空串（上层按「没填」重问；真要中止就 Ctrl+C 两次 / 关终端）。
    pub(super) fn read_line(out: &mut dyn Write) -> Result<String, String> {
        let _guard = RawGuard::enter().map_err(|e| format!("无法切换到密文输入模式: {}", e))?;
        let mut buf = String::new();
        loop {
            let ev = read().map_err(|e| format!("读取终端事件失败: {}", e))?;
            let Event::Key(k) = ev else { continue };
            if k.kind == KeyEventKind::Release {
                continue;
            }
            match k.code {
                KeyCode::Enter => {
                    let _ = writeln!(out);
                    let _ = out.flush();
                    return Ok(buf);
                }
                KeyCode::Esc => {
                    let _ = writeln!(out);
                    return Ok(String::new());
                }
                KeyCode::Char('c') if k.modifiers.contains(KeyModifiers::CONTROL) => {
                    let _ = writeln!(out);
                    return Ok(String::new());
                }
                KeyCode::Backspace => {
                    if buf.pop().is_some() {
                        let _ = write!(out, "\u{8} \u{8}");
                        let _ = out.flush();
                    }
                }
                // Alt / Super 组合不参与（与 `tui/input.rs::map_key` 同口径）
                KeyCode::Char(c)
                    if !k.modifiers.contains(KeyModifiers::ALT)
                        && !k.modifiers.contains(KeyModifiers::SUPER)
                        && !k.modifiers.contains(KeyModifiers::CONTROL) =>
                {
                    buf.push(c);
                    let _ = write!(out, "*");
                    let _ = out.flush();
                }
                _ => {}
            }
        }
    }
}

#[cfg(test)]
mod tests;
