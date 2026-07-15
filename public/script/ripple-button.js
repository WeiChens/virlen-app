/**
 * 波纹按钮组件(模仿android按钮)
 * example: <ripple-button>按钮</ripple-button>
 */
(function () {
    customElements.define('ripple-button', class extends HTMLElement {
        constructor() {
            super()
            this.addEventListener('mousedown', async function (e) {
                const rect = e.currentTarget.getBoundingClientRect()
                const x = e.clientX - rect.left
                const y = e.clientY - rect.top
                const ripple = document.createElement('div')
                const rippleColor = this.getAttribute('ripple-color') || 'rgba(116, 115, 115, 0.328)'
                ripple.classList.add('ripple')
                ripple.style.left = `${x}px`
                ripple.style.top = `${y}px`
                ripple.style.backgroundColor = rippleColor
                this.appendChild(ripple)
                let isEnd = false
                let isAnimEnd = false
                let isRemove = false
                const removeEff = async () => {
                    if (isRemove) return
                    await ripple.animate([
                        { transform: 'translate(-50%,-50%) scale(14)', opacity: 1 },
                        { transform: 'translate(-50%,-50%) scale(14)', opacity: 0 }
                    ], { duration: 200 }).finished
                    ripple.remove()
                    isRemove = true
                }
                window.addEventListener('mouseup', function () {
                    isEnd = true
                    isAnimEnd && removeEff()
                }, { once: true })
                await ripple.animate([
                    { transform: 'translate(-50%,-50%) scale(1)' },
                    { transform: 'translate(-50%,-50%) scale(14)' }
                ], {
                    duration: 300,
                    easing: 'ease-out',
                    fill: 'forwards'
                }).finished
                isAnimEnd = true
                isEnd && removeEff()
            })
            this.observer = new MutationObserver(this.attributeChangedCallback.bind(this))
        }
        attributeChangedCallback () {
            const defaultClass = 'def_ripple-button'
            const currentClass = this.classList
            if (!currentClass.contains(defaultClass)) {
                this.setAttribute('class', defaultClass + ' ' + [...currentClass].join(' '))
            }
        }
        connectedCallback () {
            this.observer.observe(this, {
                attributes: true,
                attributeFilter: ['class']
            })
            this.attributeChangedCallback()
        }
        disconnectedCallback () {
            this.observer.disconnect()
        }
    })
    const style = document.createElement('style')
    style.innerHTML = `
        .def_ripple-button {
            margin: 5px;
            height: 35px;
            padding: 0 30px;
            align-content: center;
            white-space: nowrap;
            background-color: #f3f3f3;
            text-align: center;
            user-select: none;
            cursor: pointer;
            position: relative;
            overflow: hidden;
            border-radius: 7px;
            box-shadow: 1px 2px 2px rgba(0, 0, 0, 0.2);
            transition: .2s;
            border: none;
            display: block;
        }

        .def_ripple-button:active {
            transform: scale(.98);
            box-shadow: 1px 2px 6px rgba(0, 0, 0, 0.2);
        }
        .def_ripple-button:hover {
            filter: brightness(1.1);
        }

        .def_ripple-button .ripple {
            position: absolute;
            border-radius: 50%;
            background-color: rgba(116, 115, 115, 0.328);
            transform-origin: center center;
            width: 20%;
            aspect-ratio: 1;
        }

        .def_ripple-button span {
            position: relative;
            z-index: 2;
        }
        `
    document.head.prepend(style)
})()