//! `provider` 子命令 —— 交互式增删改查供应商配置（`app_settings.providers`）
//!
//! ```text
//! virlen-cli provider add                交互向导：逐步录入 → 验证 → 落库
//! virlen-cli provider edit [<id>]        交互向导（现有值作默认；API Key 留空 = 保留）
//! virlen-cli provider rm <id> [--yes]    删除（需确认；--yes 跳过）
//! virlen-cli provider list [--json]      列出（不打印 apiKey）
//! virlen-cli provider test <id>          连通性检查（拉模型列表 + 发一条 ping）
//! ```
//!
//! 存在的理由：此前只能 `config set providers '[{…完整 JSON…}]'`，而那是整键覆盖 —— 想加一个供应商
//! 必须把已有全部 provider 连 `id` / `createdAt` 一起抄进去，漏一个字段就把现有配置毁掉（评审项 N2）。
//! 本命令把这件事变成「回答几个问题」。
//!
//! ## 三条口径（都对齐桌面端）
//!
//! 1. 字段名逐字对齐前端 `ProviderConfig`（`templateName` / `baseUrl` / `reasoningEffortList`…）
//!    —— 两侧**不建映射表**（`docs/config-sink-plan.md` §6 R6）；
//! 2. 模板表 / 推理档位表来自 `virlen-core`（`agent/provider/provider_catalog.json`）—— 与桌面端读的
//!    是同一份，不在这里另抄一份；
//! 3. 只写自己改的字段（`settings_edit::upsert_by_id` 的字段级合并）：`enabled` / `createdAt` 以及
//!    桌面端以后新增的字段都不会被抹掉。
//!
//! ⚠️ `gemini` 等未原生化的协议走前端 JS 桥（`BridgedProvider`），CLI 里没有 JS —— 向导会在第 3 步
//! 明确拒绝，而不是让你配完才发现跑不起来（`session_rt::resources` 也是这个口径）。

use serde_json::{json, Map, Value};
use std::io::{BufRead, IsTerminal, Write};
use std::sync::Arc;

use virlen_core::agent::host::HostEnv;
use virlen_core::agent::provider::catalog::{provider_catalog, ProviderCatalog};
use virlen_core::agent::provider::{list_models, verify_connection};
use virlen_core::agent::types::ProviderConnection;
use virlen_core::session_db::{open_session_db, SettingsRepo};

use crate::list::render::{brief, pad, pad_left};
use crate::settings_edit::{
    field_str as get_str, field_strs as get_strs, find_index, read_array, remove_by_id,
    upsert_by_id, write_array,
};
use crate::wizard::Prompter;
use crate::{EXIT_ERROR, EXIT_OK, EXIT_USAGE};

/// `providers` 在 `app_settings` 里的键名（与前端 `SettingsStore.providers` **同名同层**）
const KEY: &str = "providers";
/// 数组项的 id 字段（与 `ProviderConfig.id` 逐字一致）
const ID_FIELD: &str = "id";
/// 拉取到的模型超过这个数就不逐条列出（改成 `all` / 手工输入），避免刷屏
const MAX_MODEL_OPTIONS: usize = 50;

// ==================== 帮助 ====================

pub(crate) const USAGE_PROVIDER: &str = "\
virlen-cli provider —— 交互式管理供应商配置（与桌面端同一份 app_settings.providers）

用法:
  virlen-cli provider add                交互向导：逐步录入 → 验证 → 写入
  virlen-cli provider edit [<id>]        交互向导（不给 id 时从列表里选）
                                         现有值作默认；API Key 留空 = 保留，输入 - = 清空
  virlen-cli provider rm <id> [--yes]    删除（需确认；--yes 跳过确认）
  virlen-cli provider list [--json]      列出全部供应商（**不打印 apiKey**）
  virlen-cli provider test <id>          连通性检查（拉模型列表 + 发一条 ping）
  virlen-cli provider -h                 显示本帮助

说明:
  · add / edit 是**交互式**命令：stdin 不是终端（管道 / CI）时直接报用法错误，不会挂住。
  · 写入是「按 id 合并单项」：其它供应商、以及本项里没改到的字段（enabled / createdAt /
    桌面端以后新增的字段）都保持原样。
  · ⚠️ 桌面端**正在运行**时，它会在下次改动时用内存副本整组覆盖 providers ——
    改完请重启桌面端（或先退出它再改）。
  · gemini 等需要前端 JS 桥的协议不能在 CLI 里配置（向导会在选择协议时拒绝）。

退出码:
  0 成功    1 失败 / 用户取消    2 用法错误（含「非终端却在跑交互命令」）
";

// ==================== 参数解析 ====================

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum ProvCmd {
    Help,
    Add,
    Edit { id: Option<String> },
    Rm { id: String, yes: bool },
    List { json: bool },
    Test { id: String },
}

/// 解析 `provider` 之后的参数。纯函数 —— 单测直接断言它。
pub(crate) fn parse(args: Vec<&str>) -> Result<ProvCmd, String> {
    let mut it = args.into_iter();
    let Some(sub) = it.next() else {
        return Err("provider 缺少子命令（可用: add / edit / rm / list / test）".to_string());
    };
    let rest: Vec<&str> = it.collect();
    match sub {
        "-h" | "--help" | "help" => Ok(ProvCmd::Help),
        "add" => {
            if let Some(extra) = rest.first() {
                Err(format!("provider add 不接受参数（多出: {}）", extra))
            } else {
                Ok(ProvCmd::Add)
            }
        }
        "edit" => match rest.as_slice() {
            [] => Ok(ProvCmd::Edit { id: None }),
            [id] => Ok(ProvCmd::Edit {
                id: Some((*id).to_string()),
            }),
            _ => Err("用法: provider edit [<id>]".to_string()),
        },
        "rm" | "remove" | "delete" => {
            let mut id: Option<String> = None;
            let mut yes = false;
            for a in rest {
                match a {
                    "--yes" | "-y" => yes = true,
                    other if other.starts_with('-') => {
                        return Err(format!(
                            "未知选项: {}（见 `virlen-cli provider -h`）",
                            other
                        ))
                    }
                    other => {
                        if id.is_some() {
                            return Err("provider rm 只接受一个 <id>".to_string());
                        }
                        id = Some(other.to_string());
                    }
                }
            }
            Ok(ProvCmd::Rm {
                id: id.ok_or_else(|| "用法: provider rm <id> [--yes]".to_string())?,
                yes,
            })
        }
        "list" | "ls" => {
            let mut out_json = false;
            for a in rest {
                match a {
                    "--json" => out_json = true,
                    other => {
                        return Err(format!(
                            "未知选项: {}（见 `virlen-cli provider -h`）",
                            other
                        ))
                    }
                }
            }
            Ok(ProvCmd::List { json: out_json })
        }
        "test" => match rest.as_slice() {
            [id] => Ok(ProvCmd::Test {
                id: (*id).to_string(),
            }),
            _ => Err("用法: provider test <id>".to_string()),
        },
        other => Err(format!(
            "provider 未知子命令: {}（可用: add / edit / rm / list / test）",
            other
        )),
    }
}

// ==================== 入口 ====================

pub(crate) async fn run(
    host: &Arc<dyn HostEnv>,
    cmd: ProvCmd,
    out: &mut dyn Write,
    err: &mut dyn Write,
) -> i32 {
    if let ProvCmd::Help = cmd {
        let _ = write!(out, "{}", USAGE_PROVIDER);
        return EXIT_OK;
    }
    let db = match open_session_db(host.as_ref(), &|fut| {
        tokio::spawn(fut);
    }) {
        Ok(db) => db,
        Err(e) => {
            let _ = writeln!(err, "错误: 打开数据库失败: {}", e);
            return EXIT_ERROR;
        }
    };
    let settings: &dyn SettingsRepo = db.settings.as_ref();
    match cmd {
        ProvCmd::Add => run_add(settings, out, err).await,
        ProvCmd::Edit { id } => run_edit(settings, id, out, err).await,
        ProvCmd::Rm { id, yes } => run_rm(settings, &id, yes, out, err).await,
        ProvCmd::List { json } => run_list(settings, json, out, err).await,
        ProvCmd::Test { id } => run_test(settings, &id, out, err).await,
        ProvCmd::Help => unreachable!("help 已在上面返回"),
    }
}

// ==================== add / edit ====================

/// 向导收集到的草稿（字段名与前端 `ProviderConfig` 逐字一致）
#[derive(Debug)]
struct Draft {
    id: String,
    name: String,
    template_name: String,
    type_: String,
    base_url: String,
    /// `None` = 编辑时「保留现有 apiKey」（patch 里干脆不带这个键 → 合并语义天然保留）
    api_key: Option<String>,
    models: Vec<String>,
    reasoning_effort_list: Vec<String>,
    reasoning_effort: String,
}

async fn run_add(settings: &dyn SettingsRepo, out: &mut dyn Write, err: &mut dyn Write) -> i32 {
    if !std::io::stdin().is_terminal() {
        let _ = writeln!(
            err,
            "错误: `provider add` 是交互式命令（stdin 不是终端）。请在终端里运行；\
             脚本请改用 `virlen-cli config set providers ...`"
        );
        return EXIT_USAGE;
    }
    let catalog = match provider_catalog() {
        Ok(c) => c,
        Err(e) => {
            let _ = writeln!(err, "错误: {}", e);
            return EXIT_ERROR;
        }
    };
    let mut arr = match read_array(settings, KEY).await {
        Ok(a) => a,
        Err(e) => {
            let _ = writeln!(err, "错误: {}", e);
            return EXIT_ERROR;
        }
    };
    let id = unique_provider_id(&arr, virlen_core::telemetry::now_ms());

    let mut input = std::io::stdin().lock();
    let tty = std::io::stdin().is_terminal();
    let draft = match collect(&mut input, &mut *out, tty, &catalog, &id, None).await {
        Ok(d) => d,
        Err(e) => {
            let _ = writeln!(err, "{}", e);
            return EXIT_ERROR;
        }
    };
    finish_write(settings, &mut arr, &draft, true, out, err).await
}

async fn run_edit(
    settings: &dyn SettingsRepo,
    id: Option<String>,
    out: &mut dyn Write,
    err: &mut dyn Write,
) -> i32 {
    let mut arr = match read_array(settings, KEY).await {
        Ok(a) => a,
        Err(e) => {
            let _ = writeln!(err, "错误: {}", e);
            return EXIT_ERROR;
        }
    };
    if arr.is_empty() {
        let _ = writeln!(
            err,
            "错误: 没有可编辑的供应商（app_settings.providers 为空）；先用 `virlen-cli provider add` 创建"
        );
        return EXIT_ERROR;
    }
    let id = match id {
        Some(x) => x,
        None => match pick_provider_id(&arr, out) {
            Ok(x) => x,
            Err(code) => return code,
        },
    };
    let Some(idx) = find_index(&arr, ID_FIELD, &id) else {
        let _ = writeln!(err, "错误: 供应商不存在: {}", id);
        return EXIT_ERROR;
    };
    let existing = arr[idx].clone();
    let catalog = match provider_catalog() {
        Ok(c) => c,
        Err(e) => {
            let _ = writeln!(err, "错误: {}", e);
            return EXIT_ERROR;
        }
    };
    let mut input = std::io::stdin().lock();
    let tty = std::io::stdin().is_terminal();
    let draft = match collect(&mut input, &mut *out, tty, &catalog, &id, Some(&existing)).await {
        Ok(d) => d,
        Err(e) => {
            let _ = writeln!(err, "{}", e);
            return EXIT_ERROR;
        }
    };
    finish_write(settings, &mut arr, &draft, false, out, err).await
}

/// 不给 id 时从列表里挑一个（也要求真终端）
fn pick_provider_id(arr: &[Value], out: &mut dyn Write) -> Result<String, i32> {
    if !std::io::stdin().is_terminal() {
        let _ = writeln!(
            out,
            "错误: `provider edit` 不给 id 时需要真终端（stdin 不是终端）"
        );
        return Err(EXIT_USAGE);
    }
    let labels: Vec<String> = arr
        .iter()
        .map(|v| format!("{}  [{}]", get_str(v, "name"), get_str(v, ID_FIELD)))
        .collect();
    let mut input = std::io::stdin().lock();
    let tty = std::io::stdin().is_terminal();
    let mut p = Prompter::new(&mut input, out, tty);
    match p.choose("请选择要编辑的供应商：", &labels, 0) {
        Ok(i) => Ok(get_str(&arr[i], ID_FIELD)),
        // 错误也得能看见：`p` 还抓着 `out`，所以经它写
        Err(e) => {
            p.say(&e);
            Err(EXIT_ERROR)
        }
    }
}

/// 交互收集（**唯一**的提问处）。`existing` 为 `None` = 新增。
///
/// 拆成独立函数是为了让提问与落库分开：`Prompter` 独占借用 `out`，收集完才好继续写结果。
async fn collect(
    input: &mut dyn BufRead,
    out: &mut dyn Write,
    tty: bool,
    catalog: &ProviderCatalog,
    id: &str,
    existing: Option<&Value>,
) -> Result<Draft, String> {
    let mut p = Prompter::new(input, out, tty);
    let mut n = 0usize;
    macro_rules! step {
        ($title:expr) => {{
            n += 1;
            p.step(n, $title);
        }};
    }

    // ── 1. 模板 ──
    step!("选择模板");
    let labels: Vec<String> = catalog.templates.iter().map(|t| t.label.clone()).collect();
    let default_tmpl = existing
        .map(|e| get_str(e, "templateName"))
        .and_then(|name| {
            catalog
                .templates
                .iter()
                .position(|t| t.template_name == name)
        })
        .or_else(|| {
            catalog
                .templates
                .iter()
                .position(|t| t.template_name == "custom")
        })
        .unwrap_or(0);
    let ti = p.choose("请选择供应商模板：", &labels, default_tmpl)?;
    let tmpl = catalog.templates[ti].clone();

    // ── 2. 名称 ──
    step!("名称");
    let name_default = existing
        .map(|e| get_str(e, "name"))
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| tmpl.label.clone());
    let name = p.text("名称（展示用）", Some(&name_default))?;

    // ── 3. 协议类型（仅模板支持多协议时问） ──
    let mut type_ = tmpl.type_name.clone();
    let mut base_default = tmpl.base_url.clone();
    if let Some(alts) = tmpl.allow_type_list.as_ref().filter(|a| a.len() > 1) {
        step!("协议类型");
        let opts: Vec<String> = alts.iter().map(|a| a.type_name.clone()).collect();
        let existing_type = existing.map(|e| get_str(e, "type")).unwrap_or_default();
        let d = opts
            .iter()
            .position(|t| *t == existing_type)
            .or_else(|| opts.iter().position(|t| *t == tmpl.type_name))
            .unwrap_or(0);
        let i = p.choose("该供应商支持多种协议，请选择：", &opts, d)?;
        type_ = alts[i].type_name.clone();
        base_default = alts[i].base_url.clone();
    }
    if !matches!(type_.as_str(), "openai" | "anthropic") {
        return Err(format!(
            "CLI 暂不支持 `{}` 协议（{}）：它需要前端 JS 桥（BridgedProvider），请在桌面端配置。\n\
             提示：若该服务商同时提供 openai 兼容端点，请改用 `custom` 模板并把协议选成 openai",
            type_, tmpl.label
        ));
    }

    // ── 4. API 地址 ──
    step!("API 地址");
    let existing_base = existing.map(|e| get_str(e, "baseUrl")).unwrap_or_default();
    let base_default = if existing_base.trim().is_empty() {
        base_default
    } else {
        existing_base
    };
    let base_url = if base_default.trim().is_empty() {
        p.text_with("API 地址（完整 Base URL，含 /v1 之类的路径）", None, validate_base_url)?
    } else {
        p.text_with("API 地址", Some(&base_default), validate_base_url)?
    };

    // ── 5. API Key ──
    step!("API Key");
    let existing_key = existing.map(|e| get_str(e, "apiKey")).unwrap_or_default();
    let api_key: Option<String> = if existing.is_some() {
        if existing_key.is_empty() {
            p.say("  当前没有 API Key。");
        } else {
            p.say(&format!("  当前：{}", mask(&existing_key)));
        }
        p.say("  留空 = 保留当前值；输入 - = 清空；其它 = 替换");
        match p.secret_opt("API Key")? {
            None => None,
            Some(v) if v.trim() == "-" => Some(String::new()),
            Some(v) => Some(v),
        }
    } else {
        Some(p.secret("API Key")?)
    };
    let effective_key = api_key.clone().unwrap_or_else(|| existing_key.clone());

    // ── 6. 模型列表 ──
    step!("模型列表");
    let existing_models = existing.map(|e| get_strs(e, "models")).unwrap_or_default();
    let models = collect_models(&mut p, &type_, &effective_key, &base_url, &existing_models).await?;

    // ── 7. 推理强度候选项 ──
    step!("推理强度候选项");
    if let Some(hint) = tmpl.allow_reasoning_effort_list.as_ref() {
        p.say(&format!("  （该模板的参考档位：{}）", hint.join(", ")));
    }
    let union = catalog.reasoning_effort_union.clone();
    let existing_efforts = existing
        .map(|e| get_strs(e, "reasoningEffortList"))
        .unwrap_or_default();
    let effort_default: Vec<usize> = if existing_efforts.is_empty() {
        catalog
            .default_reasoning_effort_list
            .iter()
            .filter_map(|d| union.iter().position(|u| u == d))
            .collect()
    } else {
        union
            .iter()
            .enumerate()
            .filter(|(_, u)| existing_efforts.contains(u))
            .map(|(i, _)| i)
            .collect()
    };
    let picked = p.multi(
        "勾选该服务商实际支持的档位（聊天界面只能从勾选值里切换）：",
        &union,
        &effort_default,
    )?;
    // `multi` 返回的是**升序下标** → 天然就是并集顺序（前端 `sortReasoningEfforts` 的同一口径）
    let reasoning_effort_list: Vec<String> = picked.iter().map(|i| union[*i].clone()).collect();

    // ── 8. 默认档位（没勾任何档位就跳过） ──
    let mut reasoning_effort = String::new();
    if !reasoning_effort_list.is_empty() {
        step!("默认推理强度");
        let mut opts = vec!["（不设置）".to_string()];
        opts.extend(reasoning_effort_list.iter().cloned());
        let existing_default = existing
            .map(|e| get_str(e, "reasoningEffort"))
            .unwrap_or_default();
        let d = opts.iter().position(|o| *o == existing_default).unwrap_or(0);
        let i = p.choose("会话未单独切换时使用哪一档？", &opts, d)?;
        if i > 0 {
            reasoning_effort = opts[i].clone();
        }
    }

    // ── 9. 连通性验证 ──
    step!("连通性验证");
    if p.confirm("现在发一条 ping 验证连接？（会真实消耗 1 个 token）", true)? {
        let conn = ProviderConnection {
            provider_type: type_.clone(),
            provider_id: id.to_string(),
            api_key: effective_key.clone(),
            base_url: base_url.clone(),
        };
        match verify_connection(&conn, &models[0]).await {
            Ok(text) => {
                let tail = if text.trim().is_empty() {
                    String::new()
                } else {
                    format!("（模型回复：{}）", text.trim())
                };
                p.say(&format!("  ✓ 验证通过{}", tail));
            }
            Err(e) => {
                p.say(&format!("  ✗ 验证失败: {}", e));
                if !p.confirm("仍然写入这份配置？", false)? {
                    return Err("已取消（连通性验证未通过）".to_string());
                }
            }
        }
    } else {
        p.say("  已跳过验证。");
    }

    // ── 10. 回显 + 确认 ──
    step!("确认写入");
    p.say(&format!("  名称        : {}", name));
    p.say(&format!("  模板        : {} ({})", tmpl.label, tmpl.template_name));
    p.say(&format!("  协议 / 地址 : {}  {}", type_, base_url));
    p.say(&format!(
        "  API Key     : {}",
        if effective_key.is_empty() {
            "（空）".to_string()
        } else {
            mask(&effective_key)
        }
    ));
    p.say(&format!("  模型        : {}", models.join(", ")));
    p.say(&format!(
        "  推理档位    : {}",
        if reasoning_effort_list.is_empty() {
            "（未设置）".to_string()
        } else {
            reasoning_effort_list.join(", ")
        }
    ));
    p.say(&format!(
        "  默认档位    : {}",
        if reasoning_effort.is_empty() {
            "（不设置）".to_string()
        } else {
            reasoning_effort.clone()
        }
    ));
    if !p.confirm("写入配置？", true)? {
        return Err("已取消，未写入任何内容".to_string());
    }

    Ok(Draft {
        id: id.to_string(),
        name,
        template_name: tmpl.template_name.clone(),
        type_,
        base_url,
        api_key,
        models,
        reasoning_effort_list,
        reasoning_effort,
    })
}

/// 模型列表：先尝试自动拉取，失败 / 太多 / 没有 key 时退回手工输入
async fn collect_models(
    p: &mut Prompter<'_>,
    type_: &str,
    api_key: &str,
    base_url: &str,
    existing: &[String],
) -> Result<Vec<String>, String> {
    if api_key.trim().is_empty() {
        p.say("  （没有 API Key，跳过自动拉取）");
        return manual_models(p, existing, None);
    }
    p.say(&format!("  正在拉取 {}/models …", base_url.trim_end_matches('/')));
    match list_models(type_, api_key, base_url).await {
        Ok(list) if list.is_empty() => {
            p.say("  ⚠ 服务端返回了空列表");
            manual_models(p, existing, None)
        }
        Ok(list) if list.len() > MAX_MODEL_OPTIONS => {
            p.say(&format!(
                "  ✓ 拉取到 {} 个模型（超过 {} 个，不逐条列出；可用 `all` 全选）",
                list.len(),
                MAX_MODEL_OPTIONS
            ));
            manual_models(p, existing, Some(&list))
        }
        Ok(list) => {
            p.say(&format!("  ✓ 拉取到 {} 个模型", list.len()));
            let default: Vec<usize> = if existing.is_empty() {
                // 新增时默认全选 —— 与桌面端「自动获取模型列表」把整份列表都塞进去的行为一致
                (0..list.len()).collect()
            } else {
                list.iter()
                    .enumerate()
                    .filter(|(_, m)| existing.contains(m))
                    .map(|(i, _)| i)
                    .collect()
            };
            let picked = p.multi("勾选要启用的模型：", &list, &default)?;
            Ok(picked.into_iter().map(|i| list[i].clone()).collect())
        }
        Err(e) => {
            p.say(&format!("  ✗ 拉取失败: {}", e));
            manual_models(p, existing, None)
        }
    }
}

/// 手工输入模型 id（逗号分隔）；有拉取结果时可用 `all` 全选
fn manual_models(
    p: &mut Prompter<'_>,
    existing: &[String],
    fetched: Option<&[String]>,
) -> Result<Vec<String>, String> {
    let hint = match fetched {
        Some(f) => format!("（`all` = 全选拉取到的 {} 个）", f.len()),
        None => String::new(),
    };
    let default = if existing.is_empty() {
        None
    } else {
        Some(existing.join(", "))
    };
    loop {
        let raw = p.text_opt(&format!("模型 id（逗号分隔）{}", hint), default.as_deref())?;
        let t = raw.trim();
        if t.eq_ignore_ascii_case("all") {
            if let Some(f) = fetched {
                return Ok(f.to_vec());
            }
        }
        let mut seen = std::collections::HashSet::new();
        let list: Vec<String> = t
            .split([',', '，', ';', '；', ' ', '\t'])
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .filter(|s| seen.insert((*s).to_string()))
            .map(String::from)
            .collect();
        if list.is_empty() {
            p.say("  ✗ 至少要填一个模型 id（`run` 需要 models 非空）");
            continue;
        }
        return Ok(list);
    }
}

/// 落库（add 与 edit 共用）：按 id 合并一项 → 写回 → 回读校验
async fn finish_write(
    settings: &dyn SettingsRepo,
    arr: &mut Vec<Value>,
    draft: &Draft,
    is_new: bool,
    out: &mut dyn Write,
    err: &mut dyn Write,
) -> i32 {
    let now = virlen_core::telemetry::now_ms();
    let mut patch = Map::new();
    patch.insert("name".into(), json!(draft.name));
    patch.insert("templateName".into(), json!(draft.template_name));
    patch.insert("type".into(), json!(draft.type_));
    patch.insert("baseUrl".into(), json!(draft.base_url));
    patch.insert("models".into(), json!(draft.models));
    patch.insert("reasoningEffortList".into(), json!(draft.reasoning_effort_list));
    patch.insert("reasoningEffort".into(), json!(draft.reasoning_effort));
    patch.insert("updatedAt".into(), json!(now));
    // 编辑时 apiKey 为 `None` → **不放这个键** → 合并语义天然保留旧值
    if let Some(k) = &draft.api_key {
        patch.insert("apiKey".into(), json!(k));
    }
    if is_new {
        patch.insert("enabled".into(), json!(true));
        patch.insert("createdAt".into(), json!(now));
    }

    if let Err(e) = upsert_by_id(arr, ID_FIELD, &draft.id, &patch) {
        let _ = writeln!(err, "错误: {}", e);
        return EXIT_ERROR;
    }
    match write_array(settings, KEY, arr).await {
        Ok(()) => {
            let _ = writeln!(
                out,
                "{}供应商 `{}`（{}）",
                if is_new { "已新增 " } else { "已更新 " },
                draft.id,
                draft.name
            );
            let _ = writeln!(
                out,
                "  {}  {} 个模型  {}",
                draft.type_,
                draft.models.len(),
                draft.base_url
            );
            let _ = writeln!(
                err,
                "提示: 桌面端正在运行时，它下次改动会用内存副本整组覆盖 providers —— 请重启桌面端（或先退出它再改）。"
            );
            EXIT_OK
        }
        Err(e) => {
            let _ = writeln!(err, "错误: {}", e);
            EXIT_ERROR
        }
    }
}

// ==================== rm / list / test ====================

async fn run_rm(
    settings: &dyn SettingsRepo,
    id: &str,
    yes: bool,
    out: &mut dyn Write,
    err: &mut dyn Write,
) -> i32 {
    let mut arr = match read_array(settings, KEY).await {
        Ok(a) => a,
        Err(e) => {
            let _ = writeln!(err, "错误: {}", e);
            return EXIT_ERROR;
        }
    };
    let Some(idx) = find_index(&arr, ID_FIELD, id) else {
        let _ = writeln!(err, "错误: 供应商不存在: {}", id);
        return EXIT_ERROR;
    };
    let name = get_str(&arr[idx], "name");

    // 引用检查：删掉被 Agent 引用的供应商，会让那些 Agent 直接跑不起来
    let agents = read_array(settings, "agents").await.unwrap_or_default();
    let referenced: Vec<String> = agents
        .iter()
        .filter(|a| {
            a.get("defaultModel")
                .and_then(|m| m.get("providerConfigId"))
                .and_then(Value::as_str)
                == Some(id)
        })
        .map(|a| {
            let n = get_str(a, "name");
            if n.is_empty() {
                get_str(a, ID_FIELD)
            } else {
                n
            }
        })
        .collect();

    if !yes {
        if !std::io::stdin().is_terminal() {
            let _ = writeln!(
                err,
                "错误: 删除需要确认，但 stdin 不是终端。确认要删就加 `--yes`"
            );
            return EXIT_USAGE;
        }
        let mut input = std::io::stdin().lock();
        let tty = std::io::stdin().is_terminal();
        let mut p = Prompter::new(&mut input, &mut *out, tty);
        if !referenced.is_empty() {
            p.say(&format!(
                "⚠ 以下 Agent 的默认模型正指向它：{}",
                referenced.join("、")
            ));
        }
        match p.confirm(&format!("确定删除 `{}`（{}）？", id, name), false) {
            Ok(true) => {}
            Ok(false) => {
                let _ = writeln!(err, "已取消，未删除任何内容");
                return EXIT_ERROR;
            }
            Err(e) => {
                let _ = writeln!(err, "{}", e);
                return EXIT_ERROR;
            }
        }
    }

    remove_by_id(&mut arr, ID_FIELD, id);
    match write_array(settings, KEY, &arr).await {
        Ok(()) => {
            let _ = writeln!(out, "已删除供应商 `{}`（{}）", id, name);
            if !referenced.is_empty() {
                let _ = writeln!(
                    err,
                    "⚠ 以下 Agent 的默认模型仍指向已删除的 `{}`，请到桌面端改掉：{}",
                    id,
                    referenced.join("、")
                );
            }
            EXIT_OK
        }
        Err(e) => {
            let _ = writeln!(err, "错误: {}", e);
            EXIT_ERROR
        }
    }
}

async fn run_list(
    settings: &dyn SettingsRepo,
    as_json: bool,
    out: &mut dyn Write,
    err: &mut dyn Write,
) -> i32 {
    let arr = match read_array(settings, KEY).await {
        Ok(a) => a,
        Err(e) => {
            let _ = writeln!(err, "错误: {}", e);
            return EXIT_ERROR;
        }
    };

    if as_json {
        let masked: Vec<Value> = arr.iter().map(mask_secret_fields).collect();
        let _ = writeln!(
            out,
            "{}",
            serde_json::to_string_pretty(&json!({
                "total": masked.len(),
                "providers": masked,
            }))
            .unwrap_or_default()
        );
        return EXIT_OK;
    }

    if arr.is_empty() {
        let _ = writeln!(
            out,
            "没有供应商（app_settings.providers 为空）：用 `virlen-cli provider add` 交互创建"
        );
        return EXIT_OK;
    }

    let _ = writeln!(out, "共 {} 个供应商\n", arr.len());
    let _ = writeln!(
        out,
        "{}  {}  {}  {}  {}  API 地址",
        pad("ID", COL_ID),
        pad("名称", COL_NAME),
        pad("协议", COL_TYPE),
        pad_left("模型", COL_MODELS),
        pad("状态", COL_FLAG),
    );
    for v in &arr {
        let models = get_strs(v, "models");
        let enabled = v
            .get("enabled")
            .and_then(Value::as_bool)
            .unwrap_or(true);
        let _ = writeln!(
            out,
            "{}  {}  {}  {}  {}  {}",
            pad(&get_str(v, ID_FIELD), COL_ID),
            pad(&brief(&get_str(v, "name"), COL_NAME), COL_NAME),
            pad(&get_str(v, "type"), COL_TYPE),
            pad_left(&models.len().to_string(), COL_MODELS),
            pad(if enabled { "启用" } else { "停用" }, COL_FLAG),
            brief(&get_str(v, "baseUrl"), COL_URL),
        );
    }
    EXIT_OK
}

async fn run_test(
    settings: &dyn SettingsRepo,
    id: &str,
    out: &mut dyn Write,
    err: &mut dyn Write,
) -> i32 {
    let arr = match read_array(settings, KEY).await {
        Ok(a) => a,
        Err(e) => {
            let _ = writeln!(err, "错误: {}", e);
            return EXIT_ERROR;
        }
    };
    let Some(idx) = find_index(&arr, ID_FIELD, id) else {
        let _ = writeln!(err, "错误: 供应商不存在: {}", id);
        return EXIT_ERROR;
    };
    let v = &arr[idx];
    let type_ = get_str(v, "type");
    let api_key = get_str(v, "apiKey");
    let base_url = get_str(v, "baseUrl");
    let models = get_strs(v, "models");

    if !matches!(type_.as_str(), "openai" | "anthropic") {
        let _ = writeln!(
            err,
            "错误: CLI 无法测试 `{}` 协议（需要前端 JS 桥），请在桌面端测试",
            type_
        );
        return EXIT_ERROR;
    }
    if api_key.trim().is_empty() {
        let _ = writeln!(err, "错误: 供应商 `{}` 没有 apiKey", id);
        return EXIT_ERROR;
    }
    if base_url.trim().is_empty() {
        let _ = writeln!(err, "错误: 供应商 `{}` 没有 baseUrl", id);
        return EXIT_ERROR;
    }

    let _ = writeln!(
        out,
        "供应商 {}（{} / {}）",
        id,
        get_str(v, "name"),
        type_
    );
    let mut ok = true;

    match list_models(&type_, &api_key, &base_url).await {
        Ok(list) => {
            let _ = writeln!(
                out,
                "  ✓ 模型列表 {} 个：{}",
                list.len(),
                brief(&list.join(", "), 120)
            );
        }
        Err(e) => {
            ok = false;
            let _ = writeln!(out, "  ✗ 模型列表失败: {}", e);
        }
    }

    match models.first() {
        Some(m) => {
            let conn = ProviderConnection {
                provider_type: type_.clone(),
                provider_id: id.to_string(),
                api_key: api_key.clone(),
                base_url: base_url.clone(),
            };
            match verify_connection(&conn, m).await {
                Ok(_) => {
                    let _ = writeln!(out, "  ✓ 连通性验证通过（模型 {}）", m);
                }
                Err(e) => {
                    ok = false;
                    let _ = writeln!(out, "  ✗ 连通性验证失败: {}", e);
                }
            }
        }
        None => {
            let _ = writeln!(out, "  - 未配置模型，跳过连通性验证");
        }
    }

    if ok {
        EXIT_OK
    } else {
        EXIT_ERROR
    }
}

// ==================== 小工具 ====================

/// apiKey 掩码：**只在尾部保留 4 个字符**，好让用户能认出「是哪一把」，又不至于泄漏
fn mask(key: &str) -> String {
    let chars: Vec<char> = key.chars().collect();
    let n = chars.len();
    if n <= 4 {
        return "****".to_string();
    }
    let tail: String = chars[n - 4..].iter().collect();
    format!("****{}", tail)
}

/// 把 JSON 里所有 `apiKey` / `api_key` 字段替换成掩码（`provider list --json` 用）
fn mask_secret_fields(v: &Value) -> Value {
    match v {
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(k, val)| {
                    let lk = k.to_ascii_lowercase();
                    if lk == "apikey" || lk == "api_key" {
                        let s = val.as_str().unwrap_or("");
                        (
                            k.clone(),
                            if s.is_empty() {
                                Value::String(String::new())
                            } else {
                                Value::String(mask(s))
                            },
                        )
                    } else {
                        (k.clone(), mask_secret_fields(val))
                    }
                })
                .collect(),
        ),
        Value::Array(items) => Value::Array(items.iter().map(mask_secret_fields).collect()),
        other => other.clone(),
    }
}

/// Base URL 校验：必须带协议头（写错时立刻报错，而不是等第一次请求才暴露）
fn validate_base_url(v: &str) -> Result<(), String> {
    let t = v.trim();
    if t.is_empty() {
        return Err("不能为空".to_string());
    }
    if !(t.starts_with("http://") || t.starts_with("https://")) {
        return Err("必须以 http:// 或 https:// 开头".to_string());
    }
    Ok(())
}

/// 生成一个不与现有项冲突的 id（与桌面端同格式：`provider-<毫秒>`）
fn unique_provider_id(arr: &[Value], now_ms: i64) -> String {
    let base = format!("provider-{}", now_ms);
    if find_index(arr, ID_FIELD, &base).is_none() {
        return base;
    }
    for n in 1..1000 {
        let cand = format!("{}-{}", base, n);
        if find_index(arr, ID_FIELD, &cand).is_none() {
            return cand;
        }
    }
    base
}

// ---- 表格列宽（与 `list` 命令同一种「按显示列宽对齐」的做法） ----
const COL_ID: usize = 22;
const COL_NAME: usize = 18;
const COL_TYPE: usize = 10;
const COL_MODELS: usize = 6;
const COL_FLAG: usize = 6;
const COL_URL: usize = 46;

#[cfg(test)]
mod tests;
