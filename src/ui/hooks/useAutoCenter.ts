import { useEffect, useRef } from "react";



/**
 * zoomIn 滚动到居中
 * @param enable 
 * @returns 
 */
export function useAutoCenter(enable: boolean=true) {
      const rootRef = useRef<HTMLDivElement>(null)
      useEffect(() => {
        const el = rootRef.current;
        if (!enable) return;
        if (!el) return;
    
        // 找到最近的滚动容器（上级 ScrollView）
        const scrollParent = getScrollParent(el);
        if (!scrollParent) return;
    
        // 计算让 el 居中需要滚动到的位置
        const elRect = el.getBoundingClientRect();
        const parentRect = scrollParent.getBoundingClientRect();
    
        // el 中心相对于滚动内容顶部的距离
        const elCenterInContent =
          elRect.top - parentRect.top + scrollParent.scrollTop + elRect.height / 2;
    
        // 目标：让 el 中心对齐容器可视区中心
        const targetScrollTop = elCenterInContent - scrollParent.clientHeight / 2;
    
        scrollParent.scrollTo({
          top: targetScrollTop,
          behavior: 'smooth', // 想要立即定位就改成 'auto'
        });
      }, [enable]);
      return rootRef
}
// 向上查找第一个可滚动的祖先元素
function getScrollParent(node:HTMLDivElement) {
  let parent = node.parentElement;
  while (parent) {
    const style = getComputedStyle(parent);
    const overflowY = style.overflowY;
    const scrollable =
      (overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay') &&
      parent.scrollHeight > parent.clientHeight;
    if (scrollable) return parent;
    parent = parent.parentElement;
  }
  // 兜底到 document 滚动容器
  return document.scrollingElement || document.documentElement;
}