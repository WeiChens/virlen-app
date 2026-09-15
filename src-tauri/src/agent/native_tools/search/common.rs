//! search — 搜索分类公共函数（分类 id: search）
//!
//! 供本分类下的 `search_files_by_name` / `search_text_in_files` 复用。

/// 将 Glob 模式转换为正则表达式（与 JS globToRegex 对齐）
pub(super) fn glob_to_regex(pattern: &str) -> String {
    if pattern.is_empty() {
        return "^$".to_string();
    }
    let mut re = String::new();
    let chars: Vec<char> = pattern.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c == '*' {
            if i + 1 < chars.len() && chars[i + 1] == '*' {
                re.push_str(".*");
                i += 1;
            } else {
                re.push_str("[^/]*");
            }
        } else if c == '?' {
            re.push_str("[^/]");
        } else if c == '{' {
            if let Some(end) = chars[i + 1..].iter().position(|&x| x == '}') {
                let end = i + 1 + end;
                let opts: Vec<String> = pattern[i + 1..end]
                    .split(',')
                    .map(|o| escape_regex(o))
                    .collect();
                re.push('(');
                re.push_str(&opts.join("|"));
                re.push(')');
                i = end;
            } else {
                re.push_str("\\{");
            }
        } else if matches!(c, '.' | '+' | '^' | '$' | '{' | '}' | '(' | ')' | '|' | '[' | ']' | '\\') {
            re.push('\\');
            re.push(c);
        } else {
            re.push(c);
        }
        i += 1;
    }
    format!("^{}$", re)
}

/// 转义正则元字符（glob 花括号展开时对每个选项使用）
fn escape_regex(s: &str) -> String {
    let mut out = String::new();
    for c in s.chars() {
        if matches!(c, '.' | '+' | '^' | '$' | '{' | '}' | '(' | ')' | '|' | '[' | ']' | '\\') {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_glob_to_regex() {
        assert_eq!(glob_to_regex("**/*.ts"), "^.*/[^/]*\\.ts$");
        assert_eq!(glob_to_regex("*.json"), "^[^/]*\\.json$");
        assert_eq!(glob_to_regex("src/**/*.css"), "^src/.*/[^/]*\\.css$");
    }
}
