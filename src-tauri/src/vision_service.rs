// ── quasivision 视觉服务 ──
//
// 基于 quasivision crate 的 Tauri 命令层，提供两个命令：
//   vision_analyze        → 从文件路径读取图片分析
//   vision_analyze_base64 → 从 base64 数据 URL 分析（粘贴/拖拽截图无需落盘）
//
// 每次命令执行完毕自动 clean_models 释放 GPU/CPU 内存。
//
// 模型文件位置：resources/quasivision_models/
//   结构：ocr-models/ + icon-classifier/ + object-detection/

use quasivision::pipeline::PipelineConfig;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

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
// Tauri 托管状态
// ═══════════════════════════════════════════════════════════════════════════

/// 模型引用计数，支持并发调用（如 Promise.all 同时分析多张图片）
pub struct VisionState {
    refcount: Mutex<u32>,
}

pub fn setup_vision(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    app.manage(VisionState {
        refcount: Mutex::new(0),
    });
    Ok(())
}

// ═══════════════════════════════════════════════════════════════════════════
// 模型生命周期管理
// ═══════════════════════════════════════════════════════════════════════════

fn resolve_models_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dev_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("resources")
        .join("quasivision_models");
    if dev_path
        .join("ocr-models")
        .join("ppocrv5_mobile_det.onnx")
        .exists()
    {
        return Ok(dev_path);
    }

    if let Ok(resource_dir) = app.path().resource_dir() {
        for p in [
            resource_dir.join("quasivision_models"),
            resource_dir.join("resources").join("quasivision_models"),
        ] {
            if p.join("ocr-models")
                .join("ppocrv5_mobile_det.onnx")
                .exists()
            {
                return Ok(p);
            }
        }
    }

    Err(format!(
        "quasivision models directory not found.\nSearched:\n  - {:?}\n  - resource_dir/quasivision_models/",
        dev_path
    ))
}

fn load_models(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<VisionState>();
    let mut guard = state
        .refcount
        .lock()
        .map_err(|e| format!("Lock error: {}", e))?;

    let prev = *guard;
    *guard += 1;

    if prev > 0 {
        // 已有其他调用加载了模型，只需递增计数
        return Ok(());
    }

    let models_dir = resolve_models_dir(app)?;
    let models_dir_str = models_dir.to_string_lossy().to_string();

    std::env::set_var(
        "QUASIVISION_MODELS_DIR",
        models_dir.join("ocr-models").to_string_lossy().to_string(),
    );

    println!("[Vision] Loading models from: {}", models_dir_str);
    quasivision::init_models(&models_dir_str)
        .map_err(|e| format!("Failed to load models: {}", e))?;

    println!("[Vision] Models loaded (refcount={})", *guard);
    Ok(())
}

fn unload_models(state: &VisionState) {
    let mut guard = match state.refcount.lock() {
        Ok(g) => g,
        Err(_) => {
            println!("[Vision] Failed to lock refcount for unload");
            return;
        }
    };

    if *guard == 0 {
        println!("[Vision] unload_models called but refcount already 0");
        return;
    }

    *guard -= 1;
    let remaining = *guard;
    drop(guard); // 释放锁，clean_models 可能很慢

    if remaining > 0 {
        println!(
            "[Vision] Skipping unload, still {} callers using models",
            remaining
        );
        return;
    }

    println!("[Vision] Unloading models (last caller)...");
    quasivision::clean_models();
    println!("[Vision] Models unloaded, memory freed");
}

// ═══════════════════════════════════════════════════════════════════════════
// 命令 1：从文件路径读取图片分析
// ═══════════════════════════════════════════════════════════════════════════

#[tauri::command]
pub async fn vision_analyze(
    app: AppHandle,
    image_path: String,
) -> Result<VisionAnalyzeResult, String> {
    if !Path::new(&image_path).exists() {
        return Err(format!("Image file not found: {}", image_path));
    }

    let img_bytes = std::fs::read(&image_path)
        .map_err(|e| format!("Failed to read file '{}': {}", image_path, e))?;

    let source_desc = Path::new(&image_path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| image_path.clone());

    let is_web =
        image_path.to_lowercase().contains("web") || image_path.to_lowercase().contains("page");

    run_vision(&app, &img_bytes, &source_desc, is_web).await
}

// ═══════════════════════════════════════════════════════════════════════════
// 命令 2：从 base64 data URL 分析（粘贴/拖拽截图无需落盘）
// ═══════════════════════════════════════════════════════════════════════════

#[tauri::command]
pub async fn vision_analyze_base64(
    app: AppHandle,
    data_url: String,
) -> Result<VisionAnalyzeResult, String> {
    // 提取 base64 部分：去掉 "data:image/...;base64," 前缀
    let b64 = data_url
        .split(',')
        .nth(1)
        .ok_or_else(|| "Invalid data URL: missing comma separator".to_string())?;

    use base64::Engine as _;
    let img_bytes = base64::engine::general_purpose::STANDARD
        .decode(b64.trim())
        .map_err(|e| format!("Failed to decode base64: {}", e))?;

    run_vision(&app, &img_bytes, "clipboard", false).await
}

// ═══════════════════════════════════════════════════════════════════════════
// 核心分析逻辑（从内存字节执行完整 pipeline）
// ═══════════════════════════════════════════════════════════════════════════

async fn run_vision(
    app: &AppHandle,
    img_bytes: &[u8],
    _source_desc: &str,
    is_web: bool,
) -> Result<VisionAnalyzeResult, String> {
    load_models(app)?;
    let state = app.state::<VisionState>();

    // 用 defer 风格确保无论成功/失败都释放模型
    let result = run_analysis_inner(app, img_bytes, is_web);
    unload_models(&state);
    result
}

fn run_analysis_inner(
    app: &AppHandle,
    img_bytes: &[u8],
    is_web: bool,
) -> Result<VisionAnalyzeResult, String> {
    let models_dir = resolve_models_dir(app)?;
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

    // ── UI 组件检测 ──
    let comps = cfg
        .detect_components(&img)
        .map_err(|e| format!("UI detection failed: {}", e))?;

    // ── OCR ──
    let text_result = cfg
        .run_ocr(&img)
        .map_err(|e| format!("OCR failed: {}", e))?;

    // ── 合并 ──
    let mut elements = cfg
        .merge(&img, &comps, &text_result)
        .map_err(|e| format!("Merge failed: {}", e))?;

    // ── 图标识别 ──
    cfg.classify_icons(&img, &mut elements)
        .map_err(|e| format!("Icon classification failed: {}", e))?;

    quasivision::compute_prominence(&mut elements);

    // ── 建立父子关系 ──
    elements.sort_by(|a, b| b.area().cmp(&a.area()));
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

    // ── 物体检测 ──
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
