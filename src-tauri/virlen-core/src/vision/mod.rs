//! 端侧视觉分析（quasivision）—— 无 `tauri::` 依赖
//!
//! 模型目录定位 + 进程级懒加载 + 推理调用。核心实现放在这里的唯一目的：让 GUI 命令壳
//!（`vision_service.rs`）与原生工具（`native_tools/vision/vision_analyze.rs`）共用同一段实现 —— 否则
//! 会出现两份模型探测逻辑。
//!
//! ⚠️ 本文件不得引入 `tauri::`：`native_tools` 依赖它，而 `agent/**` 必须保持「引擎核心零 `tauri::`」
//!（headless / CLI 的前提）；宿主差异一律走 [`crate::agent::host::HostEnv`]。
//!
//! 模型文件位置：`<资源根>/quasivision_models/`（`ocr-models/` + `icon-classifier/` +
//! `object-detection/`）。
//!
//! ⚠️ 进度日志一律走 stderr（`eprintln!`），绝不能 `println!`：本 crate 也被 headless CLI
//! （`virlen-cli run --json`）使用，它的 stdout 是机器可读通道（每行一个 `AgentEvent` 的 JSON Lines；
//! 非 `--json` 时是助手正文）—— 插一行日志就让下游解析失败。GUI 侧行为不变（进程没有控制台）。

use crate::agent::host::{compile_time_resource_root, HostEnv};
use once_cell::sync::Lazy;
use quasivision::pipeline::PipelineConfig;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

/// 模型就位判据：探测 `quasivision_models/ocr-models/<该文件>` 是否存在。
const DET_MODEL_FILE: &str = "ppocrv5_mobile_det.onnx";

// ═══════════════════════════════════════════════════════════════════════════
// 返回结果
// ═══════════════════════════════════════════════════════════════════════════

#[derive(Serialize, Clone)]
pub struct VisionAnalyzeResult {
    pub ui_tree_text: String,
    pub objects_tree_text: String,
    pub combined_text: String,
    pub image_size: (u32, u32),
}

// ═══════════════════════════════════════════════════════════════════════════
// 模型目录定位
// ═══════════════════════════════════════════════════════════════════════════

fn compile_time_models_dir() -> PathBuf {
    compile_time_resource_root().join("quasivision_models")
}

/// 解析模型目录：按 `HostEnv::resource_candidates()` 的优先级逐个探测。
///
/// 错误文案与重构前**逐字一致**（GUI 下候选人相同，故行为完全等价）。
pub fn models_dir(host: &dyn HostEnv) -> Result<PathBuf, String> {
    for root in host.resource_candidates() {
        let p = root.join("quasivision_models");
        if p.join("ocr-models").join(DET_MODEL_FILE).exists() {
            return Ok(strip_verbatim_prefix(p));
        }
    }
    Err(format!(
        "quasivision models directory not found.\nSearched:\n  - {:?}\n  - resource_dir/quasivision_models/",
        compile_time_models_dir()
    ))
}

/// 去掉 Windows verbatim 路径前缀（`\\?\`），转成普通路径。
///
/// 只处理以 `\\?\` 开头的绝对路径（如 `\\?\E:\...`），其余路径原样返回。
/// Tauri 的 `resource_dir()` 在 Windows 上可能返回这种路径，而 quasivision 内部用
/// 字符串拼接 `"subdir/file"` 构造模型路径 —— verbatim 路径下 `/` 不被当作分隔符，
/// 模型文件会「找不到」。
fn strip_verbatim_prefix(p: PathBuf) -> PathBuf {
    let s = p.to_string_lossy();
    if let Some(stripped) = s.strip_prefix(r"\\?\") {
        PathBuf::from(stripped)
    } else {
        p
    }
}

/// `is_web` 启发式：路径里带 `web` / `page` 时用更灵敏的 UI 梯度阈值。
///
/// 唯一实现 —— GUI 命令与原生工具都调它（否则两侧阈值会分叉）。
pub fn is_web_hint(image_path: &str) -> bool {
    let lower = image_path.to_lowercase();
    lower.contains("web") || lower.contains("page")
}

// ═══════════════════════════════════════════════════════════════════════════
// 模型生命周期（进程级引用计数）
// ═══════════════════════════════════════════════════════════════════════════

/// 模型引用计数，支持并发调用（如 Promise.all 同时分析多张图片）。
/// 重构前存在 Tauri 托管状态里；对进程而言语义相同，放进程级静态即可（CLI 也能用）。
static REFCOUNT: Lazy<Mutex<u32>> = Lazy::new(|| Mutex::new(0));

/// 持有它 = 占一个模型引用；Drop 时自动归还（含 panic 展开路径）。
struct ModelGuard;

impl Drop for ModelGuard {
    fn drop(&mut self) {
        unload_models();
    }
}

fn load_models(models_dir: &Path) -> Result<ModelGuard, String> {
    let mut guard = REFCOUNT.lock().map_err(|e| format!("Lock error: {}", e))?;

    let prev = *guard;
    *guard += 1;

    if prev > 0 {
        // 已有其他调用加载了模型，只需递增计数
        return Ok(ModelGuard);
    }

    let models_dir_str = models_dir.to_string_lossy().to_string();

    std::env::set_var(
        "QUASIVISION_MODELS_DIR",
        models_dir.join("ocr-models").to_string_lossy().to_string(),
    );

    eprintln!("[Vision] Loading models from: {}", models_dir_str);
    match quasivision::init_models(&models_dir_str) {
        Ok(()) => {
            eprintln!("[Vision] Models loaded (refcount={})", *guard);
            Ok(ModelGuard)
        }
        Err(e) => {
            // 加载失败必须回滚计数（重构前漏了这一步 → 失败后 refcount 永久 > 0，
            // 后续调用再也不会重新尝试加载模型）
            *guard -= 1;
            Err(format!("Failed to load models: {}", e))
        }
    }
}

fn unload_models() {
    let mut guard = match REFCOUNT.lock() {
        Ok(g) => g,
        Err(_) => {
            eprintln!("[Vision] Failed to lock refcount for unload");
            return;
        }
    };

    if *guard == 0 {
        eprintln!("[Vision] unload_models called but refcount already 0");
        return;
    }

    *guard -= 1;
    let remaining = *guard;
    drop(guard); // 释放锁，clean_models 可能很慢

    if remaining > 0 {
        eprintln!(
            "[Vision] Skipping unload, still {} callers using models",
            remaining
        );
        return;
    }

    eprintln!("[Vision] Unloading models (last caller)...");
    quasivision::clean_models();
    eprintln!("[Vision] Models unloaded, memory freed");
}

// ═══════════════════════════════════════════════════════════════════════════
// 对外入口
// ═══════════════════════════════════════════════════════════════════════════

/// 从文件路径分析图片（GUI 命令 / 原生工具的公共实现）。
pub fn analyze_path(
    host: &dyn HostEnv,
    image_path: &str,
) -> Result<VisionAnalyzeResult, String> {
    if !Path::new(image_path).exists() {
        return Err(format!("Image file not found: {}", image_path));
    }

    let img_bytes = std::fs::read(image_path)
        .map_err(|e| format!("Failed to read file '{}': {}", image_path, e))?;

    analyze(host, &img_bytes, is_web_hint(image_path))
}

/// 从内存字节分析图片（粘贴 / 拖拽截图无需落盘）。
pub fn analyze(
    host: &dyn HostEnv,
    img_bytes: &[u8],
    is_web: bool,
) -> Result<VisionAnalyzeResult, String> {
    let dir = models_dir(host)?;
    analyze_at(&dir, img_bytes, is_web)
}

/// 取消时的统一错误文案。
///
/// 调用方（原生工具）据此把结果改写成取消口径，**不要**带成 `Vision Error: …` 前缀 ——
/// 取消不是推理失败。
pub const CANCELLED_MSG: &str = "Cancelled by the user";

/// 「调用方没有取消诉求」时传它的哨兵（命令壳 `vision_analyze` / `analyze_path` 走这条）。
static NEVER_CANCELLED: AtomicBool = AtomicBool::new(false);

/// 协作式取消检查：阻塞线程在每个推理阶段之间查一次，命中即退出。
fn ensure_not_cancelled(cancel: &AtomicBool) -> Result<(), String> {
    if cancel.load(Ordering::Relaxed) {
        return Err(CANCELLED_MSG.to_string());
    }
    Ok(())
}

/// 已解析出模型目录后的推理入口（`spawn_blocking` 友好：只吃 `&Path` 与字节）。
pub fn analyze_at(
    models_dir: &Path,
    img_bytes: &[u8],
    is_web: bool,
) -> Result<VisionAnalyzeResult, String> {
    analyze_at_cancellable(models_dir, img_bytes, is_web, &NEVER_CANCELLED)
}

/// 可取消的推理入口。
///
/// ⚠️ 取消为什么是**两层**（缺一层都是「点了停止没反应」）：
/// - 本函数的 `cancel` 标志：ONNX 单次推理内部不可中断，只能在**阶段之间**退出 ——
///   它保证取消后阻塞线程尽快收尾、不白烧 CPU；
/// - 调用方（`native_tools/vision/vision_analyze.rs`）的 `tokio::select!`：让工具**立刻**返回结果，
///   引擎马上收敛、UI 立刻有反馈（否则要等当前阶段跑完，OCR 阶段是秒级到十几秒）。
pub fn analyze_at_cancellable(
    models_dir: &Path,
    img_bytes: &[u8],
    is_web: bool,
    cancel: &AtomicBool,
) -> Result<VisionAnalyzeResult, String> {
    // 首次加载模型本身可能很慢（数秒）→ 先查一次，避免「刚点停止又在加载模型」
    ensure_not_cancelled(cancel)?;
    // 用 Drop guard 保证「无论成功 / 失败 / panic 展开」都归还引用计数
    let _guard = load_models(models_dir)?;
    run_analysis(models_dir, img_bytes, is_web, cancel)
}

// ═══════════════════════════════════════════════════════════════════════════
// OCR（只要文字）—— 文档内嵌图片抽字用
// ═══════════════════════════════════════════════════════════════════════════

/// 只要 OCR 文本：**跳过** UI 组件检测 / 图标识别 / 物体检测。
///
/// 为什么单独一条入口：文档里的扫描页不是界面截图，那三步既不必要又慢，还会把无关的树结构
/// 塞进正文（`docs/doc-parse-plan.md` §13）。推理同样在本机完成（图片不出本机），与
/// [`analyze_at`] 共用模型生命周期管理。
pub fn ocr_image_at(models_dir: &Path, img: &image::DynamicImage) -> Result<OcrText, String> {
    let _guard = load_models(models_dir)?;
    let cfg = PipelineConfig::new(&models_dir.to_string_lossy());
    let result = cfg
        .run_ocr(img)
        .map_err(|e| format!("OCR failed: {}", e))?;
    Ok(OcrText {
        text: text_of_ocr_boxes(&result.texts),
        sideways: sideways_ratio(&result.texts),
    })
}

/// 一段 OCR 结果
#[derive(Debug, Clone)]
pub struct OcrText {
    /// 按阅读顺序拼好的文本
    pub text: String,
    /// 文本框中「竖着」的占比（框高 > 框宽）—— 横过来存的扫描页认出来接近 1，正常页面接近 0
    ///
    /// 调用方靠它决定要不要换方向重试（`doc_parse::ocr`）：
    /// PP-OCR 对旋转文字只能认出一部分，硬读会得到残缺的文本。
    pub sideways: f32,
}

/// 「竖着」的文本框占比（没有文本框 → 0）
fn sideways_ratio(elements: &[quasivision::Element]) -> f32 {
    let boxes: Vec<&quasivision::Element> = elements
        .iter()
        .filter(|e| e.text_content.as_deref().map(str::trim).is_some_and(|t| !t.is_empty()))
        .collect();
    if boxes.is_empty() {
        return 0.0;
    }
    let vertical = boxes.iter().filter(|e| e.height > e.width).count();
    vertical as f32 / boxes.len() as f32
}

/// 一「行」：纵向区间（`row_min`..`row_max`）+ 该行的文本片段 `(column_min, 文本)`
type TextLine<'a> = (i32, i32, Vec<(i32, &'a str)>);

/// OCR 文本框 → 阅读顺序的纯文本。
///
/// 判据：按 `row_min` 排序；与已有行**垂直重叠超过较短者一半**的算同一行（表格的一行不会被
/// 拆成多行）；行内按 `column_min` 排序、用空格连起来，行间用 `\n`。
fn text_of_ocr_boxes(elements: &[quasivision::Element]) -> String {
    let mut lines: Vec<TextLine> = Vec::new();
    let mut boxes: Vec<(i32, i32, i32, &str)> = elements
        .iter()
        .filter_map(|e| {
            let text = e.text_content.as_deref().map(str::trim)?;
            if text.is_empty() {
                return None;
            }
            let p = &e.position;
            Some((p.row_min, p.row_max, p.column_min, text))
        })
        .collect();
    boxes.sort_by_key(|(row_min, _, col_min, _)| (*row_min, *col_min));

    for (row_min, row_max, col_min, text) in boxes {
        match lines
            .iter_mut()
            .find(|(min, max, _)| rows_overlap(*min, *max, row_min, row_max))
        {
            Some((min, max, fragments)) => {
                *min = (*min).min(row_min);
                *max = (*max).max(row_max);
                fragments.push((col_min, text));
            }
            None => lines.push((row_min, row_max, vec![(col_min, text)])),
        }
    }

    lines
        .iter_mut()
        .map(|(_, _, fragments)| {
            fragments.sort_by_key(|(col_min, _)| *col_min);
            fragments
                .iter()
                .map(|(_, text)| *text)
                .collect::<Vec<_>>()
                .join(" ")
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// 两个纵向区间是否属于同一行（重叠超过较短区间的一半）
fn rows_overlap(a_min: i32, a_max: i32, b_min: i32, b_max: i32) -> bool {
    let overlap = a_max.min(b_max) - a_min.max(b_min);
    let shortest = (a_max - a_min).min(b_max - b_min).max(1);
    overlap * 2 > shortest
}

// ═══════════════════════════════════════════════════════════════════════════
// 核心分析逻辑（从内存字节执行完整 pipeline）
// ═══════════════════════════════════════════════════════════════════════════

fn run_analysis(
    models_dir: &Path,
    img_bytes: &[u8],
    is_web: bool,
    cancel: &AtomicBool,
) -> Result<VisionAnalyzeResult, String> {
    let models_dir_str = models_dir.to_string_lossy().to_string();

    let ui_config = quasivision::Config {
        gradient_threshold: if is_web { 1 } else { 4 },
        ..quasivision::Config::default()
    };

    let cfg = PipelineConfig::new(&models_dir_str)
        .with_ui_config(ui_config)
        .with_paragraph(false)
        .with_remove_bar(true)
        .with_sub_component(true)
        .with_synthesize_text(true)
        .with_detect_conf(0.01);

    // ── 从内存解码图片（支持粘贴/拖拽无需落盘） ──
    let img = image::load_from_memory(img_bytes)
        .map_err(|e| format!(
            "Failed to decode image.\nSupported formats: PNG, JPEG, GIF, BMP, WEBP, TIFF, etc.\nError: {}",
            e
        ))?;
    let (img_h, img_w) = (img.height(), img.width());
    ensure_not_cancelled(cancel)?;

    // ── UI 组件检测 ──
    let comps = cfg
        .detect_components(&img)
        .map_err(|e| format!("UI detection failed: {}", e))?;
    ensure_not_cancelled(cancel)?;

    // ── OCR ──
    let text_result = cfg
        .run_ocr(&img)
        .map_err(|e| format!("OCR failed: {}", e))?;
    ensure_not_cancelled(cancel)?;

    // ── 合并 ──
    let mut elements = cfg
        .merge(&img, &comps, &text_result)
        .map_err(|e| format!("Merge failed: {}", e))?;

    // ── 图标识别 ──
    cfg.classify_icons(&img, &mut elements)
        .map_err(|e| format!("Icon classification failed: {}", e))?;
    ensure_not_cancelled(cancel)?;

    quasivision::compute_prominence(&mut elements);

    // ── 建立父子关系 ──
    elements.sort_by_key(|e| std::cmp::Reverse(e.area()));
    for e in &mut elements {
        e.parent = None;
        e.children = None;
    }

    let n = elements.len();
    let mut child_to_parent: Vec<(usize, usize)> = Vec::new();
    for i in 0..n {
        for j in (i + 1)..n {
            if elements[i].element_relation(&elements[j], (2, 2)) == 1 {
                child_to_parent.push((j, elements[i].id));
            }
        }
    }
    for &(child_idx, parent_id) in &child_to_parent {
        elements[child_idx].parent = Some(parent_id);
    }

    let mut children_map: std::collections::HashMap<usize, Vec<usize>> =
        std::collections::HashMap::new();
    for &(child_idx, parent_id) in &child_to_parent {
        children_map
            .entry(parent_id)
            .or_default()
            .push(elements[child_idx].id);
    }
    for e in &mut elements {
        if let Some(children) = children_map.remove(&e.id) {
            e.children = Some(children);
        }
    }

    // ── UI tree text ──
    let img_shape = (img_h, img_w);
    let ui_tree_text = quasivision::to_tree_text_string(&elements, img_shape);

    // ── 物体检测 ──（本函数里最慢的一步，调用前再查一次）
    ensure_not_cancelled(cancel)?;
    let detections = cfg.detect_objects(&img);
    let roots = quasivision::build_detection_tree(&detections);

    // 过滤掉置信度低于 20% 的检测结果
    let mut filtered_roots: Vec<quasivision::DetectionNode> = roots
        .into_iter()
        .filter_map(|n| filter_detection_node(n, 0.15))
        .collect();

    // 如果全部低于阈值，则取置信度最高的 top 5，让 AI 至少有参考数据
    if filtered_roots.is_empty() && !detections.is_empty() {
        let mut top5 = detections.clone();
        top5.sort_by(|a, b| {
            b.confidence
                .partial_cmp(&a.confidence)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        top5.truncate(5);
        filtered_roots = quasivision::build_detection_tree(&top5);
    }

    let objects_tree_text = quasivision::object_detection_to_tree_text(&filtered_roots, img_shape);

    // ── 合并输出（始终包含 YOLO 标题，让 AI 知道物体检测已执行） ──
    let combined_text = format!(
        "{}\n\n━━━ YOLOE-26n Analysis ━━━\n{}",
        ui_tree_text, objects_tree_text
    );

    Ok(VisionAnalyzeResult {
        ui_tree_text,
        objects_tree_text,
        combined_text,
        image_size: (img_w, img_h),
    })
}

/// 递归过滤检测节点：保留置信度 >= threshold 的节点
fn filter_detection_node(
    node: quasivision::DetectionNode,
    threshold: f32,
) -> Option<quasivision::DetectionNode> {
    if node.confidence < threshold {
        return None;
    }
    let children: Vec<quasivision::DetectionNode> = node
        .children
        .into_iter()
        .filter_map(|c| filter_detection_node(c, threshold))
        .collect();
    Some(quasivision::DetectionNode { children, ..node })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::host::HostEnv;

    /// 固定候选目录的假宿主（不碰环境变量 → 并行安全）
    struct FixedHost {
        roots: Vec<PathBuf>,
        data: PathBuf,
    }
    impl HostEnv for FixedHost {
        fn resource_candidates(&self) -> Vec<PathBuf> {
            self.roots.clone()
        }
        fn data_dir(&self) -> PathBuf {
            self.data.clone()
        }
    }

    fn tmp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("virlen_vision_{}_{}", tag, uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// 在 `<root>/quasivision_models/ocr-models/` 下放哨兵文件（模拟模型就位）
    fn plant_models(root: &Path) {
        let ocr = root.join("quasivision_models").join("ocr-models");
        std::fs::create_dir_all(&ocr).unwrap();
        std::fs::write(ocr.join(DET_MODEL_FILE), b"stub").unwrap();
    }

    #[test]
    fn models_dir_picks_first_existing_candidate() {
        let missing = tmp_dir("missing");
        let hit = tmp_dir("hit");
        plant_models(&hit);

        let host = FixedHost {
            roots: vec![missing.clone(), hit.clone()],
            data: hit.clone(),
        };
        let dir = models_dir(&host).unwrap();
        assert_eq!(dir, hit.join("quasivision_models"));

        std::fs::remove_dir_all(&missing).ok();
        std::fs::remove_dir_all(&hit).ok();
    }

    #[test]
    fn models_dir_errors_with_legacy_message_when_absent() {
        let empty = tmp_dir("empty");
        let host = FixedHost {
            roots: vec![empty.clone()],
            data: empty.clone(),
        };
        let err = models_dir(&host).unwrap_err();
        assert!(err.starts_with("quasivision models directory not found."), "{err}");
        assert!(err.contains("Searched:"), "{err}");
        std::fs::remove_dir_all(&empty).ok();
    }

    /// 剥 verbatim 前缀只对 `\\?\` 开头生效，其余路径原样返回。
    #[test]
    fn strip_verbatim_prefix_only_touches_verbatim_paths() {
        #[cfg(target_os = "windows")]
        {
            assert_eq!(
                strip_verbatim_prefix(PathBuf::from(r"\\?\E:\a\b")),
                PathBuf::from(r"E:\a\b")
            );
        }
        let plain = PathBuf::from("/a/b");
        assert_eq!(strip_verbatim_prefix(plain.clone()), plain);
    }

    /// 造一个 OCR 文本框（`Text` 类，带文本）
    fn ocr_box(id: usize, col: (i32, i32), row: (i32, i32), text: &str) -> quasivision::Element {
        let mut e = quasivision::Element::from_parts(id, col.0, row.0, col.1, row.1, "Text");
        e.text_content = Some(text.to_string());
        e
    }

    /// 同一行的框用空格连成一行，不同行换行；入参乱序也要按阅读顺序输出
    #[test]
    fn ocr_boxes_merge_into_reading_order_lines() {
        let boxes = vec![
            ocr_box(3, (120, 200), (50, 70), "30"),
            ocr_box(1, (0, 100), (10, 30), "Name"),
            ocr_box(4, (0, 100), (50, 70), "Alice"),
            ocr_box(2, (120, 200), (10, 30), "Age"),
        ];
        assert_eq!(text_of_ocr_boxes(&boxes), "Name Age\nAlice 30");
    }

    /// 空文本 / 无文本的框直接丢掉；垂直只有一点交叠的不算同一行
    #[test]
    fn ocr_boxes_without_text_are_dropped_and_rows_do_not_merge_loosely() {
        let mut empty = ocr_box(1, (0, 10), (0, 10), "   ");
        empty.text_content = None;
        let boxes = vec![
            empty,
            ocr_box(2, (0, 100), (10, 30), "first"),
            // 与上一行只交叠 2px（远小于较短高度 20px 的一半）→ 必须是新的一行
            ocr_box(3, (0, 100), (28, 48), "second"),
        ];
        assert_eq!(text_of_ocr_boxes(&boxes), "first\nsecond");
    }

    /// 「竖着的框占比」：正常横排 ≈ 0，躺着的扫描页（框高 > 框宽）≈ 1
    #[test]
    fn sideways_ratio_tells_upright_text_from_rotated_text() {
        assert_eq!(sideways_ratio(&[]), 0.0, "没有文本框时不该报「躺着」");
        let upright = vec![
            ocr_box(1, (0, 200), (10, 40), "horizontal"),
            ocr_box(2, (0, 300), (50, 80), "also horizontal"),
        ];
        assert_eq!(sideways_ratio(&upright), 0.0);
        let sideways = vec![
            ocr_box(1, (10, 40), (0, 200), "rotated"),
            ocr_box(2, (50, 80), (0, 300), "also rotated"),
        ];
        assert_eq!(sideways_ratio(&sideways), 1.0);
    }

    #[test]
    fn is_web_hint_matches_legacy_rule() {
        assert!(is_web_hint("C:/x/webpage.png"));
        assert!(is_web_hint("WEB.png"));
        assert!(is_web_hint("page1.jpg"));
        assert!(!is_web_hint("shot.png"));
        // 大小写不敏感（原实现先 to_lowercase）
        assert!(is_web_hint("MyPage.PNG"));
    }

    /// 取消预检必须在 `load_models` **之前**：模型目录故意指向不存在的路径，
    /// 若预检失效这里会拿到 "Failed to load models: …" 而不是取消文案。
    #[test]
    fn cancellable_entry_honours_pre_set_cancel_flag() {
        let cancel = AtomicBool::new(true);
        match analyze_at_cancellable(Path::new("/nonexistent/models"), b"x", false, &cancel) {
            Err(e) => assert_eq!(e, CANCELLED_MSG),
            Ok(_) => panic!("取消标志已置位时必须直接返回取消错误"),
        }
    }
}
