/**
 * service — 后台服务分类（id: service）；一个文件一个工具，import 即注册（见 domain/tools/category.ts）。
 *
 * ⚠️ 四个工具都只有 Rust 原生实现（前端只登记执行器，见 ./common.ts）。
 */
import './start-background-service'
import './get-background-service'
import './kill-background-service'
import './list-background-services'
