//! 斜杠命令 —— 只做**解析**（纯函数），执行在 `mod.rs`（那里才拿得到会话与引擎）
//!
//! 为什么把「执行」留在 `mod.rs`：`/new` 要重算工作目录与安全策略（`SessionRuntime::activate`）、
//! `/status` 要读会话运行时 —— 都需要异步与库访问。解析是纯的，因此单独放这里，单测直接断言。

use virlen_core::agent::compress::CompressMode;

/// 已识别的斜杠命令
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Slash {
    Help,
    /// 退出（与 Ctrl+C / Ctrl+D 同一条退出路径）
    Exit,
    /// 会话 / 模型 / 工作目录 / 用量 / 已知缺口
    Status,
    /// 新建一条会话（旧会话留在库里，桌面端可继续）
    New,
    /// 压缩上下文（`/compress [ai|raw]`）
    Compress(CompressArg),
    /// 未识别的命令：**不能**当普通消息发给模型（用户以为自己敲的是命令）
    Unknown(String),
}

/// `/compress` 的参数
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum CompressArg {
    /// 不带参数 → 弹选择面板（用户显式选「AI 摘要 / 正文压缩」）
    Ask,
    /// 直接指定方式
    Mode(CompressMode),
    /// 认不出的方式名
    Invalid(String),
}

/// 解析一行输入；不是斜杠命令返回 `None`（= 普通提问）
pub(crate) fn parse_slash(input: &str) -> Option<Slash> {
    let t = input.trim();
    let rest = t.strip_prefix('/')?;
    // `/ help`（斜杠后有空格）也按命令处理；空命令名按未知处理
    // `split_whitespace` 已经跳过首尾空白，不必再 `trim()`
    let mut words = rest.split_whitespace();
    let name = words.next().unwrap_or("");
    let arg = words.next().unwrap_or("");
    Some(match name.to_ascii_lowercase().as_str() {
        "help" | "h" | "?" => Slash::Help,
        "exit" | "quit" | "q" => Slash::Exit,
        "status" | "s" => Slash::Status,
        "new" => Slash::New,
        // `/compress`（弹面板）/ `/compress ai|raw`（直接指定）
        "compress" | "compact" => Slash::Compress(parse_compress_arg(arg)),
        other => Slash::Unknown(other.to_string()),
    })
}

/// 解析 `/compress` 的第二个词
///
/// ⚠️ 认不出的方式名**不能**静默退化成默认方式：压缩会改写上下文，用户以为压的是 A、
/// 实际压的是 B 是不可接受的 —— 必须回显「你的输入没被采纳」。
fn parse_compress_arg(arg: &str) -> CompressArg {
    if arg.is_empty() {
        return CompressArg::Ask;
    }
    match CompressMode::parse(arg) {
        Some(m) => CompressArg::Mode(m),
        None => CompressArg::Invalid(arg.to_string()),
    }
}

/// `/help` 的文本（也在 `chat --help` 里给出提示用）
pub(crate) fn help_text() -> String {
    "\
可用命令:
  /help            显示本帮助
  /status          显示会话 / 模型 / 工作目录 / 上下文占用 / 用量，以及与桌面端的已知能力差异
  /new             新建会话（当前会话留在库里，可在桌面端继续）
  /compress [ai|raw]  压缩上下文（不带参数则弹出模式选择面板）
  /exit            退出（同 Ctrl+C / Ctrl+D）

上下文与压缩:
  状态行里的百分比 = 当前上下文占用 / 200k（口径与桌面端 token 环一致）
  ai  = AI 摘要：一次模型调用，把历史总结成很短的一段（最省 token，但慢、要花钱）
  raw = 正文压缩：本地渲染，毫秒级零消耗；正文一字不删，只丢思考过程与超长工具输出
  占用 < 40% 时不做（与桌面端同一条闸）——上下文充裕时压缩只会白花钱

按键:
  Enter            提交输入
  Esc              取消当前回合（回合进行中）；有交互提示时 = 拒绝 / 取消
  ↑ / ↓            浏览输入历史
  Ctrl+C           回合进行中 = 取消；空闲 = 退出
  Ctrl+D           退出

压缩方式选择面板（`/compress` 弹出）:
  ↑ / ↓（或 ← / →）  在「AI 摘要」「正文压缩」之间移动
  Enter            按当前高亮项压缩
  Esc / Ctrl+C     取消（不压缩）

授权面板（命令需要授权时弹出）:
  ← / →（或 ↑ / ↓）  在「拒绝」与「允许」之间移动，**默认「拒绝」**
  Enter            确认当前选项（不移动就回车 = 拒绝）
  Esc / Ctrl+C     等同「拒绝」

  ⚠️ 面板开着时普通字符（含 y / n）一律不参与授权 ——
     避免「正在打字时误触回车 = 直接放行」这类误操作。
"
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_known_commands() {
        assert_eq!(parse_slash("/help"), Some(Slash::Help));
        assert_eq!(parse_slash("  /HELP "), Some(Slash::Help));
        assert_eq!(parse_slash("/h"), Some(Slash::Help));
        assert_eq!(parse_slash("/?"), Some(Slash::Help));
        assert_eq!(parse_slash("/exit"), Some(Slash::Exit));
        assert_eq!(parse_slash("/quit"), Some(Slash::Exit));
        assert_eq!(parse_slash("/status"), Some(Slash::Status));
        assert_eq!(parse_slash("/new"), Some(Slash::New));
        // 斜杠后有空格 / 带参数
        assert_eq!(parse_slash("/ status"), Some(Slash::Status));
        assert_eq!(parse_slash("/new 随便写点"), Some(Slash::New));
    }

    #[test]
    fn non_slash_input_is_a_prompt() {
        assert_eq!(parse_slash(""), None);
        assert_eq!(parse_slash("你好"), None);
        assert_eq!(parse_slash("帮我看看 E:/a/b 目录"), None);
    }

    #[test]
    fn parses_compress_with_and_without_mode() {
        // 不带参数 → 面板（让用户显式选）；带参数 → 直接指定
        assert_eq!(parse_slash("/compress"), Some(Slash::Compress(CompressArg::Ask)));
        assert_eq!(
            parse_slash("/compress ai"),
            Some(Slash::Compress(CompressArg::Mode(CompressMode::Ai)))
        );
        assert_eq!(
            parse_slash("/compress RAW"),
            Some(Slash::Compress(CompressArg::Mode(CompressMode::Raw)))
        );
        assert_eq!(parse_slash("/compress   raw  "),
            Some(Slash::Compress(CompressArg::Mode(CompressMode::Raw))));
        // 认不出的方式名**绝不**静默退化成默认
        assert_eq!(
            parse_slash("/compress 全文"),
            Some(Slash::Compress(CompressArg::Invalid("全文".into())))
        );
    }

    /// 用户以为自己敲的是命令 —— 必须给出可读反馈，绝不能当提问发给模型
    #[test]
    fn unknown_slash_is_reported_not_sent() {
        assert_eq!(parse_slash("/nope"), Some(Slash::Unknown("nope".into())));
        assert_eq!(parse_slash("/"), Some(Slash::Unknown(String::new())));
    }

    #[test]
    fn help_lists_every_command() {
        let h = help_text();
        for c in ["/help", "/status", "/new", "/compress", "/exit"] {
            assert!(h.contains(c), "帮助里缺少 {c}");
        }
        // 面板键位与两种模式都必须写在帮助里（用户不看源码也知道怎么用）
        for s in ["AI 摘要", "正文压缩", "Enter", "Esc"] {
            assert!(h.contains(s), "帮助里缺少 {s}");
        }
    }
}
