import { useRef, useState, useCallback } from 'react'
import './style.scss'

interface SliderProps {
  value?: number
  min?: number
  max?: number
  color?: string
  onChange?: (value: number) => void
  textRender?: (v: number) => string
  style?: React.CSSProperties
  className?: string
}

export default function Slider({
  value = 50,
  min = 0,
  max = 100,
  color = 'var(--primary-color)',
  onChange,
  style,
  textRender,
  className,
}: SliderProps) {
  const trackRef = useRef<HTMLDivElement>(null)
  const [internalValue, setInternalValue] = useState(value)

  const currentValue = onChange ? value : internalValue
  const percentage = ((currentValue - min) / (max - min)) * 100

  const updateValue = useCallback(
    (clientX: number) => {
      if (!trackRef.current) return
      const rect = trackRef.current.getBoundingClientRect()
      const offsetX = clientX - rect.left
      const newPercentage = Math.max(0, Math.min(1, offsetX / rect.width))
      const newValue = min + newPercentage * (max - min)

      if (onChange) {
        onChange(newValue)
      } else {
        setInternalValue(newValue)
      }
    },
    [min, max, onChange],
  )

  const handleMouseDown = (e: React.MouseEvent) => {
    updateValue(e.clientX)
    function handleMouseMove(e: MouseEvent) {
      updateValue(e.clientX)
    }
    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener(
      'mouseup',
      () => {
        document.removeEventListener('mousemove', handleMouseMove)
      },
      { once: true },
    )
  }

  const handleTouchStart = (e: React.TouchEvent) => {
    updateValue(e.touches[0].clientX)
    function handleTouchMove(e: TouchEvent) {
      updateValue(e.touches[0].clientX)
    }
    document.addEventListener('touchmove', handleTouchMove)
    document.addEventListener(
      'touchend',
      () => {
        document.removeEventListener('touchmove', handleTouchMove)
      },
      { once: true },
    )
  }
  if (!style) style = {}
  return (
    <div
      tabIndex={-1}
      className={`slider-component${className ? ` ${className}` : ''}`}
      ref={trackRef}
      onMouseDown={handleMouseDown}
      onTouchStart={handleTouchStart}
      style={{ '--slider-color': color, ...style } as React.CSSProperties}>
      <div
        className="slider-fill"
        style={{ width: `${percentage}%`, backgroundColor: color }}
      />
      <div className="slider-text">
        {textRender ? textRender(currentValue) : Math.round(currentValue) + '%'}
      </div>
    </div>
  )
}
