import react, { useEffect, useRef } from 'react'
import EventEmitter from '@/utils/EventEmitter'
import style from './style.module.scss'
type ToastEvent = {
  showToast: (msg: string, duration: number) => void
}

const emit = new EventEmitter<ToastEvent>()
let isUseToast = false

export function useToast() {
  const Toast = () => {
    const [show, setShow] = react.useState(false)
    const [msg, setMsg] = react.useState('')
    const timer = useRef<number | null>(null)
    useEffect(() => {
      const uninstall = emit.on('showToast', (msg, duration) => {
        setMsg(msg)
        setShow(true)
        if (timer.current) {
          clearTimeout(timer.current)
        }
        // @ts-ignore
        timer.current = setTimeout(() => {
          setShow(false)
          // setMsg('')
          timer.current = null
        }, duration)
      })
      if (isUseToast) {
        console.error('无需使用多个Toast挂载')
      }
      isUseToast = true
      return () => {
        isUseToast = false
        uninstall()
      }
    }, [])

    const viewCalssName = [style['toast-view']]
    if (!show) {
      viewCalssName.push(style['toast-view-hide'])
    }
    return (
      <div>
        <div style={{ zIndex: '1999' }} className={viewCalssName.join(' ')}>
          <div className={` ${style['box']}`}>{msg}</div>
        </div>
      </div>
    )
  }
  return {
    Toast,
    showToast: (msg: string, duration: number) => {
      emit.emit('showToast', msg, duration)
    },
  }
}

export function showToast(msg: string, duration: number = 2500) {
  if (!isUseToast) {
    console.error('请先使用useToast挂载')
    return
  }
  emit.emit('showToast', msg, duration)
}
