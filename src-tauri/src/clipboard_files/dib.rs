/*!
 * clipboard_files::dib — 图片字节 → Windows DIB（CF_DIB）
 *
 * 为什么需要它：把图片放进系统剪贴板，Windows 上标准做法是写 CF_DIB
 * （BITMAPINFOHEADER + 像素阵列）。WebView 里的 `navigator.clipboard.write`
 * 是否放行取决于运行时权限，不可靠；原生这条路是确定的。
 *
 * 与平台无关（纯字节组装），所以单独成文件、可跨平台单测；
 * 真正写剪贴板的系统调用在 windows.rs，非 Windows 构建下本模块无使用者。
 *
 * 格式约定（兼容性最好的那一档）：
 *   - 32 位 BI_RGB（不带位掩码），像素 BGRA —— 资源管理器 / Office / 微信等都能读；
 *   - biHeight 为正 → **自下而上**存储（Windows DIB 的历史约定）；
 *   - 不做行对齐填充：32 位像素天然 4 字节对齐，不需要补 padding。
 */

/// BITMAPINFOHEADER 固定 40 字节（不含调色板；32 位 BI_RGB 不需要调色板）
const BITMAPINFOHEADER_SIZE: u32 = 40;
/// 每像素 4 字节（BGRA）
const BYTES_PER_PIXEL: u32 = 4;

/**
 * 把任意可解码的图片字节（PNG/JPEG/GIF/BMP/WEBP…）转成 CF_DIB 数据。
 *
 * @param bytes 原始图片字节（前端给的是 base64 解码后的结果）
 */
pub fn image_to_dib(bytes: &[u8]) -> Result<Vec<u8>, String> {
    let image = image::load_from_memory(bytes)
        .map_err(|e| format!("图片解码失败（支持 PNG/JPEG/GIF/BMP/WEBP 等）：{e}"))?;
    let rgba = image.to_rgba8();
    let (width, height) = rgba.dimensions();
    Ok(rgba_to_dib(width, height, &rgba.into_raw()))
}

/**
 * RGBA8（自上而下，行间无 padding）→ 32 位 DIB。
 *
 * 拆成独立函数是为了可单测：头部字段与「自下而上 + BGRA」的顺序
 * 一旦写错，剪贴板里会得到上下颠倒或红蓝互换的图，而这类错误
 * 只能靠人眼看出来，必须由单测兜住。
 */
pub fn rgba_to_dib(width: u32, height: u32, rgba: &[u8]) -> Vec<u8> {
    let mut dib = Vec::with_capacity(
        BITMAPINFOHEADER_SIZE as usize + (width as usize) * (height as usize) * 4,
    );

    // ---------- BITMAPINFOHEADER ----------
    dib.extend_from_slice(&BITMAPINFOHEADER_SIZE.to_le_bytes()); // biSize
    dib.extend_from_slice(&(width as i32).to_le_bytes()); // biWidth
    dib.extend_from_slice(&(height as i32).to_le_bytes()); // biHeight（正数 = 自下而上）
    dib.extend_from_slice(&1u16.to_le_bytes()); // biPlanes
    dib.extend_from_slice(&32u16.to_le_bytes()); // biBitCount
    dib.extend_from_slice(&0u32.to_le_bytes()); // biCompression = BI_RGB
    dib.extend_from_slice(&(width * height * BYTES_PER_PIXEL).to_le_bytes()); // biSizeImage
    dib.extend_from_slice(&0i32.to_le_bytes()); // biXPelsPerMeter
    dib.extend_from_slice(&0i32.to_le_bytes()); // biYPelsPerMeter
    dib.extend_from_slice(&0u32.to_le_bytes()); // biClrUsed
    dib.extend_from_slice(&0u32.to_le_bytes()); // biClrImportant

    // 防御：源数据不足时只返回头部（宁可复制出一张空图，也不要越界读）
    let expected = (width as usize) * (height as usize) * 4;
    if width == 0 || height == 0 || rgba.len() < expected {
        return dib;
    }

    // ---------- 像素：自下而上 + BGRA ----------
    for y in (0..height).rev() {
        for x in 0..width {
            let i = ((y * width + x) * 4) as usize;
            dib.push(rgba[i + 2]); // B
            dib.push(rgba[i + 1]); // G
            dib.push(rgba[i]); // R
            dib.push(rgba[i + 3]); // A
        }
    }

    dib
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 2×2 图：左上红、右上绿、左下蓝、右下白（RGBA）
    fn sample() -> Vec<u8> {
        vec![
            255, 0, 0, 255, // (0,0) 红
            0, 255, 0, 255, // (1,0) 绿
            0, 0, 255, 255, // (0,1) 蓝
            255, 255, 255, 255, // (1,1) 白
        ]
    }

    fn u32_at(dib: &[u8], offset: usize) -> u32 {
        u32::from_le_bytes(dib[offset..offset + 4].try_into().unwrap())
    }

    #[test]
    fn header_is_32bit_bi_rgb() {
        let dib = rgba_to_dib(2, 2, &sample());
        assert_eq!(dib.len(), 40 + 2 * 2 * 4);
        assert_eq!(u32_at(&dib, 0), 40); // biSize
        assert_eq!(u32_at(&dib, 4), 2); // biWidth
        assert_eq!(u32_at(&dib, 8), 2); // biHeight：正数 = 自下而上
        assert_eq!(u16::from_le_bytes(dib[12..14].try_into().unwrap()), 1); // biPlanes
        assert_eq!(u16::from_le_bytes(dib[14..16].try_into().unwrap()), 32); // biBitCount
        assert_eq!(u32_at(&dib, 16), 0); // biCompression = BI_RGB
        assert_eq!(u32_at(&dib, 20), 16); // biSizeImage = 2×2×4
    }

    #[test]
    fn pixels_are_bottom_up_bgra() {
        let dib = rgba_to_dib(2, 2, &sample());
        let px = &dib[40..];
        // 第一行像素必须是「最下面那一行」（蓝、白）
        assert_eq!(&px[0..4], &[255, 0, 0, 255]); // 蓝 → BGRA
        assert_eq!(&px[4..8], &[255, 255, 255, 255]); // 白
        // 第二行是原图第一行（红、绿）
        assert_eq!(&px[8..12], &[0, 0, 255, 255]); // 红 → BGRA
        assert_eq!(&px[12..16], &[0, 255, 0, 255]); // 绿 → BGRA
    }

    #[test]
    fn short_input_returns_header_only() {
        let dib = rgba_to_dib(2, 2, &[0u8; 4]);
        assert_eq!(dib.len(), 40);
    }

    #[test]
    fn decodes_png_bytes_into_dib() {
        // 1×1 红色 PNG（最小合法样本），验证「解码 → DIB」整条链路
        let png: Vec<u8> = vec![
            0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49,
            0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02,
            0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xDE, 0x00, 0x00, 0x00, 0x0C, 0x49, 0x44,
            0x41, 0x54, 0x08, 0xD7, 0x63, 0xF8, 0xCF, 0xC0, 0x00, 0x00, 0x03, 0x01, 0x01,
            0x00, 0x18, 0xDD, 0x8D, 0xB0, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44,
            0xAE, 0x42, 0x60, 0x82,
        ];
        let dib = image_to_dib(&png).expect("PNG 应能解码");
        assert_eq!(dib.len(), 40 + 4);
        assert_eq!(u32_at(&dib, 4), 1); // 宽
        assert_eq!(u32_at(&dib, 8), 1); // 高
    }

    #[test]
    fn non_image_bytes_return_error_without_panic() {
        assert!(image_to_dib(b"not an image").is_err());
    }
}
