# 端侧 OCR 测试样本（扫描页）

`doc_parse::ocr` 的 `#[ignore]` 端到端用例用它 —— 需要**真模型**
（`src-tauri/resources/quasivision_models`，PP-OCR v5），故默认跳过：
`cargo test -p virlen-core --lib -- --ignored`。

| 文件 | 怎么来的 | 说明 |
|---|---|---|
| `page.png` | 本机 PowerShell + `System.Drawing` 生成（2026-10，见下） | 900×360 白底黑字：`VIRLEN OCR TEST` / `Invoice No. 8801` / `Total 1234.56 USD` / `未霖文档识别` |
| `page.jpg` | 同上（JPEG 质量 90） | 用来模拟「扫描件里存的就是 JPEG」 |

为什么放图片而不是自造：**文字渲染**在纯 Rust 里没有字体引擎，测试造不出「带字的图」；
这两张图是测试资产（不是产品资源），体积 30 KB。

生成脚本（记录口径，需要时重跑；改了文案要同步用例断言）：

```powershell
Add-Type -AssemblyName System.Drawing
$bmp = New-Object System.Drawing.Bitmap(900, 360)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.Clear([System.Drawing.Color]::White)
$g.DrawString("VIRLEN OCR TEST", (New-Object System.Drawing.Font("Arial", 54, 'Bold')), [System.Drawing.Brushes]::Black, 30, 30)
$g.DrawString("Invoice No. 8801", (New-Object System.Drawing.Font("Arial", 34)), [System.Drawing.Brushes]::Black, 30, 150)
$g.DrawString("Total 1234.56 USD", (New-Object System.Drawing.Font("Arial", 34)), [System.Drawing.Brushes]::Black, 30, 210)
$g.DrawString("未霖文档识别", (New-Object System.Drawing.Font("Microsoft YaHei", 34, 'Bold')), [System.Drawing.Brushes]::Black, 30, 275)
$g.Dispose()
$bmp.Save("page.png", [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Save("page.jpg", [System.Drawing.Imaging.ImageFormat]::Jpeg)
$bmp.Dispose()
```
