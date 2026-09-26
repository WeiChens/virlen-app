/**
 * skill — 技能分类（分类 id: skill）
 *
 * 一个工具一个文件，import 即完成注册（toolRegistry.register 副作用）。
 * 公共函数见 ./common.ts；分类定义见 src/domain/tools/category.ts。
 *
 * 本分类只提供只读能力（查看技能列表 / 技能源码）。
 */
import './list-skills'
import './read-skill-source'
