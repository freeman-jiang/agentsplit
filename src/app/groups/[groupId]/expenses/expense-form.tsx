import { CategorySelector } from '@/components/category-selector'
import { CurrencySelector } from '@/components/currency-selector'
import { ExpenseDocumentsInput } from '@/components/expense-documents-input'
import { SubmitButton } from '@/components/submit-button'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormFieldScope,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { RecurrenceRule } from '@/generated/prisma/browser'
import { Locale } from '@/i18n/request'
import { useAnalytics } from '@/lib/analytics/context'
import {
  defaultCurrencyList,
  expenseCurrencySchema,
  getCurrency,
} from '@/lib/currency'
import { RuntimeFeatureFlags } from '@/lib/featureFlags'
import { useActiveUser } from '@/lib/hooks'
import { Decimal, decimalStringSchema } from '@/lib/money'
import { randomId } from '@/lib/random'
import {
  EXPENSE_NOTES_MAX,
  ExpenseFormInput,
  expenseFormSchema,
  ExpenseFormValues,
  SplittingOptions,
} from '@/lib/schemas'
import { distributeAmount, getExpenseShares } from '@/lib/shares'
import { cn, formatCurrency } from '@/lib/utils'
import { AppRouterOutput } from '@/trpc/routers/_app'
import { zodResolver } from '@hookform/resolvers/zod'
import { Save } from 'lucide-react'
import { useLocale, useTranslations } from 'next-intl'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { useEffect, useState } from 'react'
import { useForm, useWatch } from 'react-hook-form'
import { match } from 'ts-pattern'
import { DeletePopup } from '../../../../components/delete-popup'
import { extractCategoryFromTitle } from '../../../../components/expense-form-actions'
import { Textarea } from '../../../../components/ui/textarea'

// Preserve typed text. Only the shared schema decides whether it is valid.
const previewDecimal = (value: string | undefined) => {
  const parsed = decimalStringSchema.safeParse(value)
  return new Decimal(parsed.success ? parsed.data : '0')
}

const getDefaultSplittingOptions = (
  group: NonNullable<AppRouterOutput['groups']['get']['group']>,
) => {
  const defaultValue = {
    splitMode: 'EVENLY' as const,
    paidFor: group.participants.map(({ id }) => ({
      participant: id,
      shares: '1', // Use string to ensure consistent schema handling
    })),
  }

  if (typeof localStorage === 'undefined') return defaultValue
  const defaultSplitMode = localStorage.getItem(
    `${group.id}-defaultSplittingOptions-v2`,
  )
  if (defaultSplitMode === null) return defaultValue
  const parsedDefaultSplitMode = JSON.parse(
    defaultSplitMode,
  ) as SplittingOptions

  if (parsedDefaultSplitMode.paidFor === null) {
    parsedDefaultSplitMode.paidFor = defaultValue.paidFor
  }

  // if there is a participant in the default options that does not exist anymore,
  // remove the stale default splitting options
  for (const parsedPaidFor of parsedDefaultSplitMode.paidFor) {
    if (
      !group.participants.some(({ id }) => id === parsedPaidFor.participant)
    ) {
      localStorage.removeItem(`${group.id}-defaultSplittingOptions-v2`)
      return defaultValue
    }
  }

  return {
    splitMode: parsedDefaultSplitMode.splitMode,
    paidFor: parsedDefaultSplitMode.paidFor.map((paidFor) => ({
      participant: paidFor.participant,
      shares: paidFor.shares, // Convert to string for consistent schema handling
    })),
  }
}

async function persistDefaultSplittingOptions(
  groupId: string,
  expenseFormValues: ExpenseFormValues,
) {
  if (localStorage && expenseFormValues.saveDefaultSplittingOptions) {
    const computePaidFor = (): SplittingOptions['paidFor'] => {
      if (expenseFormValues.splitMode === 'EVENLY') {
        return expenseFormValues.paidFor.map(({ participant }) => ({
          participant,
          shares: '1',
        }))
      } else if (expenseFormValues.splitMode === 'BY_AMOUNT') {
        return null
      } else {
        return expenseFormValues.paidFor
      }
    }

    const splittingOptions = {
      splitMode: expenseFormValues.splitMode,
      paidFor: computePaidFor(),
    } satisfies SplittingOptions

    localStorage.setItem(
      `${groupId}-defaultSplittingOptions-v2`,
      JSON.stringify(splittingOptions),
    )
  }
}

export function ExpenseForm({
  group,
  categories,
  expense,
  expenseId,
  onSubmit,
  onDelete,
  runtimeFeatureFlags,
}: {
  group: NonNullable<AppRouterOutput['groups']['get']['group']>
  categories: AppRouterOutput['categories']['list']['categories']
  expense?: AppRouterOutput['groups']['expenses']['get']['expense']
  /**
   * The id a new expense will be created with. Only the split preview reads
   * it; when editing, `expense.id` is used instead.
   */
  expenseId?: string
  onSubmit: (value: ExpenseFormValues, participantId?: string) => Promise<void>
  onDelete?: (participantId?: string) => Promise<void>
  runtimeFeatureFlags: RuntimeFeatureFlags
}) {
  const t = useTranslations('ExpenseForm')
  const locale = useLocale() as Locale
  const isCreate = expense === undefined
  const searchParams = useSearchParams()

  /** Whether the form was opened from a suggested reimbursement ("Mark as paid"). */
  const isRepayment = isCreate && !!searchParams.get('reimbursement')

  const getSelectedPayer = (field?: { value: string }) => {
    if (isCreate && typeof window !== 'undefined') {
      const activeUser = localStorage.getItem(`${group.id}-activeUser`)
      if (activeUser && activeUser !== 'None' && field?.value === undefined) {
        return activeUser
      }
    }
    return field?.value
  }

  const getSelectedRecurrenceRule = (field?: { value?: string }) => {
    return field?.value as RecurrenceRule
  }
  const defaultSplittingOptions = getDefaultSplittingOptions(group)
  const currencyCandidate =
    expense?.currencyCode ??
    searchParams.get('currencyCode') ??
    group.currencyCode ??
    undefined
  const parsedCurrency = expenseCurrencySchema.safeParse(currencyCandidate)
  const initialCurrencyCode = parsedCurrency.success
    ? parsedCurrency.data
    : undefined
  const form = useForm<ExpenseFormInput, any, ExpenseFormValues>({
    resolver: zodResolver(expenseFormSchema),
    defaultValues: expense
      ? {
          title: expense.title,
          expenseDate: expense.expenseDate ?? getTodayForDateInput(),
          amount: expense.amount,
          currencyCode: initialCurrencyCode,
          category: expense.categoryId,
          paidBy: expense.paidById,
          paidFor: expense.paidFor.map(({ participantId, shares }) => ({
            participant: participantId,
            shares,
          })),
          splitMode: expense.splitMode,
          saveDefaultSplittingOptions: false,
          isReimbursement: expense.isReimbursement,
          documents: expense.documents,
          notes: expense.notes ?? '',
          recurrenceRule: expense.recurrenceRule ?? undefined,
        }
      : isRepayment
        ? {
            title: t('reimbursement'),
            expenseDate: getTodayForDateInput(),
            amount: searchParams.get('amount') ?? '',
            currencyCode: initialCurrencyCode,
            category: 1, // category with Id 1 is Payment
            paidBy: searchParams.get('from') ?? undefined,
            paidFor: [
              searchParams.get('to')
                ? {
                    participant: searchParams.get('to')!,
                    shares: '1', // String for consistent form handling
                  }
                : undefined,
            ],
            isReimbursement: true,
            splitMode: defaultSplittingOptions.splitMode,
            saveDefaultSplittingOptions: false,
            documents: [],
            notes: '',
            recurrenceRule: RecurrenceRule.NONE,
          }
        : {
            title: searchParams.get('title') ?? '',
            expenseDate: searchParams.get('date')
              ? new Date(searchParams.get('date') as string)
              : getTodayForDateInput(),
            amount: searchParams.get('amount') ?? '',
            currencyCode: initialCurrencyCode,
            category: searchParams.get('categoryId')
              ? Number(searchParams.get('categoryId'))
              : 0, // category with Id 0 is General
            // paid for all, split evenly
            paidFor: defaultSplittingOptions.paidFor,
            paidBy: getSelectedPayer(),
            isReimbursement: false,
            splitMode: defaultSplittingOptions.splitMode,
            saveDefaultSplittingOptions: false,
            documents: searchParams.get('imageUrl')
              ? [
                  {
                    id: randomId(),
                    url: searchParams.get('imageUrl') as string,
                    width: Number(searchParams.get('imageWidth')),
                    height: Number(searchParams.get('imageHeight')),
                  },
                ]
              : [],
            notes: '',
            recurrenceRule: RecurrenceRule.NONE,
          },
  })
  const watchedPayer = useWatch({ control: form.control, name: 'paidBy' })
  const watchedAmount = useWatch({ control: form.control, name: 'amount' })
  const watchedMode = useWatch({ control: form.control, name: 'splitMode' })
  const watchedCurrency = useWatch({
    control: form.control,
    name: 'currencyCode',
  })
  const watchedPaidFor = useWatch({ control: form.control, name: 'paidFor' })
  const watchedReimbursement = useWatch({
    control: form.control,
    name: 'isReimbursement',
  })
  const watchedCategory = useWatch({ control: form.control, name: 'category' })
  const watchedForm = useWatch({ control: form.control })
  const expenseCurrency = getCurrency(watchedCurrency, locale)
  const [isCategoryLoading, setCategoryLoading] = useState(false)
  const activeUserId = useActiveUser(group.id)
  const sendEvent = useAnalytics()

  const submit = async (values: ExpenseFormValues) => {
    sendEvent(
      { event: expense ? 'expense: update' : 'expense: create', props: {} },
      `/groups/${group.id}/expenses`,
    )

    await persistDefaultSplittingOptions(group.id, values)

    return onSubmit(values, activeUserId ?? undefined)
  }

  const [isIncome, setIsIncome] = useState(
    form.getValues().amount.startsWith('-'),
  )
  // How the user last touched each participant's share. An 'edited' amount is
  // kept as typed; every other participant takes an equal part of what is
  // left. A 'cleared' participant (the input was emptied) is one of those, but
  // the input shows its part as a placeholder rather than a value, so the user
  // can type over it without deleting it first.
  const [shareEdits, setShareEdits] = useState<
    Map<string, 'edited' | 'cleared'>
  >(new Map())

  const markShareEdited = (id: string, cleared: boolean) => {
    const state =
      cleared && form.getValues().splitMode === 'BY_AMOUNT'
        ? 'cleared'
        : 'edited'
    setShareEdits((prev) => new Map(prev).set(id, state))
  }

  const forgetShareEdit = (id: string) =>
    setShareEdits((prev) => {
      const next = new Map(prev)
      next.delete(id)
      return next
    })

  const sExpense = isIncome ? 'Income' : 'Expense'

  useEffect(() => {
    setShareEdits(new Map())
  }, [watchedMode, watchedAmount])

  useEffect(() => {
    const splitMode = form.getValues().splitMode

    // Only auto-balance for split mode 'Unevenly - By amount'
    if (
      splitMode === 'BY_AMOUNT' &&
      (form.getFieldState('paidFor').isDirty ||
        form.getFieldState('amount').isDirty)
    ) {
      const totalAmount = previewDecimal(form.getValues().amount)
      const paidFor = form.getValues().paidFor
      let newPaidFor = [...paidFor]

      const editedParticipants = Array.from(shareEdits)
        .filter(([, state]) => state === 'edited')
        .map(([id]) => id)
      let remainingAmount = totalAmount
      let remainingParticipants = newPaidFor.length - editedParticipants.length

      newPaidFor = newPaidFor.map((participant) => {
        if (editedParticipants.includes(participant.participant)) {
          const participantShare = previewDecimal(participant.shares)
          if (splitMode === 'BY_AMOUNT') {
            remainingAmount = remainingAmount.minus(participantShare)
          }
          return participant
        }
        return participant
      })

      if (
        remainingParticipants > 0 &&
        new Decimal(remainingAmount).decimalPlaces() <=
          expenseCurrency.decimal_digits
      ) {
        // Apportion in minor units so the auto-filled amounts add up to the
        // total exactly. Dividing and rounding each one independently makes
        // 95 across three participants come out as 31.67 three times, which
        // the "amounts must add up" validation then rejects.
        const remainingPeople = newPaidFor
          .filter((person) => !editedParticipants.includes(person.participant))
          .sort((a, b) => a.participant.localeCompare(b.participant))
        const amountsPerRemaining = distributeAmount(
          remainingAmount.toFixed(),
          remainingParticipants,
          expenseCurrency.code,
          remainingPeople.findIndex(
            (person) => person.participant === watchedPayer,
          ),
        )

        const autoAmounts = new Map(
          remainingPeople.map((person, index) => [
            person.participant,
            amountsPerRemaining[index],
          ]),
        )
        newPaidFor = newPaidFor.map((participant) => {
          if (!editedParticipants.includes(participant.participant)) {
            return {
              ...participant,
              shares:
                autoAmounts.get(participant.participant) ?? participant.shares, // Keep as string for consistent schema handling
            }
          }
          return participant
        })
      }
      form.setValue('paidFor', newPaidFor, { shouldValidate: true })
    }
  }, [
    shareEdits,
    watchedAmount,
    watchedMode,
    watchedPayer,
    expenseCurrency.code,
    expenseCurrency.decimal_digits,
    form,
  ])

  const splitSumValues = ((): Record<string, string> | undefined => {
    if (!form.formState.errors.paidFor) return undefined
    const sum = watchedPaidFor.reduce(
      (sum, person) => sum.plus(previewDecimal(person.shares)),
      new Decimal(0),
    )
    if (watchedMode === 'BY_AMOUNT') {
      const amount = previewDecimal(watchedAmount)
      return {
        sum: formatCurrency(expenseCurrency, sum.toFixed(), locale),
        amount: formatCurrency(expenseCurrency, amount.toFixed(), locale),
        difference: formatCurrency(
          expenseCurrency,
          sum.minus(amount).abs().toFixed(),
          locale,
        ),
        direction: sum.gt(amount) ? 'over' : 'under',
      }
    }
    if (watchedMode === 'BY_PERCENTAGE')
      return {
        sum: sum.toFixed(),
        difference: sum.minus(100).abs().toFixed(),
        direction: sum.gt(100) ? 'over' : 'under',
      }
    return undefined
  })()
  const preview = expenseFormSchema.safeParse(watchedForm)
  const previewShares =
    preview.success &&
    new Decimal(preview.data.amount).decimalPlaces() <=
      expenseCurrency.decimal_digits
      ? getExpenseShares({
          id: expense?.id ?? expenseId,
          paidById: preview.data.paidBy,
          amount: preview.data.amount,
          currencyCode: preview.data.currencyCode,
          splitMode: preview.data.splitMode,
          paidFor: preview.data.paidFor.map((person) => ({
            participantId: person.participant,
            shares: person.shares,
          })),
        })
      : null

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(submit)}>
        <Card>
          <CardHeader>
            <CardTitle>
              {t(`${sExpense}.${isCreate ? 'create' : 'edit'}`)}
            </CardTitle>
          </CardHeader>
          <CardContent className="grid sm:grid-cols-2 gap-6">
            <FormField
              control={form.control}
              name="title"
              render={({ field }) => (
                <FormItem className="">
                  <FormLabel>{t(`${sExpense}.TitleField.label`)}</FormLabel>
                  <FormControl>
                    <Input
                      placeholder={t(`${sExpense}.TitleField.placeholder`)}
                      className="text-base"
                      {...field}
                      onBlur={async () => {
                        field.onBlur() // avoid skipping other blur event listeners since we overwrite `field`
                        // Skip empty titles: tabbing through the field would
                        // otherwise spend an API call to categorise "".
                        if (
                          runtimeFeatureFlags.enableCategoryExtract &&
                          field.value.trim()
                        ) {
                          setCategoryLoading(true)
                          const { categoryId } = await extractCategoryFromTitle(
                            field.value,
                          )
                          form.setValue('category', categoryId)
                          setCategoryLoading(false)
                        }
                      }}
                    />
                  </FormControl>
                  <FormDescription>
                    {t(`${sExpense}.TitleField.description`)}
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="expenseDate"
              render={({ field }) => (
                <FormItem className="sm:order-1">
                  <FormLabel>{t(`${sExpense}.DateField.label`)}</FormLabel>
                  <FormControl>
                    <Input
                      className="date-base"
                      type="date"
                      defaultValue={formatDate(field.value as Date)}
                      onChange={(event) => {
                        return field.onChange(new Date(event.target.value))
                      }}
                    />
                  </FormControl>
                  <FormDescription>
                    {t(`${sExpense}.DateField.description`)}
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="currencyCode"
              render={({ field }) => (
                <FormItem className="sm:order-3">
                  <FormLabel>{t(`${sExpense}.currencyField.label`)}</FormLabel>
                  <FormControl>
                    <CurrencySelector
                      currencies={defaultCurrencyList(locale)}
                      defaultValue={field.value ?? ''}
                      isLoading={false}
                      onValueChange={field.onChange}
                    />
                  </FormControl>
                  <FormDescription>
                    {t(`${sExpense}.currencyField.description`)}
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="category"
              render={({ field }) => (
                <FormItem className="sm:order-2">
                  <FormLabel>{t('categoryField.label')}</FormLabel>
                  <CategorySelector
                    categories={categories}
                    defaultValue={
                      watchedCategory ?? 0 // may be overwritten externally
                    }
                    onValueChange={field.onChange}
                    isLoading={isCategoryLoading}
                  />
                  <FormDescription>
                    {t(`${sExpense}.categoryFieldDescription`)}
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="amount"
              render={({ field: { onChange, ...field } }) => (
                <FormItem className="sm:order-5">
                  <FormLabel>{t('amountField.label')}</FormLabel>
                  <div className="flex items-baseline gap-2">
                    <span>{expenseCurrency.symbol}</span>
                    <FormControl>
                      <Input
                        className="text-base max-w-[120px]"
                        type="text"
                        inputMode="decimal"
                        placeholder="0.00"
                        onChange={(event) => {
                          const v = event.target.value
                          const income = v.startsWith('-')
                          setIsIncome(income)
                          if (income) form.setValue('isReimbursement', false)
                          onChange(v)
                        }}
                        onFocus={(e) => {
                          // we're adding a small delay to get around safaris issue with onMouseUp deselecting things again
                          const target = e.currentTarget
                          setTimeout(() => target.select(), 1)
                        }}
                        {...field}
                      />
                    </FormControl>
                  </div>
                  <FormMessage />

                  {!isIncome && (
                    <FormField
                      control={form.control}
                      name="isReimbursement"
                      render={({ field }) => (
                        <FormItem className="flex flex-row gap-2 items-center space-y-0 pt-2">
                          <FormControl>
                            <Checkbox
                              checked={field.value}
                              onCheckedChange={field.onChange}
                            />
                          </FormControl>
                          <div>
                            <FormLabel>
                              {t('isReimbursementField.label')}
                            </FormLabel>
                          </div>
                        </FormItem>
                      )}
                    />
                  )}
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="paidBy"
              render={({ field }) => (
                <FormItem className="sm:order-5">
                  <FormLabel>{t(`${sExpense}.paidByField.label`)}</FormLabel>
                  <Select
                    onValueChange={field.onChange}
                    defaultValue={getSelectedPayer(field)}
                  >
                    <SelectTrigger data-testid="paid-by">
                      <SelectValue
                        placeholder={t(`${sExpense}.paidByField.placeholder`)}
                      />
                    </SelectTrigger>
                    <SelectContent>
                      {group.participants.map(({ id, name }) => (
                        <SelectItem key={id} value={id}>
                          {name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormDescription>
                    {t(`${sExpense}.paidByField.description`)}
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="notes"
              render={({ field }) => (
                <FormItem className="sm:order-6">
                  <FormLabel>{t('notesField.label')}</FormLabel>
                  <FormControl>
                    <Textarea
                      className="text-base"
                      maxLength={EXPENSE_NOTES_MAX}
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="recurrenceRule"
              render={({ field }) => (
                <FormItem className="sm:order-5">
                  <FormLabel>{t(`${sExpense}.recurrenceRule.label`)}</FormLabel>
                  <Select
                    onValueChange={(value) => {
                      form.setValue('recurrenceRule', value as RecurrenceRule)
                    }}
                    defaultValue={getSelectedRecurrenceRule(field)}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="NONE" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="NONE">
                        {t(`${sExpense}.recurrenceRule.none`)}
                      </SelectItem>
                      <SelectItem value="DAILY">
                        {t(`${sExpense}.recurrenceRule.daily`)}
                      </SelectItem>
                      <SelectItem value="WEEKLY">
                        {t(`${sExpense}.recurrenceRule.weekly`)}
                      </SelectItem>
                      <SelectItem value="MONTHLY">
                        {t(`${sExpense}.recurrenceRule.monthly`)}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                  <FormDescription>
                    {t(`${sExpense}.recurrenceRule.description`)}
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
          </CardContent>
        </Card>

        <Card className="mt-4">
          <CardHeader>
            <CardTitle className="flex justify-between">
              <span>{t(`${sExpense}.paidFor.title`)}</span>
              <Button
                variant="link"
                type="button"
                className="-my-2 -mx-4"
                onClick={() => {
                  const paidFor = form.getValues().paidFor
                  const allSelected =
                    paidFor.length === group.participants.length
                  const newPaidFor = allSelected
                    ? []
                    : group.participants.map((p) => ({
                        participant: p.id,
                        shares:
                          paidFor.find((pfor) => pfor.participant === p.id)
                            ?.shares ?? '1', // Use string to ensure consistent schema handling
                      }))
                  form.setValue('paidFor', newPaidFor, {
                    shouldDirty: true,
                    shouldTouch: true,
                    shouldValidate: true,
                  })
                  if (allSelected) setShareEdits(new Map())
                }}
              >
                {form.getValues().paidFor.length ===
                group.participants.length ? (
                  <>{t('selectNone')}</>
                ) : (
                  <>{t('selectAll')}</>
                )}
              </Button>
            </CardTitle>
            <CardDescription>
              {t(`${sExpense}.paidFor.description`)}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <FormField
              control={form.control}
              name="paidFor"
              render={() => (
                <FormItem className="sm:order-4 row-span-2 space-y-0">
                  {group.participants.map(({ id, name }) => (
                    <FormField
                      key={id}
                      control={form.control}
                      name="paidFor"
                      render={({ field }) => {
                        const index = field.value.findIndex(
                          ({ participant }) => participant === id,
                        )
                        const isSelected = index !== -1
                        const row = field.value[index]
                        const cleared = shareEdits.get(id) === 'cleared'
                        const sharesLabel = (
                          <span
                            className={cn('text-sm', {
                              'text-muted': !isSelected,
                            })}
                          >
                            {match(form.getValues().splitMode)
                              .with('BY_SHARES', () => <>{t('shares')}</>)
                              .with('BY_PERCENTAGE', () => <>%</>)
                              .with('BY_AMOUNT', () => (
                                <>{expenseCurrency.symbol}</>
                              ))
                              .otherwise(() => (
                                <></>
                              ))}
                          </span>
                        )
                        return (
                          <div
                            data-id={`${id}/${form.getValues().splitMode}/${
                              group.currency
                            }`}
                            className="flex flex-wrap gap-y-4 items-center border-t last-of-type:border-b last-of-type:!mb-4 -mx-6 px-6 py-3"
                          >
                            <FormItem className="flex-1 flex flex-row items-start space-x-3 space-y-0">
                              <FormControl>
                                <Checkbox
                                  checked={isSelected}
                                  onCheckedChange={(checked) => {
                                    const options = {
                                      shouldDirty: true,
                                      shouldTouch: true,
                                      shouldValidate: true,
                                    }
                                    checked
                                      ? form.setValue(
                                          'paidFor',
                                          [
                                            ...field.value,
                                            {
                                              participant: id,
                                              shares: '1', // Use string to ensure consistent schema handling
                                            },
                                          ],
                                          options,
                                        )
                                      : form.setValue(
                                          'paidFor',
                                          field.value?.filter(
                                            (value) => value.participant !== id,
                                          ),
                                          options,
                                        )
                                    if (!checked) forgetShareEdit(id)
                                  }}
                                />
                              </FormControl>
                              <FormLabel className="text-sm font-normal flex-1">
                                {name}
                                {isSelected && !watchedReimbursement && (
                                  <span className="text-muted-foreground ml-2">
                                    (
                                    {formatCurrency(
                                      expenseCurrency,
                                      previewShares?.get(id) ?? '0',
                                      locale,
                                    )}
                                    )
                                  </span>
                                )}
                              </FormLabel>
                            </FormItem>
                            <div className="flex flex-wrap justify-end gap-y-2">
                              {form.getValues().splitMode !== 'EVENLY' && (
                                <FormFieldScope
                                  name={`paidFor.${index}.shares`}
                                >
                                  <div>
                                    <div className="flex gap-1 items-center">
                                      {form.getValues().splitMode ===
                                        'BY_AMOUNT' && sharesLabel}
                                      <FormControl>
                                        <Input
                                          key={String(!isSelected)}
                                          className="text-base w-[80px] -my-2"
                                          type="text"
                                          disabled={!isSelected}
                                          value={cleared ? '' : row?.shares}
                                          placeholder={
                                            cleared
                                              ? String(row?.shares ?? '')
                                              : undefined
                                          }
                                          onChange={(event) => {
                                            const shares = event.target.value
                                            field.onChange(
                                              field.value.map((p) =>
                                                p.participant === id
                                                  ? { participant: id, shares }
                                                  : p,
                                              ),
                                            )
                                            markShareEdited(id, shares === '')
                                          }}
                                          inputMode={
                                            form.getValues().splitMode ===
                                            'BY_AMOUNT'
                                              ? 'decimal'
                                              : 'numeric'
                                          }
                                          step={
                                            form.getValues().splitMode ===
                                            'BY_AMOUNT'
                                              ? 10 **
                                                -expenseCurrency.decimal_digits
                                              : 1
                                          }
                                        />
                                      </FormControl>
                                      {['BY_SHARES', 'BY_PERCENTAGE'].includes(
                                        form.getValues().splitMode!,
                                      ) && sharesLabel}
                                    </div>
                                    <FormMessage className="float-right" />
                                  </div>
                                </FormFieldScope>
                              )}
                            </div>
                          </div>
                        )
                      }}
                    />
                  ))}
                  <FormMessage values={splitSumValues} />
                </FormItem>
              )}
            />

            <Collapsible
              className="mt-5"
              defaultOpen={form.getValues().splitMode !== 'EVENLY'}
            >
              <CollapsibleTrigger asChild>
                <Button variant="link" className="-mx-4">
                  {t('advancedOptions')}
                </Button>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <div className="grid sm:grid-cols-2 gap-6 pt-3">
                  <FormField
                    control={form.control}
                    name="splitMode"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>{t('SplitModeField.label')}</FormLabel>
                        <FormControl>
                          <Select
                            onValueChange={(value) => {
                              form.setValue('splitMode', value as any, {
                                shouldDirty: true,
                                shouldTouch: true,
                                shouldValidate: true,
                              })
                              // Validating `splitMode` leaves a "must add up"
                              // error from the previous mode in place, and its
                              // message would now be given the values of the
                              // new mode. Check the shares again for this one.
                              if (form.getFieldState('paidFor').error) {
                                form.clearErrors('paidFor')
                                void form.trigger('paidFor')
                              }
                            }}
                            defaultValue={field.value}
                          >
                            <SelectTrigger data-testid="split-mode">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="EVENLY">
                                {t('SplitModeField.evenly')}
                              </SelectItem>
                              <SelectItem value="BY_SHARES">
                                {t('SplitModeField.byShares')}
                              </SelectItem>
                              <SelectItem value="BY_PERCENTAGE">
                                {t('SplitModeField.byPercentage')}
                              </SelectItem>
                              <SelectItem value="BY_AMOUNT">
                                {t('SplitModeField.byAmount')}
                              </SelectItem>
                            </SelectContent>
                          </Select>
                        </FormControl>
                        <FormDescription>
                          {t(`${sExpense}.splitModeDescription`)}
                        </FormDescription>
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="saveDefaultSplittingOptions"
                    render={({ field }) => (
                      <FormItem className="flex flex-row gap-2 items-center space-y-0 pt-2">
                        <FormControl>
                          <Checkbox
                            checked={field.value}
                            onCheckedChange={field.onChange}
                          />
                        </FormControl>
                        <div>
                          <FormLabel>
                            {t('SplitModeField.saveAsDefault')}
                          </FormLabel>
                        </div>
                      </FormItem>
                    )}
                  />
                </div>
              </CollapsibleContent>
            </Collapsible>
          </CardContent>
        </Card>

        {runtimeFeatureFlags.enableExpenseDocuments && (
          <Card className="mt-4">
            <CardHeader>
              <CardTitle className="flex justify-between">
                <span>{t('attachDocuments')}</span>
              </CardTitle>
              <CardDescription>
                {t(`${sExpense}.attachDescription`)}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <FormField
                control={form.control}
                name="documents"
                render={({ field }) => (
                  <ExpenseDocumentsInput
                    documents={field.value ?? []}
                    updateDocuments={field.onChange}
                    onDocumentAttached={() =>
                      sendEvent(
                        { event: 'expense: attach document', props: {} },
                        `/groups/${group.id}/expenses`,
                      )
                    }
                  />
                )}
              />
            </CardContent>
          </Card>
        )}

        <div className="flex flex-col sm:flex-row mt-4 gap-2">
          <SubmitButton
            className="w-full sm:w-auto"
            loadingContent={t(isCreate ? 'creating' : 'saving')}
          >
            <Save className="w-4 h-4 mr-2" />
            {t(isCreate ? 'create' : 'save')}
          </SubmitButton>
          {!isCreate && onDelete && (
            <DeletePopup
              onDelete={async () => {
                sendEvent(
                  { event: 'expense: delete', props: {} },
                  `/groups/${group.id}/expenses`,
                )
                await onDelete(activeUserId ?? undefined)
              }}
            ></DeletePopup>
          )}
          <Button variant="ghost" className="w-full sm:w-auto" asChild>
            <Link href={`/groups/${group.id}`}>{t('cancel')}</Link>
          </Button>
        </div>
      </form>
    </Form>
  )
}

function formatDate(date?: Date) {
  if (!date || isNaN(date as any)) date = getTodayForDateInput()
  return date.toISOString().substring(0, 10)
}

function getTodayForDateInput() {
  const now = new Date()
  return new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()))
}
