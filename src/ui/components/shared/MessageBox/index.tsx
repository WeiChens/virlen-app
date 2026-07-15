import react, { JSX, useEffect } from 'react'
import EventEmitter from '@/utils/EventEmitter'
import Modal from '@/ui/components/shared/Modal'
import './style.scss'
type MessageBoxEvent = {
  showMessageBox: (props: MessageBoxProps) => void
}
enum MessageBoxType {
  info,
  warn,
  propt,
}
type ContentType = string | (() => JSX.Element)
interface MessageBoxProps {
  type: MessageBoxType
  title: string
  text: ContentType
  confirmText?: string
  cancelText?: string
  resolve?: (value: boolean) => void
}

const emit = new EventEmitter<MessageBoxEvent>()
let isUseMessageBox = false

export function useMessageBox() {
  const MessageBox = () => {
    const [messageBoxList, setMessageBoxList] = react.useState<
      MessageBoxProps[]
    >([])

    useEffect(() => {
      const uninstall = emit.on('showMessageBox', (props) => {
        setMessageBoxList((list) => {
          return [...list, props]
        })
      })
      if (isUseMessageBox) {
        console.error('无需使用多个Toast挂载')
      }
      isUseMessageBox = true
      return () => {
        isUseMessageBox = false
        uninstall()
      }
    }, [])
    function onConfirmHandler(index: number) {
      // console.log(messageBoxList)
      messageBoxList[index].resolve(true)
      setMessageBoxList((list) => {
        list.splice(index, 1)
        return [...list]
      })
    }
    function onCancelHandler(index: number) {
      messageBoxList[index].resolve(false)
      setMessageBoxList((list) => {
        list.splice(index, 1)
        return [...list]
      })
    }
    function onCloseHandler(index: number) {
      messageBoxList[index].resolve(null)
      setMessageBoxList((list) => {
        list.splice(index, 1)
        return [...list]
      })
    }
    useEffect(() => {
      if (messageBoxList.length == 0) {
        return
      }
      const onKeyUp = (e: KeyboardEvent) => {
        if (e.key === 'Enter') {
          onConfirmHandler(messageBoxList.length - 1)
        } else if (e.key == 'Escape') {
          onCancelHandler(messageBoxList.length - 1)
        }
      }
      window.addEventListener('keyup', onKeyUp)
      return () => {
        window.removeEventListener('keyup', onKeyUp)
      }
    }, [messageBoxList])

    return (
      <div>
        {messageBoxList.map((item, index) => {
          return (
            <Modal
              width={300}
              title={item.title}
              key={index}
              visible={index == messageBoxList.length - 1}
              onClose={() => {
                onCloseHandler(index)
              }}>
              <div className="message-box-content">
                <div className="text">
                  {item.text instanceof Function ? item.text() : item.text}
                </div>
                <div className={'bottom-view'}>
                  {item.type === MessageBoxType.propt && (
                    <ripple-button
                      className={'cancel'}
                      onClick={() => onCancelHandler(index)}>
                      {item.cancelText || '取 消'}
                    </ripple-button>
                  )}
                  <ripple-button
                    className={'confirm'}
                    onClick={() => onConfirmHandler(index)}>
                    {item.confirmText || '确 定'}
                  </ripple-button>
                </div>
              </div>
            </Modal>
          )
        })}
      </div>
    )
  }
  return { MessageBox }
}
function showMessageBox(props: MessageBoxProps) {
  if (!isUseMessageBox) {
    console.error('请先使用useMessageBox挂载')
    return
  }
  let resolve = null as ((value: boolean) => void) | null
  const promise = new Promise<boolean>((r) => (resolve = r))
  if (typeof props.text == 'object') {
    props.text = JSON.stringify(props.text)
  }
  emit.emit('showMessageBox', {
    type: props.type,
    title: props.title,
    text: props.text,
    cancelText: props.cancelText,
    confirmText: props.confirmText,
    resolve: resolve!,
  })
  return promise
}

interface PropMoreOption {
  cancelText?: string
  confirmText?: string
}
export const MessageBox = {
  info: (title: string, text: ContentType) =>
    showMessageBox({ title, text, type: MessageBoxType.info }),
  warn: (title: string, text: ContentType) =>
    showMessageBox({ title, text, type: MessageBoxType.warn }),
  propt: (title: string, text: ContentType, option: PropMoreOption = {}) => {
    return showMessageBox({
      title,
      text,
      type: MessageBoxType.propt,
      cancelText: option.cancelText,
      confirmText: option.confirmText,
    })
  },
}
