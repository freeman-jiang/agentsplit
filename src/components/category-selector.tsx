import { NativeSelect } from '@/components/ui/native-select'
import { Category } from '@/generated/prisma/browser'
import { useTranslations } from 'next-intl'
import { forwardRef, SelectHTMLAttributes } from 'react'

type Props = Pick<
  SelectHTMLAttributes<HTMLSelectElement>,
  'id' | 'aria-describedby' | 'aria-invalid'
> & {
  categories: Category[]
  onValueChange: (categoryId: Category['id']) => void
  defaultValue: Category['id']
  isLoading: boolean
}

export const CategorySelector = forwardRef<HTMLSelectElement, Props>(
  ({ categories, onValueChange, defaultValue, isLoading, ...props }, ref) => {
    const t = useTranslations('Categories')
    const groups = categories.reduce<Record<string, Category[]>>(
      (result, category) => {
        ;(result[category.grouping] ??= []).push(category)
        return result
      },
      {},
    )
    return (
      <NativeSelect
        ref={ref}
        {...props}
        value={defaultValue}
        onChange={(event) => onValueChange(Number(event.target.value))}
        disabled={isLoading}
        aria-busy={isLoading}
      >
        {Object.entries(groups).map(([key, options]) => (
          <optgroup key={key} label={t(`${key}.heading`)}>
            {options.map((category) => (
              <option key={category.id} value={category.id}>
                {t(`${category.grouping}.${category.name}`)}
              </option>
            ))}
          </optgroup>
        ))}
      </NativeSelect>
    )
  },
)
CategorySelector.displayName = 'CategorySelector'
