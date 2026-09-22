/**
 * 知识库设置页用的轻量 toast
 *
 * 简单实现，避免引入 toast 组件的复杂依赖。
 */

export function showToastMsg(
  msg: string,
  type: 'success' | 'error' | 'info' = 'info',
) {
  const el = document.createElement('div')
  el.style.cssText = `
    position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%);
    padding: 10px 20px; border-radius: 8px; font-size: 14px;
    z-index: 9999; color: white; max-width: 80vw; text-align: center;
    background: ${type === 'success' ? '#2e7d32' : type === 'error' ? '#c62828' : '#1565c0'};
    box-shadow: 0 4px 12px rgba(0,0,0,0.15);
    animation: fadeIn 0.2s ease;
  `
  el.textContent = msg
  document.body.appendChild(el)
  setTimeout(() => {
    el.style.opacity = '0'
    el.style.transition = 'opacity 0.3s'
    setTimeout(() => el.remove(), 300)
  }, 3000)
}
