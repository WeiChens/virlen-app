import './style.scss'
interface RadioGroupProps {
  options: {
    label: string
    value: any
  }[]
  value: any
  onChange: (value: any) => void
  style?: React.CSSProperties
}

const RadioGroup = (props: RadioGroupProps) => {
  return (
    <div className="RadioGroup" style={props.style}>
      {props.options.map((item) => (
        <div
          onClick={() => props.onChange(item.value)}
          key={item.value}
          className={`RadioGroup__item${
            props.value === item.value ? ' active' : ''
          }`}>
          {item.label}
        </div>
      ))}
    </div>
  )
}

export default RadioGroup
