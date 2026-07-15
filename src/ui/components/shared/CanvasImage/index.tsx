import { useEffect, useRef } from 'react'

interface Props {
  buffer: Uint8ClampedArray<ArrayBuffer>
  width: number
  height: number
  style?: React.CSSProperties
  className?: string
  /**
   * 刷新时间
   */
  refreshTime?: number
  refresh?: boolean
}
export default function CanvasImage(props: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const refreshTime = props.refreshTime ?? 1000

  useEffect(() => {
    if (!canvasRef.current) return
    const canvas = canvasRef.current
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    if (!props.buffer) return
    if (props.width <= 0 || props.height <= 0) return
    if (props.buffer.length / props.width / props.height !== 4) return
    const imageData = new ImageData(props.buffer, props.width)
    if (!props.refresh) {
      ctx.putImageData(imageData, 0, 0)
      return
    }
    ctx.putImageData(imageData, 0, 0)
    const timer = setInterval(() => {
      ctx.putImageData(imageData, 0, 0)
    }, refreshTime)
    return () => {
      clearInterval(timer)
    }
  }, [refreshTime, props.buffer, props.refresh, props.width, props.height])
  return (
    <canvas
      ref={canvasRef}
      className={props.className}
      style={props.style}
      width={props.width}
      height={props.height}></canvas>
  )
}
