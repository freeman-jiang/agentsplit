import { CategorySelector } from '@/components/category-selector'
import { CurrencySelector } from '@/components/currency-selector'
import { ExpenseDocumentsInput } from '@/components/expense-documents-input'
import { SubmitButton } from '@/components/submit-button'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Form,
  FormControl,
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
  const activeUserId = useActiveUser(group.id)

  /** Whether the form was opened from a suggested reimbursement ("Mark as paid"). */
  const isRepayment = isCreate && !!searchParams.get('reimbursement')

  const getSelectedPayer = (field?: { value: string }) => {
    if (isCreate && field?.value === undefined && activeUserId)
      return activeUserId
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
          vendor: expense.vendor ?? '',
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
            vendor: '',
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
            vendor: searchParams.get('vendor') ?? '',
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
  const [notesOpen, setNotesOpen] = useState(
    Boolean(form.getValues().notes || form.getValues().documents?.length),
  )
  const [optionsOpen, setOptionsOpen] = useState(
    Boolean(
      form.getValues().isReimbursement ||
      (form.getValues().recurrenceRule &&
        form.getValues().recurrenceRule !== 'NONE'),
    ),
  )
  const [isCategoryLoading, setCategoryLoading] = useState(false)
  useEffect(() => {
    if (isCreate && activeUserId && !form.getValues('paidBy'))
      form.setValue('paidBy', activeUserId)
  }, [activeUserId, isCreate, form])
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
      <form
        onSubmit={form.handleSubmit(submit)}
        className="expense-editor mx-auto w-full max-w-4xl"
      >
        <h1 className="mb-8 font-display text-3xl font-normal tracking-tight">
          {t(`${sExpense}.${isCreate ? 'create' : 'edit'}`)}
        </h1>
        {expense && (
          <p className="-mt-5 mb-8 text-xs text-muted-foreground">
            {expense.attribution.createdBy
              ? `Added by ${expense.attribution.createdBy.name}`
              : 'Original author unavailable'}
            {expense.attribution.updatedBy &&
              ` · Last edited by ${expense.attribution.updatedBy.name}`}
          </p>
        )}
        <div className="grid items-start gap-8 lg:grid-cols-[minmax(0,1fr)_13rem]">
          <div className="min-w-0">
            <section aria-label={t('Layout.details')} className="space-y-4">
              <FormField
                control={form.control}
                name="vendor"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Vendor (optional)</FormLabel>
                    <FormControl>
                      <Input
                        {...field}
                        value={field.value ?? ''}
                        placeholder="Costco"
                        className="text-base"
                        maxLength={100}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="title"
                render={({ field }) => (
                  <FormItem>
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
                            const { categoryId } =
                              await extractCategoryFromTitle(field.value)
                            form.setValue('category', categoryId)
                            setCategoryLoading(false)
                          }
                        }}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <div className="grid gap-4 sm:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
                <div className="flex min-w-0 items-start">
                  <div className="min-w-0 flex-1">
                    <FormField
                      control={form.control}
                      name="amount"
                      render={({ field: { onChange, ...field } }) => (
                        <FormItem>
                          <FormLabel className="block">
                            {t('amountField.label')}
                          </FormLabel>
                          <div className="flex items-center">
                            <FormControl>
                              <Input
                                className="h-12 bg-card text-xl tabular-nums"
                                type="text"
                                inputMode="decimal"
                                placeholder="0.00"
                                onChange={(event) => {
                                  const v = event.target.value
                                  const income = v.startsWith('-')
                                  setIsIncome(income)
                                  if (income)
                                    form.setValue('isReimbursement', false)
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
                        </FormItem>
                      )}
                    />
                  </div>
                  <div className="w-28 shrink-0 pt-7">
                    <FormField
                      control={form.control}
                      name="currencyCode"
                      render={({ field }) => (
                        <FormItem className="space-y-0">
                          <FormLabel className="sr-only">
                            {t(`${sExpense}.currencyField.label`)}
                          </FormLabel>
                          <FormControl>
                            <CurrencySelector
                              compact
                              currencies={defaultCurrencyList(locale)}
                              defaultValue={field.value ?? ''}
                              isLoading={false}
                              onValueChange={field.onChange}
                            />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  </div>
                </div>
                <FormField
                  control={form.control}
                  name="expenseDate"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className="block">
                        {t(`${sExpense}.DateField.label`)}
                      </FormLabel>
                      <FormControl>
                        <Input
                          className="h-12 bg-card"
                          type="date"
                          defaultValue={formatDate(field.value as Date)}
                          onChange={(event) => {
                            return field.onChange(new Date(event.target.value))
                          }}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
              <div className="sm:max-w-xs">
                <FormField
                  control={form.control}
                  name="paidBy"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>
                        {t(`${sExpense}.paidByField.label`)}
                      </FormLabel>
                      <Select
                        onValueChange={field.onChange}
                        defaultValue={getSelectedPayer(field)}
                      >
                        <FormControl>
                          <SelectTrigger data-testid="paid-by">
                            <SelectValue
                              placeholder={t(
                                `${sExpense}.paidByField.placeholder`,
                              )}
                            />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {group.participants.map(({ id, name }) => (
                            <SelectItem key={id} value={id}>
                              {name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
            </section>
            <section
              className="mt-8"
              aria-label={t(`${sExpense}.paidFor.title`)}
            >
              <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                <h2 className="text-sm font-medium">
                  {t('Layout.splitBetween')}
                </h2>
                <FormField
                  control={form.control}
                  name="splitMode"
                  render={({ field }) => (
                    <FormItem className="w-full sm:w-56">
                      <FormLabel className="sr-only">
                        {t('SplitModeField.label')}
                      </FormLabel>
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
                          value={field.value}
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
                    </FormItem>
                  )}
                />
              </div>
              <FormField
                control={form.control}
                name="paidFor"
                render={() => (
                  <FormItem className="space-y-0">
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
                                'text-muted-foreground': !isSelected,
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
                              className="flex min-h-12 flex-wrap items-center gap-x-4 gap-y-2 py-2"
                            >
                              <FormItem className="min-w-0 flex-1 flex flex-row items-center space-x-3 space-y-0">
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
                                              (value) =>
                                                value.participant !== id,
                                            ),
                                            options,
                                          )
                                      if (!checked) forgetShareEdit(id)
                                    }}
                                  />
                                </FormControl>
                                <FormLabel
                                  data-participant-name
                                  className="flex min-w-0 flex-1 flex-wrap items-center justify-between gap-2 text-sm font-normal"
                                >
                                  {name}
                                  {isSelected && !watchedReimbursement && (
                                    <span
                                      data-testid="share-preview"
                                      className="tabular-nums text-muted-foreground"
                                    >
                                      {formatCurrency(
                                        expenseCurrency,
                                        previewShares?.get(id) ?? '0',
                                        locale,
                                      )}
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
                                            className="w-24 bg-card text-base tabular-nums"
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
                                                    ? {
                                                        participant: id,
                                                        shares,
                                                      }
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
                                        {[
                                          'BY_SHARES',
                                          'BY_PERCENTAGE',
                                        ].includes(
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
              <div className="flex justify-end">
                {' '}
                <Button
                  variant="link"
                  type="button"
                  className="h-9 px-0 text-xs"
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
              </div>
            </section>
            <div className="mt-5 border-t">
              <details
                className="border-b"
                open={
                  notesOpen ||
                  Boolean(
                    form.formState.errors.notes ||
                    form.formState.errors.documents,
                  )
                }
                onToggle={(event) => setNotesOpen(event.currentTarget.open)}
              >
                <summary>
                  {t('Layout.notesReceipt')}
                  <span className="ms-auto text-xs text-muted-foreground">
                    {t('Layout.optional')}
                  </span>
                </summary>
                <div className="space-y-4 pb-5">
                  <FormField
                    control={form.control}
                    name="notes"
                    render={({ field }) => (
                      <FormItem>
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
                  {runtimeFeatureFlags.enableExpenseDocuments && (
                    <div>
                      <FormField
                        control={form.control}
                        name="documents"
                        render={({ field }) => (
                          <ExpenseDocumentsInput
                            documents={field.value ?? []}
                            updateDocuments={field.onChange}
                            onDocumentAttached={() =>
                              sendEvent(
                                {
                                  event: 'expense: attach document',
                                  props: {},
                                },
                                `/groups/${group.id}/expenses`,
                              )
                            }
                          />
                        )}
                      />
                    </div>
                  )}
                </div>
              </details>
              <details
                className="border-b"
                open={
                  optionsOpen ||
                  Boolean(
                    form.formState.errors.category ||
                    form.formState.errors.recurrenceRule ||
                    form.formState.errors.isReimbursement,
                  )
                }
                onToggle={(event) => setOptionsOpen(event.currentTarget.open)}
              >
                <summary>
                  {t('Layout.options')}
                  <span className="ms-auto min-w-0 truncate text-xs text-muted-foreground">
                    {
                      categories.find(
                        (category) => category.id === watchedCategory,
                      )?.name
                    }{' '}
                    ·{' '}
                    {t(
                      `${sExpense}.recurrenceRule.${(watchedForm.recurrenceRule ?? 'NONE').toLowerCase()}`,
                    )}
                  </span>
                </summary>
                <div className="space-y-4 pb-5">
                  <div className="grid gap-4 sm:grid-cols-2">
                    <FormField
                      control={form.control}
                      name="category"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>{t('categoryField.label')}</FormLabel>
                          <FormControl>
                            <CategorySelector
                              categories={categories}
                              defaultValue={
                                watchedCategory ?? 0 // may be overwritten externally
                              }
                              onValueChange={field.onChange}
                              isLoading={isCategoryLoading}
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
                        <FormItem>
                          <FormLabel>
                            {t(`${sExpense}.recurrenceRule.label`)}
                          </FormLabel>
                          <Select
                            onValueChange={(value) => {
                              form.setValue(
                                'recurrenceRule',
                                value as RecurrenceRule,
                              )
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
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  </div>
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
              </details>
            </div>
            <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
              <div>
                {' '}
                {!isCreate && onDelete && (
                  <DeletePopup
                    className="px-0"
                    onDelete={async () => {
                      sendEvent(
                        { event: 'expense: delete', props: {} },
                        `/groups/${group.id}/expenses`,
                      )
                      await onDelete(activeUserId ?? undefined)
                    }}
                  ></DeletePopup>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {' '}
                <Button variant="ghost" className="w-auto" asChild>
                  <Link href={`/groups/${group.id}`}>{t('cancel')}</Link>
                </Button>{' '}
                <SubmitButton
                  className="w-auto"
                  loadingContent={t(isCreate ? 'creating' : 'saving')}
                >
                  {t(isCreate ? 'create' : 'save')}
                </SubmitButton>
              </div>
            </div>
          </div>
          <aside
            className="expense-summary hidden lg:block"
            aria-label={t('Layout.summary')}
          >
            <p className="text-xs uppercase tracking-widest text-muted-foreground">
              {t('Layout.summary')}
            </p>
            <p className="mt-3 break-words font-display text-3xl text-primary tabular-nums">
              {decimalStringSchema.safeParse(watchedAmount).success
                ? formatCurrency(expenseCurrency, watchedAmount, locale)
                : '—'}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {expenseCurrency.code}
            </p>
            <div className="my-5 border-t" />
            <p className="text-xs text-muted-foreground">
              {t(`${sExpense}.paidByField.label`)}
            </p>
            <p className="mt-1 break-words text-sm">
              {group.participants.find((person) => person.id === watchedPayer)
                ?.name ?? '—'}
            </p>
            <p className="mt-4 text-xs text-muted-foreground">
              {t('Layout.people', { count: watchedPaidFor.length })}
            </p>
            <p className="mt-5 text-xs text-muted-foreground">
              {t('Layout.history')}
            </p>
          </aside>
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
