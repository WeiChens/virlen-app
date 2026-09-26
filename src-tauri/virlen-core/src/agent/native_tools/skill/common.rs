//! skill — 技能分类公共（元信息解析 / 目录扫描 / 文件树）
//!
//! ⚠️ 与 TS 侧逐字对齐（铁律 1）：[`parse_skill_entry`] ↔ `utils/mdYamlFrontmatter.ts::parseSkillMdMeta`
//! 及 `skill/skillStore.ts::parseSkillMeta`（frontmatter 优先，无则退回「`# 标题` + `> 描述` +
//! `**Version:** x.y.z`」）；[`normalize_skill_name`] ↔ `skill/types.ts::normalizeSkillName`；
//! [`render_file_tree`] ↔ `tools/skill/common.ts::renderFileTree`；[`read_file_tree`] ↔
//! `skillStore.ts::getSkillFileTree`；[`scan_skills`] ↔ `skillStore.ts::scanAndRegisterSkills`。
//! （TS 读 localStorage 注册表，原生侧每次直接扫盘 —— 对无 JS 的 CLI 是唯一可行做法）

use once_cell::sync::Lazy;
use regex::Regex;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

// ==================== 技能条目 ====================

/// 单个技能（扫盘结果）—— 与 TS `RegisteredSkill` 的投影（`meta` + `path`）
pub(crate) struct SkillEntry {
    pub name: String,
    pub description: String,
    pub version: Option<String>,
    pub tags: Option<Vec<String>>,
    /// 技能文件夹的绝对路径（统一用 `/` 分隔）
    pub path: String,
}

/// 技能目录下的一个条目（目录名带尾随 `/`，与 TS `getSkillFileTree` 一致）
///
/// 不保留 `isDir`：渲染只靠 `children`（与 TS `renderFileTree` 同）——
/// 留着就是永不读取的死字段。
pub(crate) struct SkillFileEntry {
    pub name: String,
    pub children: Option<Vec<SkillFileEntry>>,
}

// ==================== 名称归一化 ====================

/// 校验并归一化技能名 —— 与 TS `normalizeSkillName` 同语义：
/// 去掉双引号 → 小写 → trim；只允许 `[a-z0-9-]`；`None` = 非法（调用方跳过该目录）。
pub(crate) fn normalize_skill_name(raw: &str) -> Option<String> {
    let name = raw.replace('"', "").to_lowercase();
    let name = name.trim().to_string();
    if name.is_empty() {
        return None;
    }
    if !name
        .chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
    {
        return None;
    }
    Some(name)
}

// ==================== SKILL.md 元信息解析 ====================

static RE_FRONTMATTER: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?s)\A---\r?\n(.*?)\r?\n---").unwrap());
static RE_HEADING: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?m)^#+\s+(.+)$").unwrap());
/// emoji / 变体选择符（与 TS 里的字符类逐段一致）
static RE_EMOJI: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
        r"[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE00}-\u{FE0F}]",
    )
    .unwrap()
});
/// ⚠️ JS 的 `\w` 是 ASCII 的 `[A-Za-z0-9_]`，Rust regex 的 `\w` 默认 Unicode 感知，直接用会把中文留下
/// —— 这里显式写成 ASCII 类，保持与 TS 同结果。
static RE_NON_WORD: Lazy<Regex> = Lazy::new(|| Regex::new(r"[^A-Za-z0-9_\s-]").unwrap());
static RE_WS_RUN: Lazy<Regex> = Lazy::new(|| Regex::new(r"\s+").unwrap());
static RE_NON_NAME_CHAR: Lazy<Regex> = Lazy::new(|| Regex::new(r"[^a-z0-9-]").unwrap());
static RE_BLOCKQUOTE: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?m)^>\s*(.+)$").unwrap());
static RE_BOLD_PREFIX: Lazy<Regex> = Lazy::new(|| Regex::new(r"^\*\*.*?\*\*\s*").unwrap());
/// 版本号：`**Version:** x.y.z` / `**Version**: x.y.z` / `Version: x.y.z`
///（与 TS `utils/mdYamlFrontmatter.ts` 逐字一致 —— `**` 允许落在冒号外侧，铁律 1）
static RE_VERSION: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?:\*\*)?[Vv]ersion(?:\*\*)?:?\s*(?:\*\*)?\s*(\d+\.\d+\.\d+)").unwrap()
});

/// 解析结果（`name` 可能是未归一化的原始值，交给调用方归一化）
struct ParsedMeta {
    name: String,
    description: String,
    version: Option<String>,
    tags: Option<Vec<String>>,
}

/// 收尾一个块标量（`|` / `>` 系列）并写入字段
fn finish_block(
    fields: &mut HashMap<String, String>,
    key: &mut Option<String>,
    literal: &mut Option<bool>,
    lines: &mut Vec<String>,
) {
    if let (Some(k), Some(is_literal)) = (key.take(), literal.take()) {
        let value = if is_literal {
            lines.join("\n")
        } else {
            // 折叠块：换行当空格，并把连续空白压成一个空格（与 TS 的 `join(' ').replace(/\s+/g,' ')` 一致，
            // 含行首缩进被压成单个空格这一细节）
            RE_WS_RUN.replace_all(&lines.join(" "), " ").to_string()
        };
        fields.insert(k, value);
    }
    lines.clear();
}

/// 解析 YAML frontmatter（`None` = 没有 frontmatter）
fn parse_frontmatter(md: &str) -> Option<HashMap<String, String>> {
    let caps = RE_FRONTMATTER.captures(md)?;
    let frontmatter = caps.get(1).map(|m| m.as_str()).unwrap_or("");
    let mut fields: HashMap<String, String> = HashMap::new();

    let mut current_key: Option<String> = None;
    let mut literal: Option<bool> = None;
    let mut block_lines: Vec<String> = Vec::new();

    // ⚠️ 按 `\n` 切、不先剥 `\r`：与 TS `split('\n')` 一致 —— CRLF 下空行是 `"\r"`，既不是
    //    空串也不以空格开头，因此会提前结束块标量。这正是 TS 的行为。
    for line in frontmatter.split('\n') {
        if current_key.is_some() && literal.is_some() {
            let first = line.chars().next();
            if line.is_empty() || first == Some(' ') || first == Some('\t') {
                block_lines.push(line.trim_end().to_string());
                continue;
            }
            finish_block(&mut fields, &mut current_key, &mut literal, &mut block_lines);
        }

        let Some(colon) = line.find(':') else { continue };
        let key = line[..colon].trim().to_string();
        let value_part = line[colon + 1..].trim().to_string();

        match value_part.as_str() {
            "|" | "|-" | "|+" => {
                current_key = Some(key);
                literal = Some(true);
                block_lines.clear();
                continue;
            }
            ">" | ">-" | ">+" => {
                current_key = Some(key);
                literal = Some(false);
                block_lines.clear();
                continue;
            }
            _ => {}
        }
        fields.insert(key, value_part);
    }
    finish_block(&mut fields, &mut current_key, &mut literal, &mut block_lines);

    Some(fields)
}

/// 解析 tags：JSON 数组优先（单引号视作双引号），否则按逗号分隔并去掉方括号
fn parse_tags(raw: Option<&String>) -> Option<Vec<String>> {
    let raw = raw?;
    if raw.is_empty() {
        return None;
    }
    let json_like = raw.replace('\'', "\"");
    if let Ok(Value::Array(items)) = serde_json::from_str::<serde_json::Value>(&json_like) {
        let tags: Vec<String> = items
            .iter()
            .filter_map(|v| v.as_str())
            .map(|s| s.to_string())
            .collect();
        if !tags.is_empty() {
            return Some(tags);
        }
    }
    let tags: Vec<String> = raw
        .replace(['[', ']'], "")
        .split(',')
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty())
        .collect();
    if tags.is_empty() {
        None
    } else {
        Some(tags)
    }
}

use serde_json::Value;

/// 解析 SKILL.md 元信息（`fallback_name` = 文件夹名兜底）
fn parse_skill_md_meta(md: &str, fallback_name: &str) -> ParsedMeta {
    let fields = parse_frontmatter(md);
    if let Some(fields) = &fields {
        // 格式一：标准 frontmatter，且带 name 字段
        if let Some(name) = fields.get("name").filter(|n| !n.is_empty()) {
            return ParsedMeta {
                name: name.clone(),
                description: fields.get("description").cloned().unwrap_or_default(),
                version: fields.get("version").filter(|v| !v.is_empty()).cloned(),
                tags: parse_tags(fields.get("tags")),
            };
        }
    }

    // 格式二：纯 Markdown，从正文提取
    let body = match &fields {
        // 与 TS `mdContent.slice(mdContent.indexOf('---', 3) + 3).trim()` 等价：
        // 取闭合分隔符之后的部分（偏移是字节还是码元不影响结果子串）
        Some(_) => match md.get(3..).and_then(|rest| rest.find("---")) {
            Some(rel) => md[3 + rel + 3..].trim().to_string(),
            None => md.trim().to_string(),
        },
        None => md.trim().to_string(),
    };

    // name：第一个 `#` 标题，去掉 emoji 与特殊符号后归一化
    let raw_name = RE_HEADING
        .captures(&body)
        .and_then(|c| c.get(1))
        .map(|m| {
            RE_NON_WORD
                .replace_all(&RE_EMOJI.replace_all(m.as_str(), ""), "")
                .trim()
                .to_string()
        })
        .unwrap_or_default();

    let name = if raw_name.is_empty() {
        fallback_name.to_string()
    } else {
        RE_NON_NAME_CHAR
            .replace_all(&RE_WS_RUN.replace_all(&raw_name.to_lowercase(), "-"), "")
            .to_string()
    };

    // description：优先 `> 引用`，其次第一段非空文本
    let description = if let Some(c) = RE_BLOCKQUOTE.captures(&body) {
        c.get(1).map(|m| m.as_str().trim().to_string()).unwrap_or_default()
    } else {
        let mut found = String::new();
        for line in body.split('\n').filter(|l| !l.trim().is_empty()) {
            if line.starts_with('#') || line.starts_with('>') {
                continue;
            }
            found = RE_BOLD_PREFIX.replace(line, "").trim().to_string();
            if !found.is_empty() {
                break;
            }
        }
        found
    };

    // version：`**Version:** x.y.z` / `**Version**: x.y.z` / `Version: x.y.z`
    let version = RE_VERSION
        .captures(&body)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().to_string());

    ParsedMeta {
        name,
        description,
        version,
        tags: None,
    }
}

/// 解析一个技能目录（文件夹名 + SKILL.md 全文）→ 归一化后的元信息。
///
/// `None` = 目录名与 frontmatter 名都非法（TS 侧会抛异常 → 该目录被静默跳过）。
pub(crate) fn parse_skill_entry(folder: &str, md: &str) -> Option<SkillEntry> {
    let parsed = parse_skill_md_meta(md, folder);
    let raw_name = if parsed.name.is_empty() {
        folder.to_string()
    } else {
        parsed.name.clone()
    };
    let name = normalize_skill_name(&raw_name).or_else(|| normalize_skill_name(folder))?;
    Some(SkillEntry {
        name,
        description: parsed.description,
        version: parsed.version,
        tags: parsed.tags,
        // 真实路径由调用方（扫盘）填写
        path: String::new(),
    })
}

// ==================== 扫盘 ====================

/// 扫描技能目录：`skills_dir/<folder>/SKILL.md` → 元信息（同名以先扫到的为准）。
///
/// 与 TS 的差异（已在结论中记录、不影响语义）：目录按名字**排序**后再处理，
/// 让输出稳定（TS 用 `readDir` 的 OS 顺序）。
pub(crate) fn scan_skills(skills_dir: &str) -> Vec<SkillEntry> {
    if skills_dir.is_empty() {
        return Vec::new();
    }
    let Ok(entries) = std::fs::read_dir(skills_dir) else {
        return Vec::new();
    };

    let mut dirs: Vec<(String, PathBuf)> = entries
        .flatten()
        .filter(|e| e.path().is_dir())
        .map(|e| (e.file_name().to_string_lossy().to_string(), e.path()))
        .collect();
    dirs.sort_by(|a, b| a.0.cmp(&b.0));

    let mut out: Vec<SkillEntry> = Vec::new();
    for (folder, path) in dirs {
        // 没有 SKILL.md（或不可读）→ 跳过，非异常
        let Ok(md) = std::fs::read_to_string(path.join("SKILL.md")) else {
            continue;
        };
        let Some(mut entry) = parse_skill_entry(&folder, &md) else {
            continue;
        };
        // 主键唯一性：同名只保留先扫到的（与 TS 注册表的去重语义一致）
        if out.iter().any(|s| s.name == entry.name) {
            continue;
        }
        entry.path = path.to_string_lossy().replace('\\', "/");
        out.push(entry);
    }
    out
}

// ==================== 文件树 ====================

/// 读取技能目录树（跳过隐藏项；目录名带尾随 `/`）—— 与 TS `getSkillFileTree` 一致。
///
/// 目录按名字排序（同 [`scan_skills`] 的说明）；任一子目录读取失败即整体失败
/// （与 TS 的 `readTree` 抛错行为对齐）。
pub(crate) fn read_file_tree(dir: &Path) -> Result<Vec<SkillFileEntry>, String> {
    let entries = std::fs::read_dir(dir).map_err(|e| e.to_string())?;
    let mut items: Vec<(String, PathBuf, bool)> = entries
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            if name.is_empty() || name.starts_with('.') {
                return None;
            }
            let path = e.path();
            let is_dir = path.is_dir();
            Some((name, path, is_dir))
        })
        .collect();
    items.sort_by(|a, b| a.0.cmp(&b.0));

    let mut out = Vec::new();
    for (name, path, is_dir) in items {
        if is_dir {
            let children = read_file_tree(&path)?;
            out.push(SkillFileEntry {
                name: format!("{}/", name),
                children: Some(children),
            });
        } else {
            out.push(SkillFileEntry {
                name,
                children: None,
            });
        }
    }
    Ok(out)
}

/// 把目录树渲染成 `├──` / `└──` 风格文本行（追加到 `lines`）—— 与 TS `renderFileTree` 一致。
pub(crate) fn render_file_tree(entries: &[SkillFileEntry], prefix: &str, lines: &mut Vec<String>) {
    for (i, entry) in entries.iter().enumerate() {
        let is_last = i + 1 == entries.len();
        let connector = if is_last { "└── " } else { "├── " };
        let next_prefix = format!("{}{}", prefix, if is_last { "    " } else { "│   " });
        lines.push(format!("{}{}{}", prefix, connector, entry.name));
        if let Some(children) = &entry.children {
            if !children.is_empty() {
                render_file_tree(children, &next_prefix, lines);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_skill(root: &Path, folder: &str, md: &str) {
        let dir = root.join(folder);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("SKILL.md"), md).unwrap();
    }

    fn tmp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("virlen_skill_{}_{}", tag, uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn frontmatter_variant() {
        let md = "---\nname: my-skill\ndescription: 一个技能\nversion: 1.2.3\ntags: [a, b]\n---\n\n# 正文\n";
        let entry = parse_skill_entry("folder", md).unwrap();
        assert_eq!(entry.name, "my-skill");
        assert_eq!(entry.description, "一个技能");
        assert_eq!(entry.version.as_deref(), Some("1.2.3"));
        assert_eq!(entry.tags.unwrap(), vec!["a".to_string(), "b".to_string()]);
    }

    #[test]
    fn frontmatter_block_scalars() {
        // 字面量块（保留换行，**行首缩进原样保留** —— TS `blockLines.push(line.trimEnd())` 同此）
        let md = "---\nname: x\ndescription: |\n  第一行\n  第二行\nversion: 1.0.0\n---\nbody\n";
        let entry = parse_skill_entry("f", md).unwrap();
        assert_eq!(entry.description, "  第一行\n  第二行");

        // 折叠块（换行压成空格；行首缩进被压成单个空格）
        let md2 = "---\nname: x\ndescription: >-\n  甲\n  乙\n---\n";
        let entry2 = parse_skill_entry("f", md2).unwrap();
        assert_eq!(entry2.description, " 甲 乙");
    }

    #[test]
    fn markdown_only_variant() {
        // TS 兼容格式二：# 标题 + > 描述 + **Version:**
        let md = "# 📝 Resume Assistant\n\n> AI-powered skill for resumes.\n\n**Version:** 1.0.0 · **License:** MIT\n";
        let entry = parse_skill_entry("fallback", md).unwrap();
        assert_eq!(entry.name, "resume-assistant", "标题 → 小写 + 空格转中划线");
        assert_eq!(entry.description, "AI-powered skill for resumes.");
        // ⚠️ 逐字对齐 TS：`**Version:** x.y.z` 这种写法（`AGENTS.md` §9.2 与 TS `importService` 错误提示
        //    共用的示例）两侧都必须取到版本号 —— 历史缺陷（正则与注释不符）已在两侧同时修正（铁律 1）。
        assert_eq!(
            entry.version.as_deref(),
            Some("1.0.0"),
            "`**Version:** x.y.z` 应取到版本号"
        );
        assert!(entry.tags.is_none());

        // 与 TS 正则同结果的各类写法（含 `**` 落在冒号外侧）
        for (md, expected) in [
            ("# T\n> d\n\n**Version**: 2.3.4\n", "2.3.4"),
            ("# T\n> d\n\nVersion: 2.3.4\n", "2.3.4"),
            ("# T\n> d\n\n**Version:** 2.3.5\n", "2.3.5"),
        ] {
            let entry = parse_skill_entry("f", md).unwrap();
            assert_eq!(entry.version.as_deref(), Some(expected), "md: {md}");
        }
    }

    #[test]
    fn markdown_fallback_name_uses_folder() {
        // 标题全是 emoji / 中文 → 归一化后为空 → 用文件夹名
        let md = "# 我的技能\n\n第一段描述\n";
        let entry = parse_skill_entry("folder-name", md).unwrap();
        assert_eq!(entry.name, "folder-name");
        assert_eq!(entry.description, "第一段描述");
    }

    #[test]
    fn invalid_names_are_rejected() {
        // 文件夹名非法 + 没有可用 name → None（该目录被跳过）
        let md = "# 我的技能\n";
        assert!(parse_skill_entry("我的技能", md).is_none());
        // 引号会被剥掉后归一化
        assert_eq!(normalize_skill_name("\"My-Skill\"").as_deref(), Some("my-skill"));
        assert!(normalize_skill_name("   ").is_none());
        assert!(normalize_skill_name("a_b").is_none(), "下划线非法");
    }

    #[test]
    fn scan_skips_dirs_without_skill_md_and_dedupes() {
        let root = tmp_dir("scan");
        write_skill(&root, "alpha", "---\nname: alpha\ndescription: A\n---\n");
        write_skill(&root, "beta", "# 📦 Beta Tool\n> B 描述\n");
        // 没有 SKILL.md → 跳过
        std::fs::create_dir_all(root.join("empty")).unwrap();
        // 同名（frontmatter 与 alpha 撞车）→ 只保留先扫到的
        write_skill(&root, "zzz", "---\nname: alpha\ndescription: 重复\n---\n");

        let skills = scan_skills(&root.to_string_lossy());
        let names: Vec<&str> = skills.iter().map(|s| s.name.as_str()).collect();
        // `beta` 目录的 name 来自标题（Beta Tool → beta-tool）；`zzz` 与 alpha 同名 → 去重被丢
        assert_eq!(names, vec!["alpha", "beta-tool"], "按目录名排序 + 同名去重");
        assert_eq!(skills[0].description, "A");
        assert!(skills[0].path.ends_with("/alpha"));
        assert!(skills[0].path.contains("virlen_skill_scan"), "path 是绝对路径");

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn scan_missing_dir_is_empty() {
        assert!(scan_skills("").is_empty());
        assert!(scan_skills(&format!(
            "{}virlen_missing_{}",
            std::env::temp_dir().display(),
            uuid::Uuid::new_v4()
        ))
        .is_empty());
    }

    #[test]
    fn tree_reading_skips_hidden_and_sorts() {
        let root = tmp_dir("tree");
        write_skill(&root, "demo", "---\nname: demo\n---\n");
        let demo = root.join("demo");
        std::fs::create_dir_all(demo.join("scripts")).unwrap();
        std::fs::write(demo.join("scripts/tool.js"), "x").unwrap();
        std::fs::write(demo.join("README.md"), "x").unwrap();
        std::fs::write(demo.join(".hidden"), "x").unwrap();

        let tree = read_file_tree(&demo).unwrap();
        let names: Vec<&str> = tree.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["README.md", "SKILL.md", "scripts/"], "隐藏文件被跳过 + 排序");
        assert!(tree[2].children.is_some(), "目录带 children");
        assert_eq!(
            tree[2].children.as_ref().unwrap()[0].name,
            "tool.js",
            "目录内的条目"
        );
        // 隐藏文件不在树里
        assert!(!names.contains(&".hidden"));

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn renders_tree_with_connectors() {
        let root = tmp_dir("render");
        let demo = root.join("demo");
        std::fs::create_dir_all(demo.join("scripts")).unwrap();
        std::fs::write(demo.join("SKILL.md"), "x").unwrap();
        std::fs::write(demo.join("scripts/run.js"), "x").unwrap();

        let tree = read_file_tree(&demo).unwrap();
        let mut lines = vec!["📂 demo/".to_string()];
        render_file_tree(&tree, "  ", &mut lines);
        assert_eq!(
            lines.join("\n"),
            "📂 demo/\n  ├── SKILL.md\n  └── scripts/\n      └── run.js"
        );

        std::fs::remove_dir_all(&root).ok();
    }
}
