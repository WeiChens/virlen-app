//! `wizard` 的单测 —— 全部喂脚本，不碰真终端
//!
//! 约定：`Script::prompt()` 造出的 `Prompter` 借走 `input` / `out` 两个字段，
//! 因此断言输出要**先 drop 掉它**（用块作用域），否则借用还没结束。

use super::*;
use std::io::Cursor;

/// 一段「用户输入脚本」+ 捕获的输出
struct Script {
    input: Cursor<Vec<u8>>,
    out: Vec<u8>,
}

impl Script {
    /// 每行一条输入；自动补行尾换行（真实终端里每行都以 Enter 结束）
    fn new(lines: &[&str]) -> Self {
        let mut text = lines.join("\n");
        if !lines.is_empty() {
            text.push('\n');
        }
        Self {
            input: Cursor::new(text.into_bytes()),
            out: Vec::new(),
        }
    }

    fn prompt(&mut self) -> Prompter<'_> {
        // ⚠️ `tty = false`：绝不能去读真实控制台（见 wizard.rs 文件头约束 3）
        Prompter::new(&mut self.input, &mut self.out, false)
    }

    fn output(&self) -> String {
        String::from_utf8_lossy(&self.out).to_string()
    }
}

fn opts() -> Vec<String> {
    vec!["openai".into(), "anthropic".into(), "gemini".into()]
}

// ==================== text ====================

#[test]
fn text_uses_default_on_empty_input() {
    let mut s = Script::new(&[""]);
    let v = {
        let mut p = s.prompt();
        p.text("名称", Some("默认名")).unwrap()
    };
    assert_eq!(v, "默认名");
    assert!(s.output().contains("名称 [默认名]: "));
}

#[test]
fn text_trims_input() {
    let mut s = Script::new(&["  值  "]);
    let v = {
        let mut p = s.prompt();
        p.text("名称", None).unwrap()
    };
    assert_eq!(v, "值");
}

#[test]
fn text_reprompts_when_required_is_empty() {
    // 第一行空、第二行给值：必须重问，而不是把空串当答案返回
    let mut s = Script::new(&["   ", "真值"]);
    let v = {
        let mut p = s.prompt();
        p.text("名称", None).unwrap()
    };
    assert_eq!(v, "真值");
    assert!(s.output().contains("✗ 不能为空"));
}

#[test]
fn text_opt_accepts_empty() {
    let mut s = Script::new(&[""]);
    let v = {
        let mut p = s.prompt();
        p.text_opt("性格", None).unwrap()
    };
    assert_eq!(v, "");
}

#[test]
fn text_with_reprompts_until_valid() {
    let mut s = Script::new(&["bad", "good"]);
    let v = {
        let mut p = s.prompt();
        p.text_with("x", None, |v| {
            if v == "good" {
                Ok(())
            } else {
                Err("要是 good".to_string())
            }
        })
        .unwrap()
    };
    assert_eq!(v, "good");
    assert!(s.output().contains("✗ 要是 good"));
}

/// EOF 必须**直接报错**：否则管道里跑向导会卡在「空输入 → 重问」的死循环
#[test]
fn eof_is_an_error_not_an_endless_reprompt() {
    let mut s = Script::new(&[]);
    let err = {
        let mut p = s.prompt();
        p.text("名称", None).unwrap_err()
    };
    assert!(err.contains("输入结束"), "{}", err);
}

// ==================== choose ====================

#[test]
fn choose_by_number() {
    let mut s = Script::new(&["2"]);
    let i = {
        let mut p = s.prompt();
        p.choose("协议", &opts(), 0).unwrap()
    };
    assert_eq!(i, 1);
    assert!(s.output().contains("1) openai（默认）"));
}

#[test]
fn choose_default_on_empty() {
    let mut s = Script::new(&[""]);
    let i = {
        let mut p = s.prompt();
        p.choose("协议", &opts(), 2).unwrap()
    };
    assert_eq!(i, 2);
}

#[test]
fn choose_accepts_option_text() {
    let mut s = Script::new(&["anthropic"]);
    let i = {
        let mut p = s.prompt();
        p.choose("协议", &opts(), 0).unwrap()
    };
    assert_eq!(i, 1, "也能直接用选项原文作答");
}

#[test]
fn choose_reprompts_on_garbage() {
    // "nope"（既不是编号也不是选项原文）→ 驳回；"9"（越界）→ 再驳；"2" → 命中
    let mut s = Script::new(&["nope", "9", "2"]);
    let i = {
        let mut p = s.prompt();
        p.choose("协议", &opts(), 0).unwrap()
    };
    assert_eq!(i, 1);
    assert!(s.output().contains("请输入 1..=3"));
}

// ==================== multi ====================

#[test]
fn multi_by_numbers_is_sorted_and_deduped() {
    let mut s = Script::new(&["3,1,1"]);
    let v = {
        let mut p = s.prompt();
        p.multi("档位", &opts(), &[]).unwrap()
    };
    assert_eq!(v, vec![0, 2]);
}

#[test]
fn multi_all_and_none_and_default() {
    let mut s = Script::new(&["all"]);
    let all = {
        let mut p = s.prompt();
        p.multi("档位", &opts(), &[]).unwrap()
    };
    assert_eq!(all, vec![0, 1, 2]);

    let mut s = Script::new(&["none"]);
    let none = {
        let mut p = s.prompt();
        p.multi("档位", &opts(), &[0, 1]).unwrap()
    };
    assert!(none.is_empty());

    // 空输入 = 取默认（默认是「全不选」时也要能区分出「没选」）
    let mut s = Script::new(&[""]);
    let dft = {
        let mut p = s.prompt();
        p.multi("档位", &opts(), &[1]).unwrap()
    };
    assert_eq!(dft, vec![1]);
    assert!(s.output().contains("[2]"));
}

#[test]
fn multi_reprompts_on_invalid_token() {
    let mut s = Script::new(&["1,x", "2"]);
    let v = {
        let mut p = s.prompt();
        p.multi("档位", &opts(), &[]).unwrap()
    };
    assert_eq!(v, vec![1]);
    assert!(s.output().contains("无效选项: x"));
}

// ==================== confirm ====================

#[test]
fn confirm_variants() {
    let mut s = Script::new(&["y"]);
    assert!({
        let mut p = s.prompt();
        p.confirm("确定", false).unwrap()
    });

    let mut s = Script::new(&[""]);
    assert!({
        let mut p = s.prompt();
        p.confirm("确定", true).unwrap()
    });
    assert!(s.output().contains("[Y/n]"));

    let mut s = Script::new(&["maybe", "n"]);
    assert!(!{
        let mut p = s.prompt();
        p.confirm("确定", true).unwrap()
    });
    assert!(s.output().contains("✗ 请输入 y 或 n"));
}

// ==================== secret（非终端分支） ====================

#[test]
fn secret_reads_line_when_not_a_tty() {
    let mut s = Script::new(&["sk-abc"]);
    let v = {
        let mut p = s.prompt();
        p.secret("API Key").unwrap()
    };
    assert_eq!(v, "sk-abc");
    assert!(s.output().contains("API Key: "));
}

#[test]
fn secret_reprompts_when_empty() {
    let mut s = Script::new(&["", "sk-1"]);
    let v = {
        let mut p = s.prompt();
        p.secret("API Key").unwrap()
    };
    assert_eq!(v, "sk-1");
    assert!(s.output().contains("✗ 不能为空"));
}

/// 编辑场景：回车 = 保留旧值（`None`），而不是「空 key」
#[test]
fn secret_opt_returns_none_on_empty() {
    let mut s = Script::new(&["", "sk-new"]);
    let (kept, typed) = {
        let mut p = s.prompt();
        let a = p.secret_opt("API Key").unwrap();
        let b = p.secret_opt("API Key").unwrap();
        (a, b)
    };
    assert_eq!(kept, None);
    assert_eq!(typed.as_deref(), Some("sk-new"));
}

// ==================== 纯解析 ====================

#[test]
fn parse_multi_edge_cases() {
    assert_eq!(parse_multi("", 3, &[2]).unwrap(), vec![2]);
    assert_eq!(parse_multi("  1 ; 2 ", 3, &[]).unwrap(), vec![0, 1]);
    assert_eq!(parse_multi("0", 3, &[]).unwrap_err(), "无效选项: 0（请输入 1..=3）");
    assert!(parse_multi("4", 3, &[]).is_err());
}
