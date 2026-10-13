//! 测试用的 PDF 构造器（`#[cfg(test)]`）—— 不落二进制 fixture：形状全靠 `lopdf` 写出来。
//!
//! 谁在用：`pdf` 的内嵌图片测试、`pdf` 的文字层（版面重排）测试、
//! `ocr` 的「模型不在 / 页面没有图」降级测试。
//! 放共享模块而不是各写一份：造 PDF 的样板代码有 40 行，抄两遍必然漂。

// ⚠️ 必须 `use` 进来：`lopdf::dictionary!` 的「尾逗号」分支内部调的是**未限定**的 `dictionary!`，
// 在调用点无此名字时报 `cannot find macro`
use lopdf::dictionary;

/// 手搭一份 PDF（文字层测试用）：页与资源都是调用方给的
///
/// 为什么需要它：内嵌图片那份 [`pdf`] 只会摆 `/XObject`，而文字层测试要的是「字体 + 内容流」
/// （尤其 `/DescendantFonts` 这种**引用**别的字典的字体，得先把那些对象塞进文档才拿得到对象号）。
/// 页面尺寸固定 `612 × 792`（美式信纸；文字测试只关心相对位置）。
pub(crate) struct PdfBuilder {
    doc: lopdf::Document,
    pages_id: lopdf::ObjectId,
    kids: Vec<lopdf::Object>,
}

impl PdfBuilder {
    pub(crate) fn new() -> Self {
        let mut doc = lopdf::Document::with_version("1.4");
        let pages_id = doc.new_object_id();
        Self {
            doc,
            pages_id,
            kids: Vec::new(),
        }
    }

    /// 塞一个对象进去（字体字典 / 字体描述符 / 流），拿回它的对象号
    pub(crate) fn add(&mut self, object: impl Into<lopdf::Object>) -> lopdf::ObjectId {
        self.doc.add_object(object)
    }

    /// 加一页：`content` 是内容流原文，`resources` 是这页的资源字典
    pub(crate) fn page(&mut self, content: &str, resources: lopdf::Dictionary) -> &mut Self {
        let content_id = self.doc.add_object(lopdf::Stream::new(
            dictionary! {},
            content.as_bytes().to_vec(),
        ));
        let page_id = self.doc.add_object(dictionary! {
            "Type" => "Page",
            "Parent" => self.pages_id,
            "MediaBox" => vec![0.into(), 0.into(), 612.into(), 792.into()],
            "Resources" => resources,
            "Contents" => content_id,
        });
        self.kids.push(lopdf::Object::Reference(page_id));
        self
    }

    /// 落成字节
    pub(crate) fn finish(mut self) -> Vec<u8> {
        let count = self.kids.len() as i64;
        let kids = std::mem::take(&mut self.kids);
        self.doc.objects.insert(
            self.pages_id,
            lopdf::Object::Dictionary(dictionary! {
                "Type" => "Pages",
                "Kids" => kids,
                "Count" => count,
            }),
        );
        let catalog_id = self
            .doc
            .add_object(dictionary! { "Type" => "Catalog", "Pages" => self.pages_id });
        self.doc.trailer.set("Root", catalog_id);
        let mut out = Vec::new();
        self.doc.save_to(&mut out).unwrap();
        out
    }
}

/// 一张 8 位灰度图片（原始采样，不压缩）
pub(crate) fn gray_stream(width: i64, height: i64, samples: Vec<u8>) -> lopdf::Stream {
    lopdf::Stream::new(
        dictionary! {
            "Type" => "XObject",
            "Subtype" => "Image",
            "Width" => width,
            "Height" => height,
            "ColorSpace" => "DeviceGray",
            "BitsPerComponent" => 8,
        },
        samples,
    )
}

/// 造一份 PDF：`pages` 是「每页画哪几个 XObject 名字」（决定绘制顺序），`xobjects` 是「名字 → 图片流」
pub(crate) fn pdf(pages: &[Vec<&str>], xobjects: &[(&str, lopdf::Stream)]) -> Vec<u8> {
    use lopdf::{Document, Object, Stream};

    let mut doc = Document::with_version("1.4");
    let pages_id = doc.new_object_id();
    let ids: Vec<(&str, lopdf::ObjectId)> = xobjects
        .iter()
        .map(|(name, stream)| (*name, doc.add_object(stream.clone())))
        .collect();
    let xdict: lopdf::Dictionary = ids
        .iter()
        .map(|(name, id)| (name.as_bytes().to_vec(), Object::Reference(*id)))
        .collect();

    let mut kids = Vec::new();
    for drawn in pages {
        let content: String = drawn.iter().map(|name| format!("/{name} Do ")).collect();
        let content_id = doc.add_object(Stream::new(dictionary! {}, content.into_bytes()));
        let page_id = doc.add_object(dictionary! {
            "Type" => "Page",
            "Parent" => pages_id,
            "MediaBox" => vec![0.into(), 0.into(), 200.into(), 200.into()],
            "Resources" => dictionary! { "XObject" => xdict.clone() },
            "Contents" => content_id,
        });
        kids.push(Object::Reference(page_id));
    }
    doc.objects.insert(
        pages_id,
        Object::Dictionary(dictionary! {
            "Type" => "Pages",
            "Kids" => kids,
            "Count" => pages.len() as i64,
        }),
    );
    let catalog_id = doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages_id });
    doc.trailer.set("Root", catalog_id);

    let mut out = Vec::new();
    doc.save_to(&mut out).unwrap();
    out
}

/// 造一份「扫描件」PDF：一整页就是一张 JPEG（真扫描件的形态）
pub(crate) fn scanned_jpeg_pdf(jpeg: Vec<u8>, width: i64, height: i64) -> Vec<u8> {
    let image = lopdf::Stream::new(
        dictionary! {
            "Type" => "XObject",
            "Subtype" => "Image",
            "Width" => width,
            "Height" => height,
            "ColorSpace" => "DeviceRGB",
            "BitsPerComponent" => 8,
            "Filter" => "DCTDecode",
        },
        jpeg,
    );
    pdf(&[vec!["Im0"]], &[("Im0", image)])
}

/// 一份「扫描件」PDF：每页一张 `size × size` 的灰图（填页面序号），**没有文字层**
pub(crate) fn scanned_pdf(pages: usize, size: i64) -> Vec<u8> {
    let streams: Vec<lopdf::Stream> = (0..pages)
        .map(|page| gray_stream(size, size, vec![(page as u8).wrapping_mul(37); (size * size) as usize]))
        .collect();
    let named: Vec<(String, lopdf::Stream)> = streams
        .into_iter()
        .enumerate()
        .map(|(i, stream)| (format!("Im{i}"), stream))
        .collect();
    let borrowed: Vec<(&str, lopdf::Stream)> =
        named.iter().map(|(name, stream)| (name.as_str(), stream.clone())).collect();
    let drawn: Vec<Vec<&str>> = named.iter().map(|(name, _)| vec![name.as_str()]).collect();
    pdf(&drawn, &borrowed)
}
