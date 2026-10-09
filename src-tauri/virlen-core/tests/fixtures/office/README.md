# 文档解析测试样本（Office）

`parse_document` / `doc_parse::office` 的单测样本 —— 这些格式**无法在测试里自造**
（旧二进制 `.doc`/`.xls` 没有写入能力），故直接放真实文件。

来源与许可：

| 文件 | 出处 | 许可 |
|---|---|---|
| `simple.doc` | [Apache POI](https://github.com/apache/poi) `test-data/document/simple.doc` | Apache-2.0 |
| `SampleDoc.docx` | Apache POI `test-data/document/SampleDoc.docx` | Apache-2.0 |
| `SampleSS.xlsx` | Apache POI `test-data/spreadsheet/SampleSS.xlsx` | Apache-2.0 |
| `Simple.xls` | Apache POI `test-data/spreadsheet/Simple.xls` | Apache-2.0 |

用途：验证「格式分派 + 文本抽取 + 按工作表提取」这几条**真实文件**路径。
`xlsx` / `docx` 另有生成式用例（`office_oxide` 自身可写 OOXML），不依赖这里的样本。
