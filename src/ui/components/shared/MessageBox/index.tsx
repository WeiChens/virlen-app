import react, { JSX, useEffect } from 'react'
import EventEmitter from '@/utils/EventEmitter'
import Modal from '@/ui/components/shared/Modal'
import { t } from '@/ui/i18n'
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
  /** 破坏性操作：确认按钮染成实心危险色（与普通「确定」区分） */
  danger?: boolean
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
      const onKeyDown = (e: KeyboardEvent) => {
        if (e.key !== 'Enter') return
        // 守卫：焦点在输入控件里时回车属于「输入」，不能当成「确认」
        const el = e.target as HTMLElement | null
        if (
          el &&
          (el.tagName === 'INPUT' ||
            el.tagName === 'TEXTAREA' ||
            el.isContentEditable)
        )
          return
        onConfirmHandler(messageBoxList.length - 1)
      }
      // Escape 交给 Modal 自己处理（两者都监听会导致一次 Esc 被处理两遍）
      window.addEventListener('keydown', onKeyDown)
      return () => {
        window.removeEventListener('keydown', onKeyDown)
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
                  {/* info 是纯提示（只给「确定」）；warn / propt 都是「确认类」操作，
                      必须给出可见的取消入口，否则不可逆操作只能靠 Esc 逃逸 */}
                  {item.type !== MessageBoxType.info && (
                    <ripple-button
                      className={'cancel'}
                      onClick={() => onCancelHandler(index)}>
                      {item.cancelText || t('取 消')}
                    </ripple-button>
                  )}
                  <ripple-button
                    className={`confirm${item.danger ? ' danger' : ''}`}
                    onClick={() => onConfirmHandler(index)}>
                    {item.confirmText || t('确 定')}
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
    danger: props.danger,
    resolve: resolve!,
  })
  return promise
}

interface PropMoreOption {
  cancelText?: string
  confirmText?: string
  /** 破坏性操作传 true，确认按钮会变成实心红色 */
  danger?: boolean
}
export const MessageBox = {
  info: (title: string, text: ContentType) =>
    showMessageBox({ title, text, type: MessageBoxType.info }),
  // warn 本身即「警告」，默认按破坏性渲染
  warn: (title: string, text: ContentType) =>
    showMessageBox({ title, text, type: MessageBoxType.warn, danger: true }),
  propt: (title: string, text: ContentType, option: PropMoreOption = {}) => {
    return showMessageBox({
      title,
      text,
      type: MessageBoxType.propt,
      cancelText: option.cancelText,
      confirmText: option.confirmText,
      danger: option.danger,
    })
  },
}
