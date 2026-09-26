/*!
 * clipboard_files::vscode — 解析 VS Code 的 `code/file-list`
 *
 * VS Code 在资源管理器面板里「复制文件」时，会把文件列表写进一个自定义剪贴板格式
 * `code/file-list`，负载是一段 UTF-8 文本：
 *
 * ```text
 * resources.map(r => r.toString()).join('\n')
 * ```
 *
 * 即「换行分隔的 URI 列表」。出处（VS Code 源码）：
 *   src/vs/workbench/services/clipboard/electron-browser/clipboardService.ts
 *   → NativeClipboardService.FILE_FORMAT = 'code/file-list'
 *   → resourcesToBuffer() = VSBuffer.fromString(resources.map(r => r.toString()).join('\n'))
 *
 * 本文件只做「文本 → 本机路径」的纯解析，不碰系统剪贴板，因此与平台解耦：
 * 之后要接 macOS / 新增别的编辑器格式，照抄本文件的结构即可。
 */

/// 注册型剪贴板格式名（Windows 上交给 RegisterClipboardFormat；macOS/Linux 亦同名字符串）
pub const FORMAT_NAME: &str = "code/file-list";

/// 把 code/file-list 的文本负载解析成一组本机路径。
///
/// 逐行解析，跳过空行；解析不出的行（远程 / WSL 等本机没有对应路径的 URI）直接丢弃。
/// 返回的路径分隔符统一为 `/`，由前端（normalizeFsPath）再按需归一。
pub fn parse(payload: &str) -> Vec<String> {
    let mut out = Vec::new();
    for line in payload.split('\n') {
        let line = line.trim_end_matches('\r').trim();
        if line.is_empty() {
            continue;
        }
        if let Some(path) = uri_to_path(line) {
            if !path.is_empty() {
                out.push(path);
            }
        }
    }
    out
}

/// VS Code 的 URI → 本机文件路径：
/// - file:///c%3A/Users/foo   → c:/Users/foo
/// - file://server/share/foo  → //server/share/foo（UNC）
/// - 其它 scheme（vscode-remote / ssh / wsl …）本机没有对应路径，返回 None 由上层丢弃
fn uri_to_path(uri: &str) -> Option<String> {
    if uri.get(..7).is_some_and(|p| p.eq_ignore_ascii_case("file://")) {
        // rest = [authority]/path...
        let rest = &uri[7..];
        let (authority, path) = match rest.find('/') {
            Some(i) => (&rest[..i], &rest[i..]),
            None => (rest, ""),
        };
        let path = strip_query_and_fragment(path);
        let authority = percent_decode(authority);
        let decoded = percent_decode(path);

        if authority.is_empty() || authority.eq_ignore_ascii_case("localhost") {
            // 本地路径：Windows 的 file:///C:/... 解码后会多出一个前导斜杠
            let local = strip_drive_leading_slash(&decoded);
            // 空 / 仅根斜杠（如 file:///）没有意义，丢弃
            (!local.is_empty() && local != "/").then(|| local.to_string())
        } else {
            // UNC：file://server/share/... → //server/share/...
            Some(format!("//{}{}", authority, decoded))
        }
    } else if uri.contains("://") {
        None // 远程 scheme，本机没有对应路径
    } else {
        // 兜底：有的实现直接写纯路径
        let decoded = percent_decode(uri);
        if looks_like_absolute_path(&decoded) {
            Some(decoded)
        } else {
            None
        }
    }
}

/// 去掉 URI 的 ?query 与 #fragment（路径里这些字符一定是编码过的）
fn strip_query_and_fragment(path: &str) -> &str {
    let end = path.find(['?', '#']).unwrap_or(path.len());
    &path[..end]
}

/// /C:/... → C:/...（Windows 盘符前多出的斜杠）；macOS 的 /Users/... 不受影响
fn strip_drive_leading_slash(path: &str) -> &str {
    let b = path.as_bytes();
    if b.len() >= 3 && b[0] == b'/' && b[1].is_ascii_alphabetic() && b[2] == b':' {
        &path[1..]
    } else {
        path
    }
}

/// 像不像绝对路径（C:\... / C:/... / \\server\... / /posix/...）
fn looks_like_absolute_path(p: &str) -> bool {
    let b = p.as_bytes();
    (b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && (b[2] == b'\\' || b[2] == b'/'))
        || p.starts_with("\\\\")
        || p.starts_with('/')
}

/// 最小化的百分号解码：只处理 %XX，非法序列原样保留
fn percent_decode(input: &str) -> String {
    if !input.contains('%') {
        return input.to_string();
    }
    let bytes = input.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hi = (bytes[i + 1] as char).to_digit(16);
            let lo = (bytes[i + 2] as char).to_digit(16);
            if let (Some(hi), Some(lo)) = (hi, lo) {
                out.push((hi * 16 + lo) as u8);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_vscode_file_list() {
        let payload = "file:///c%3A/Users/wei/a%20b.txt\nfile:///C:/proj/x.py\n\
                       file://server/share/y.md\nvscode-remote://ssh-remote+host/home/z.txt\n\
                       C:\\plain\\path.dll\nfile:///d%3A/%E4%B8%AD%E6%96%87/%E6%B5%8B%E8%AF%95.txt\n\n";
        assert_eq!(
            parse(payload),
            vec![
                "c:/Users/wei/a b.txt".to_string(),
                "C:/proj/x.py".to_string(),
                "//server/share/y.md".to_string(),
                "C:\\plain\\path.dll".to_string(),
                "d:/中文/测试.txt".to_string(),
            ]
        );
    }

    #[test]
    fn ignores_remote_and_junk() {
        let payload = "vscode-remote://wsl+Ubuntu/home/x.txt\nnot a path\nfile:///\n";
        assert!(parse(payload).is_empty());
    }
}
