import type { SelectHTMLAttributes } from 'react'
import { NativeSelect } from './native-select'

type Props<V extends string> = Omit<SelectHTMLAttributes<HTMLSelectElement>, 'value' | 'onChange' | 'children'> & {
  value: V
  options: ReadonlyArray<{ readonly value: V; readonly label: string }>
  onChange: (value: V) => void
  wrapperClassName?: string
}

/** A native select of fixed choices. It hands back the chosen option's value with its type, so callers need no cast. */
export function ChoiceSelect<V extends string>({ value, options, onChange, ...rest }: Props<V>) {
  return (
    <NativeSelect
      {...rest}
      value={value}
      onChange={(event) => {
        const choice = options.find((option) => option.value === event.target.value)
        if (choice) onChange(choice.value)
      }}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </NativeSelect>
  )
}
