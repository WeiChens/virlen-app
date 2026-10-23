//! `present` 的唯一类型判据：这个文件能不能在右侧面板预览。
//!
//! 清单本体是 `preview_ext.json`（`include_str!` 内嵌），TS 镜像
//! `src/domain/files/preview.ts`；契约测试 `src/tests/contracts/present-preview-ext.test.ts`
//! 守两侧一致（改一处漏改另一处会红）。
//!
//! ⚠️ 顺序即语义：先查 `previewable`，再查 `notPreviewable` —— `obj` 同时在两处
//! （3D 模型 / MSVC 目标文件），模型优先，与 `preview.ts::previewKindOf` 同口径。
//! 未知扩展名与无扩展名一律按文本试读（`LICENSE` / `Makefile` 这类没有被挡的理由），
//! 只拒清单里明确的二进制容器（ODF / 压缩包 / 可执行文件 / 字体 …）。

use std::collections::HashSet;
use std::sync::OnceLock;

use serde_json::Value;

struct PreviewExtTable {
    /// 面板有专门预览通道的扩展名（含 textPreview 那几种）
    previewable: HashSet<String>,
    /// 明确的二进制容器：打开只会落到「暂不支持预览 → 在系统程序中打开」
    not_previewable: HashSet<String>,
}

fn table() -> &'static PreviewExtTable {
    static TABLE: OnceLock<PreviewExtTable> = OnceLock::new();
    TABLE.get_or_init(|| {
        // 内嵌资源：解析失败说明 JSON 本身被改坏了，属编译期就能发现的错误
        let file: Value = serde_json::from_str(include_str!("preview_ext.json"))
            .expect("preview_ext.json 必须是合法 JSON");
        let mut previewable: HashSet<String> = HashSet::new();
        if let Some(groups) = file.get("previewable").and_then(|v| v.as_object()) {
            for list in groups.values() {
                if let Some(items) = list.as_array() {
                    previewable.extend(
                        items
                            .iter()
                            .filter_map(|item| item.as_str())
                            .map(|ext| ext.to_lowercase()),
                    );
                }
            }
        }
        let not_previewable: HashSet<String> = file
            .get("notPreviewable")
            .and_then(|v| v.as_array())
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| item.as_str())
                    .map(|ext| ext.to_lowercase())
                    .collect()
            })
            .unwrap_or_default();
        PreviewExtTable {
            previewable,
            not_previewable,
        }
    })
}

/// 这个文件名能否在右侧面板预览（`present` 的唯一判据）。
///
/// 无扩展名 → `true`（面板按文本试读）；清单外的未知扩展名同样 → `true`。
pub fn is_previewable(file_name: &str) -> bool {
    let ext = crate::doc_parse::extension_of(file_name);
    if ext.is_empty() {
        return true;
    }
    let table = table();
    if table.previewable.contains(&ext) {
        return true;
    }
    !table.not_previewable.contains(&ext)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn previewable_types_pass() {
        for name in [
            "报表.xlsx",
            "合同.docx",
            "讲稿.pptx",
            "说明.pdf",
            "截图.PNG",
            "演示.mp4",
            "场景.glb",
            "README.md",
            "data.csv",
            "index.html",
        ] {
            assert!(is_previewable(name), "{name} 应可预览");
        }
    }

    #[test]
    fn binary_containers_are_rejected() {
        for name in ["表.ods", "文档.odt", "包.zip", "app.exe", "font.ttf", "model.psd"] {
            assert!(!is_previewable(name), "{name} 不该被当成可预览");
        }
    }

    /// `obj` 同时在「3D 模型」与「二进制」两处：模型优先
    #[test]
    fn model_wins_over_overlapping_binary() {
        assert!(is_previewable("scene.obj"));
        assert!(!is_previewable("build/foo.o"));
        assert!(!is_previewable("app.pdb"));
    }

    /// 无扩展名 / 未知扩展名：面板按文本试读，不在这里拦
    #[test]
    fn unknown_and_extensionless_fall_back_to_text() {
        assert!(is_previewable("LICENSE"));
        assert!(is_previewable("Makefile"));
        assert!(is_previewable("data.weird-ext"));
    }

    /// 大小写不敏感；`a.tar.gz` 只认最后一段
    #[test]
    fn case_insensitive_on_last_segment() {
        assert!(!is_previewable("C:/ws/报表.ODS"));
        assert!(!is_previewable("C:/ws/备份.tar.gz"));
        assert!(is_previewable("C:/ws/报表.XLSX"));
    }
}
