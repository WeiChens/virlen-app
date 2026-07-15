import React, { useRef, useEffect, useState, useCallback } from 'react'

interface LazyImageProps {
  src: string
  alt: string
  className?: string
  width?: number | string
  height?: number | string
  root?: Element | Document | null
  rootMargin?: string
  threshold?: number | number[]
  placeholder?: React.ReactNode
  onLoad?: (event: React.SyntheticEvent<HTMLImageElement, Event>) => void
  onError?: (event: React.SyntheticEvent<HTMLImageElement, Event>) => void
  imgProps?: React.ImgHTMLAttributes<HTMLImageElement>
  draggable?: boolean
}

const LazyImage: React.FC<LazyImageProps> = ({
  src,
  alt,
  className = '',
  width,
  height,
  root = null,
  rootMargin = '0px',
  threshold = 0,
  placeholder = null,
  onLoad,
  onError,
  draggable = false,
  imgProps = {},
}) => {
  const imgRef = useRef<HTMLDivElement>(null)
  const observerRef = useRef<IntersectionObserver | null>(null)
  const [isVisible, setIsVisible] = useState<boolean>(false)
  const [isLoaded, setIsLoaded] = useState<boolean>(false)
  const [hasError, setHasError] = useState<boolean>(false)

  // 处理图片加载成功
  const handleLoad = useCallback(
    (event: React.SyntheticEvent<HTMLImageElement, Event>) => {
      setIsLoaded(true)
      onLoad?.(event)
    },
    [onLoad]
  )

  // 处理图片加载失败
  const handleError = useCallback(
    (event: React.SyntheticEvent<HTMLImageElement, Event>) => {
      setHasError(true)
      onError?.(event)
    },
    [onError]
  )

  // IntersectionObserver 回调
  const intersectionCallback = useCallback(
    (entries: IntersectionObserverEntry[]) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          setIsVisible(true)
          // 一旦可见就断开观察，避免重复触发
          if (observerRef.current && imgRef.current) {
            observerRef.current.unobserve(imgRef.current)
          }
        }
      })
    },
    []
  )

  useEffect(() => {
    // 如果已经可见，不需要再创建观察者
    if (isVisible || !imgRef.current) return

    const options: IntersectionObserverInit = {
      root,
      rootMargin,
      threshold,
    }

    observerRef.current = new IntersectionObserver(
      intersectionCallback,
      options
    )
    observerRef.current.observe(imgRef.current)

    return () => {
      if (observerRef.current) {
        observerRef.current.disconnect()
      }
    }
  }, [root, rootMargin, threshold, intersectionCallback, isVisible])

  // 如果不可见，显示占位符或空容器
  if (!isVisible) {
    return (
      <div
        ref={imgRef}
        className={`lazy-image-placeholder ${className}`}
        style={{ width, height }}
        data-testid="lazy-image-placeholder">
        {placeholder}
      </div>
    )
  }

  // 如果可见但加载失败且提供了占位符，显示占位符
  if (hasError && placeholder) {
    return (
      <div
        className={`lazy-image-error ${className}`}
        style={{ width, height }}
        data-testid="lazy-image-error">
        {placeholder}
      </div>
    )
  }

  // 可见时渲染真实图片
  return (
    <img
      draggable={draggable}
      ref={imgRef as React.RefObject<HTMLImageElement>}
      src={src}
      alt={alt}
      className={`lazy-image ${className} ${isLoaded ? 'loaded' : 'loading'}`}
      width={width}
      height={height}
      onLoad={handleLoad}
      onError={handleError}
      {...imgProps}
      data-testid="lazy-image"
    />
  )
}

export default LazyImage
