import React, {
  useState,
  useEffect,
  useRef,
  HTMLAttributeReferrerPolicy,
} from 'react'
import ReactDOM from 'react-dom'
import './style.scss'
import EventEmitter from '@/utils/EventEmitter'
export interface ImagePreviewProps {
  src: string
  previewSrcList?: string[]
  referrerPolicy?: HTMLAttributeReferrerPolicy
}

type ImagePreviewEventParams = {
  show: (params: ImagePreviewProps, consumption: { value: boolean }) => void
}
const imagePreviewEvent = new EventEmitter<ImagePreviewEventParams>()
function ImagePreview() {
  const [showPreview, setShowPreview] = useState(false)
  const [src, setSrc] = useState(null)
  const [previewSrcList, setPreviewSrcList] = useState([])
  const [referrerPolicy, setReferrerPolicy] =
    useState<ReferrerPolicy>('no-referrer')

  const [currentIndex, setCurrentIndex] = useState(0)
  const [scale, setScale] = useState(1)
  const [rotate, setRotate] = useState(0)
  const [position, setPosition] = useState({ x: 0, y: 0 })
  const [isDragging, setIsDragging] = useState(false)
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 })
  const imageRef = useRef<HTMLImageElement>(null)

  // 图片列表（如果没有提供previewSrcList，则使用src）
  const imageList = previewSrcList.length > 0 ? previewSrcList : [src]

  // 关闭预览
  const handleClose = () => {
    setShowPreview(false)
  }

  // 上一张
  const handlePrev = (e?: any) => {
    e?.stopPropagation()
    setCurrentIndex((prev) => (prev > 0 ? prev - 1 : imageList.length - 1))
    setScale(1)
    setRotate(0)
    setPosition({ x: 0, y: 0 })
  }

  // 下一张
  const handleNext = (e?: any) => {
    e?.stopPropagation()
    setCurrentIndex((prev) => (prev < imageList.length - 1 ? prev + 1 : 0))
    setScale(1)
    setRotate(0)
    setPosition({ x: 0, y: 0 })
  }

  // 放大
  const handleZoomIn = () => {
    setScale((prev) => Math.min(prev + 0.2, 5))
  }

  // 缩小
  const handleZoomOut = () => {
    setScale((prev) => Math.max(prev - 0.2, 0.2))
  }

  // 旋转
  const handleRotate = () => {
    setRotate((prev) => (prev + 90) % 360)
  }

  // 重置
  const handleReset = () => {
    setScale(1)
    setRotate(0)
    setPosition({ x: 0, y: 0 })
  }

  // 鼠标按下开始拖动
  const handleMouseDown = (e: React.MouseEvent<HTMLImageElement>) => {
    e.preventDefault()
    setIsDragging(true)
    setDragStart({
      x: e.clientX - position.x,
      y: e.clientY - position.y,
    })
  }

  // 鼠标移动
  const handleMouseMove = (e: MouseEvent) => {
    if (!isDragging) return

    setPosition({
      x: e.clientX - dragStart.x,
      y: e.clientY - dragStart.y,
    })
  }

  // 鼠标释放
  const handleMouseUp = () => {
    setIsDragging(false)
  }

  // ESC键关闭
  useEffect(() => {
    if (!showPreview) return

    const handleKeyDown = (e: KeyboardEvent) => {
      switch (e.key) {
        case 'Escape':
          handleClose()
          break
        case 'ArrowLeft':
          handlePrev()
          break
        case 'ArrowRight':
          handleNext()
          break
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [showPreview])

  // 阻止body滚动
  useEffect(() => {
    if (showPreview) {
      document.body.style.overflow = 'hidden'
    } else {
      document.body.style.overflow = ''
    }
    return () => {
      document.body.style.overflow = ''
    }
  }, [showPreview])

  // 鼠标滚轮缩放
  useEffect(() => {
    if (!showPreview) return

    const handleWheel = (e: WheelEvent) => {
      e.preventDefault()
      e.stopPropagation()

      // deltaY > 0 表示向下滚动（缩小），< 0 表示向上滚动（放大）
      if (e.deltaY < 0) {
        // 放大
        setScale((prev) => Math.min(prev + 0.1, 5))
      } else {
        // 缩小
        setScale((prev) => Math.max(prev - 0.1, 0.2))
      }
    }

    // 添加事件监听，使用 passive: false 以便可以 preventDefault
    document.addEventListener('wheel', handleWheel, {
      passive: false,
      capture: true,
    })
    return () => {
      document.removeEventListener('wheel', handleWheel, {
        capture: true,
      })
    }
  }, [showPreview])

  // 鼠标拖动事件监听
  useEffect(() => {
    if (!showPreview) return

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)

    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [showPreview, isDragging, dragStart, position])

  // const [_, setLoadingError] = useState(false)
  // useEffect(() => {
  //   setLoadingError(false)
  // }, [src])

  useEffect(() => {
    const uninstall = imagePreviewEvent.on('show', (e, consumption) => {
      if (consumption.value) return
      setPreviewSrcList(e.previewSrcList)
      setReferrerPolicy(e.referrerPolicy)
      setSrc(e.src)
      // 根据点击的图片定位到对应索引
      const idx = e.previewSrcList?.indexOf(e.src) ?? 0
      setCurrentIndex(idx >= 0 ? idx : 0)
      setShowPreview(true)
      consumption.value = true
    })
    return () => {
      uninstall()
    }
  }, [])
  return (
    <>
      {/* 预览层 */}
      {showPreview && (
        <ImagePreviewOverlay
          alt=""
          imageList={imageList}
          currentIndex={currentIndex}
          handleZoomOut={handleZoomOut}
          handleZoomIn={handleZoomIn}
          handleRotate={handleRotate}
          handleReset={handleReset}
          scale={scale}
          imageRef={imageRef}
          isDragging={isDragging}
          position={position}
          rotate={rotate}
          handleMouseDown={handleMouseDown}
          handlePrev={handlePrev}
          handleNext={handleNext}
          handleClose={handleClose}
          referrerPolicy={referrerPolicy}
        />
      )}
    </>
  )
}

interface ImagePreviewOverlayProps {
  handleClose: () => void
  imageList: string[]
  currentIndex: number
  alt: string
  handleZoomOut: () => void
  handleZoomIn: () => void
  handleRotate: () => void
  handleReset: () => void
  scale: number
  imageRef: React.RefObject<HTMLImageElement>
  isDragging: boolean
  position: { x: number; y: number }
  rotate: number
  handleMouseDown: (e: React.MouseEvent<HTMLImageElement>) => void
  handlePrev: () => void
  handleNext: () => void
  referrerPolicy?: HTMLAttributeReferrerPolicy
}
function ImagePreviewOverlay(props: ImagePreviewOverlayProps) {
  const {
    handleClose,
    imageList,
    currentIndex,
    alt,
    handleZoomOut,
    handleZoomIn,
    handleRotate,
    handleReset,
    scale,
    imageRef,
    isDragging,
    position,
    rotate,
    handleMouseDown,
    handlePrev,
    handleNext,
    referrerPolicy,
  } = props
  return ReactDOM.createPortal(
    <div className="image-preview-overlay" onClick={handleClose}>
      {/* 工具栏 */}
      <div
        className="image-preview-toolbar"
        onClick={(e) => e.stopPropagation()}>
        <button className="toolbar-btn" onClick={handleZoomOut} title="缩小">
          <svg viewBox="0 0 1024 1024" width="20" height="20">
            <path
              d="M658.432 428.736a33.216 33.216 0 0 1-33.152 33.152H392.128a33.152 33.152 0 0 1 0-66.304H625.28c18.24 0 33.152 14.848 33.152 33.152z m299.776 521.792a43.328 43.328 0 0 1-60.864-6.912l-189.248-220.992a362.368 362.368 0 0 1-207.36 65.472C218.56 788.096 66.56 636.096 66.56 451.968S218.56 115.904 500.736 115.904s434.176 152 434.176 336.064a331.072 331.072 0 0 1-74.24 209.344l192.32 224.64a43.392 43.392 0 0 1-6.784 60.864z m-457.216-288.64c226.304 0 349.568-139.392 349.568-270.016 0-130.56-123.264-269.952-349.568-269.952S151.04 261.312 151.04 391.936c0 130.624 123.264 270.016 349.952 270.016z"
              fill="currentColor"></path>
          </svg>
        </button>
        <button className="toolbar-btn" onClick={handleZoomIn} title="放大">
          <svg viewBox="0 0 1024 1024" width="20" height="20">
            <path
              d="M658.432 428.736a33.216 33.216 0 0 1-33.152 33.152h-100.032v100.032a33.152 33.152 0 0 1-66.304 0V461.888H358.912a33.152 33.152 0 0 1 0-66.304h100.032V295.552a33.152 33.152 0 0 1 66.304 0v100.032H625.28c18.24 0 33.152 14.848 33.152 33.152z m299.776 521.792a43.328 43.328 0 0 1-60.864-6.912l-189.248-220.992a362.368 362.368 0 0 1-207.36 65.472C218.56 788.096 66.56 636.096 66.56 451.968S218.56 115.904 500.736 115.904s434.176 152 434.176 336.064a331.072 331.072 0 0 1-74.24 209.344l192.32 224.64a43.392 43.392 0 0 1-6.784 60.864z m-457.216-288.64c226.304 0 349.568-139.392 349.568-270.016 0-130.56-123.264-269.952-349.568-269.952S151.04 261.312 151.04 391.936c0 130.624 123.264 270.016 349.952 270.016z"
              fill="currentColor"></path>
          </svg>
        </button>
        <button className="toolbar-btn" onClick={handleRotate} title="旋转">
          <svg viewBox="0 0 1024 1024" width="20" height="20">
            <path
              d="M784.512 230.272v-50.56a32 32 0 1 1 64 0v116.928c0 17.664-14.336 32-32 32H699.584a32 32 0 1 1 0-64h50.56A267.968 267.968 0 0 0 512 192C323.904 192 172 343.936 172 532.032a267.968 267.968 0 0 0 134.208 232.256 32 32 0 1 1-31.616 55.616A331.968 331.968 0 0 1 108 532.032C108 307.648 287.616 128 512 128c196.288 0 361.6 138.688 403.84 323.712z"
              fill="currentColor"></path>
            <path
              d="M815.616 548.864A32 32 0 0 1 784 580.48a267.968 267.968 0 0 1-134.208 232.256A268.032 268.032 0 0 1 512 876.032c-147.904 0-268.032-120.128-268.032-268.032a32 32 0 1 1 64 0c0 112.64 91.424 204.032 204.032 204.032s204.032-91.392 204.032-204.032a32 32 0 0 1 31.584-31.616z"
              fill="currentColor"></path>
          </svg>
        </button>
        <button className="toolbar-btn" onClick={handleReset} title="重置">
          <svg viewBox="0 0 1024 1024" width="20" height="20">
            <path
              d="M512 128c35.328 0 64 28.672 64 64v192c0 35.328-28.672 64-64 64H320c-35.328 0-64-28.672-64-64s28.672-64 64-64h128V192c0-35.328 28.672-64 64-64z m0 768c-35.328 0-64-28.672-64-64v-192c0-35.328 28.672-64 64-64h192c35.328 0 64 28.672 64 64s-28.672 64-64 64H576v128c0 35.328-28.672 64-64 64z"
              fill="currentColor"></path>
          </svg>
        </button>
        <span className="toolbar-scale">{Math.round(scale * 100)}%</span>
        <button
          className="toolbar-btn close-btn"
          onClick={handleClose}
          title="关闭">
          <svg viewBox="0 0 1024 1024" width="20" height="20">
            <path
              d="M557.312 513.248l265.28-263.904c12.544-12.48 12.608-32.704 0.128-45.248-12.512-12.576-32.704-12.608-45.248-0.128L512 467.904 246.72 203.968c-12.544-12.48-32.704-12.448-45.248 0.128-12.48 12.544-12.416 32.768 0.128 45.248l265.216 263.904L201.6 776.8c-12.544 12.48-12.608 32.704-0.128 45.248 6.24 6.272 14.464 9.44 22.688 9.44 8.16 0 16.32-3.104 22.56-9.312l265.216-263.808 265.28 263.808c6.24 6.208 14.432 9.312 22.592 9.312 8.224 0 16.448-3.168 22.688-9.44 12.48-12.544 12.416-32.768-0.128-45.248L557.312 513.248z"
              fill="currentColor"></path>
          </svg>
        </button>
      </div>

      {/* 图片容器 */}
      <div
        className="image-preview-container"
        onClick={(e) => e.stopPropagation()}>
        <img
          ref={imageRef}
          src={imageList[currentIndex]}
          alt={alt}
          referrerPolicy={referrerPolicy}
          className={`preview-image ${isDragging ? 'dragging' : ''}`}
          style={{
            transform: `translate(${position.x}px, ${position.y}px) scale(${scale}) rotate(${rotate}deg)`,
            cursor: isDragging ? 'grabbing' : 'grab',
          }}
          onMouseDown={handleMouseDown}
        />
      </div>

      {/* 左右切换按钮 */}
      {imageList.length > 1 && (
        <>
          <button className="preview-arrow prev" onClick={handlePrev}>
            <svg viewBox="0 0 1024 1024" width="24" height="24">
              <path
                d="M671.968 912c-12.288 0-24.576-4.672-33.952-14.048L286.048 545.984c-18.752-18.72-18.752-49.12 0-67.872l351.968-352c18.752-18.752 49.12-18.752 67.872 0 18.752 18.72 18.752 49.12 0 67.872L387.872 512l318.016 318.016c18.752 18.72 18.752 49.12 0 67.872C696.544 907.328 684.256 912 671.968 912z"
                fill="currentColor"></path>
            </svg>
          </button>
          <button className="preview-arrow next" onClick={handleNext}>
            <svg viewBox="0 0 1024 1024" width="24" height="24">
              <path
                d="M352.032 912c12.288 0 24.576-4.672 33.952-14.048l351.968-352c18.752-18.72 18.752-49.12 0-67.872l-351.968-352c-18.752-18.752-49.12-18.752-67.872 0-18.752 18.72-18.752 49.12 0 67.872L636.128 512 318.112 830.016c-18.752 18.72-18.752 49.12 0 67.872C327.456 907.328 339.744 912 352.032 912z"
                fill="currentColor"></path>
            </svg>
          </button>
        </>
      )}

      {/* 图片索引 */}
      {imageList.length > 1 && (
        <div className="image-preview-index">
          {currentIndex + 1} / {imageList.length}
        </div>
      )}
    </div>,
    document.body,
  )
}

export default ImagePreview

export function showImagePreview(params: ImagePreviewProps) {
  if (params.previewSrcList == undefined) {
    params.previewSrcList = []
  }
  imagePreviewEvent.emit('show', params, {
    value: false,
  })
}
