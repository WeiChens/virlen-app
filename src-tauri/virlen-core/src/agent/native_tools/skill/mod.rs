//! skill — 技能分类（分类 id: skill）
//!
//! 一个工具一个文件：`list_skills`（列出本 agent 启用的技能元信息）、`read_skill_source`（技能源码目录
//! 结构 + SKILL.md 全文）。`common.rs` 为分类内公共：SKILL.md 元信息解析 / 技能目录扫描 / 文件树渲染。
//!
//! ⚠️ 与 TS 侧 `src/skill/*` + `src/utils/mdYamlFrontmatter.ts` + `src/infrastructure/tools/skill/*`
//! 逐字对齐（铁律 1）。原生侧自己扫盘（而不是复用 TS 的 localStorage 注册表）的原因：CLI / headless 没
//! 有 WebView、没有 localStorage。技能目录来自 `NativeToolSecurity.skills_dir`。

mod common;
mod list_skills;
mod read_skill_source;

pub(crate) use list_skills::list_skills_tool;
pub(crate) use read_skill_source::read_skill_source_tool;
