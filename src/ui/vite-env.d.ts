/// <reference types="vite/client" />
declare namespace React {
  namespace JSX {
    interface IntrinsicElements {
      'ripple-button': React.DetailedHTMLProps<
        React.HTMLAttributes<HTMLElement>,
        HTMLButtonElement
      > & {
        /**
         * 涟漪颜色
         */
        'ripple-color'?: string
      }
    }
  }
}
