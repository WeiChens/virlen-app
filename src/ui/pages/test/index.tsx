import { vision } from '@/infrastructure/vision'
import * as dialog from '@tauri-apps/plugin-dialog'
export const TestPage = () => {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 16 }}>
      <button
        onClick={async () => {
          const path = await dialog.open({
            title: '选择图片',
            filters: [
              {
                name: '图片',
                extensions: ['png', 'jpg', 'jpeg', 'bmp', 'gif', 'webp'],
              },
            ],
          })
          if (!path) return
          try {
            const result = await vision.analyze(path)
            console.log('=== Combined Vision Analysis ===')
            console.log(result.combined_text)
            console.log('')
            console.log('--- UI Tree ---')
            console.log(result.ui_tree_text)
            console.log('')
            console.log('--- Objects ---')
            console.log(result.objects_tree_text)
          } catch (err) {
            console.error('视觉分析失败:', err)
          }
        }}>
        🎯 全能视觉分析（UI + OCR + 物体检测）
      </button>
    </div>
  )
}
