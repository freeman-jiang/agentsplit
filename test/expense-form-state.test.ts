// The form's money rules: what it previews, auto-fills and saves must be what the server stores.
import { beforeEach, describe, expect, it } from 'vitest'
import { amountInput, autoAmounts, check, loadSplitDefaults, newExpenseState, saveSplitDefaults, stateFromExpense, toDraft, type FormState } from '~/client/components/expense-form-state'

const people = ['pa', 'pb', 'pc']
const base = (over: Partial<FormState> = {}): FormState => ({
  ...newExpenseState({ groupId: 'g', participants: people, viewer: 'pb', defaultCurrency: 'USD', prefill: {} }),
  title: 'Dinner',
  amount: '95',
  ...over,
})

beforeEach(() => {
  const store = new Map<string, string>()
  globalThis.localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: () => null,
    length: 0,
  }
})

describe('expense form state', () => {
  it('previews the split the server stores, with the payer first (P-MONEY-72, P-MONEY-80)', () => {
    expect([...(check(base(), people).preview ?? [])]).toEqual([
      ['pa', '31.67'],
      ['pb', '31.67'],
      ['pc', '31.66'],
    ])
  })

  it('auto-fills untyped amounts so they add up, and shows a cleared one as a placeholder (P-EXP-84, P-EXP-85)', () => {
    const state = base({ splitMode: 'amount', weights: { pa: '50' }, edits: { pa: 'edited', pc: 'cleared' } })
    const auto = autoAmounts(state, people)
    expect(Object.fromEntries(auto)).toEqual({ pb: '22.50', pc: '22.50' })
    expect(amountInput(state, auto, 'pc')).toEqual({ value: '', placeholder: '22.50' })
    expect(toDraft(state, people).shares.map((s) => s.weight)).toEqual(['50', '22.50', '22.50'])
    expect(check(state, people).issues).toEqual([])
  })

  it('names the sum and the difference when amounts do not add up (P-EXP-82)', () => {
    const state = base({ splitMode: 'amount', weights: { pa: '50', pb: '30', pc: '10' }, edits: { pa: 'edited', pb: 'edited', pc: 'edited' } })
    expect(check(state, people).issues.find((i) => i.field === 'shares')?.message).toBe('The amounts add up to 90.00, 5.00 less than the expense amount (95.00).')
  })

  it('checks several payers against the amount', () => {
    const state = base({ payerMode: 'several', payerAmounts: { pa: '55', pb: '30' } })
    expect(check(state, people).issues.map((i) => i.message)).toEqual(['The payments add up to 85.00, 10.00 less than the expense amount (95.00).'])
    expect(check(base({ payerMode: 'several', payerAmounts: { pa: '55', pb: '40' } }), people).issues).toEqual([])
  })

  it('reopens a saved amount split exactly, including a skipped person (P-MONEY-86, P-MONEY-95)', () => {
    const state = stateFromExpense({
      participants: people,
      documents: [],
      expense: {
        kind: 'expense',
        title: 'Dinner',
        vendor: null,
        notes: '',
        categoryId: 0,
        expenseDate: '2026-11-01',
        currency: 'EUR',
        amount: '80.00',
        splitMode: 'amount',
        payers: [{ participantId: 'pa', amount: '80.00' }],
        shares: [
          { participantId: 'pa', weight: '5000' },
          { participantId: 'pb', weight: '3000' },
        ],
        recurrence: 'none',
      },
    })
    expect(state.selected).toEqual({ pa: true, pb: true, pc: false })
    expect(toDraft(state, people).shares).toEqual([
      { participantId: 'pa', weight: '50.00' },
      { participantId: 'pb', weight: '30.00' },
    ])
  })

  it("reads and writes v1's saved split defaults (P-EXP-93..95)", () => {
    saveSplitDefaults({ groupId: 'g', participants: people, state: base({ splitMode: 'shares', weights: { pa: '2', pb: '1', pc: '1' }, selected: { pa: true, pb: true, pc: false } }) })
    expect(JSON.parse(localStorage.getItem('g-defaultSplittingOptions-v2') ?? '')).toEqual({
      splitMode: 'BY_SHARES',
      paidFor: [
        { participant: 'pa', shares: '2' },
        { participant: 'pb', shares: '1' },
      ],
    })
    expect(loadSplitDefaults({ groupId: 'g', participants: people })).toMatchObject({ splitMode: 'shares', selected: { pa: true, pb: true, pc: false } })
    saveSplitDefaults({ groupId: 'g', participants: people, state: base({ splitMode: 'amount' }) })
    expect(loadSplitDefaults({ groupId: 'g', participants: people })).toMatchObject({ splitMode: 'amount', selected: { pa: true, pb: true, pc: true } })
    // An amount default names no one, so it stays when the people change.
    expect(loadSplitDefaults({ groupId: 'g', participants: ['pa'] }).splitMode).toBe('amount')
    // A default that names someone no longer in the group is dropped.
    localStorage.setItem('g-defaultSplittingOptions-v2', JSON.stringify({ splitMode: 'BY_SHARES', paidFor: [{ participant: 'gone', shares: '1' }] }))
    expect(loadSplitDefaults({ groupId: 'g', participants: people }).splitMode).toBe('evenly')
    expect(localStorage.getItem('g-defaultSplittingOptions-v2')).toBeNull()
  })
})
