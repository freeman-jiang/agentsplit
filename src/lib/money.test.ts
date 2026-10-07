import { Prisma } from '@/generated/prisma/browser'
import { getCurrency } from './currency'
import { add, decimalStrings, decimalStringSchema, subtract } from './money'
import { formatCurrency } from './utils'

describe('exact decimal money', () => {
  it('adds and subtracts without binary floating point residue', () => {
    expect(add('0.1', '0.2')).toBe('0.3')
    expect(subtract('0.3', '0.2')).toBe('0.1')
    expect(add('9007199254740993.01', '0.02')).toBe('9007199254740993.03')
  })

  it('normalizes valid decimal text without changing its value', () => {
    expect(decimalStringSchema.parse('12.3400')).toBe('12.34')
    expect(decimalStringSchema.parse('-0.000')).toBe('0')
    expect(decimalStringSchema.parse('-12.34')).toBe('-12.34')
  })

  it('rejects values that would be rounded by the database', () => {
    expect(decimalStringSchema.safeParse('0.1234567890123').success).toBe(false)
    expect(decimalStringSchema.safeParse('1000000000000000000').success).toBe(
      false,
    )
    expect(decimalStringSchema.parse('999999999999999999.999999999999')).toBe(
      '999999999999999999.999999999999',
    )
  })

  it('serializes Prisma decimals recursively and preserves dates', () => {
    const date = new Date('2026-09-30T00:00:00Z')
    const wire = decimalStrings({
      date,
      nullable: null,
      expenses: [
        {
          amount: new Prisma.Decimal('6000.01'),
          shares: new Prisma.Decimal('33.33'),
        },
      ],
    })
    expect(wire).toEqual({
      date,
      nullable: null,
      expenses: [{ amount: '6000.01', shares: '33.33' }],
    })
    expect(wire.date).toBe(date)
  })

  it('formats the same face value without scaling it by currency', () => {
    expect(formatCurrency(getCurrency('USD'), '6000', 'en-US')).toBe(
      '$6,000.00',
    )
    expect(formatCurrency(getCurrency('JPY'), '6000', 'en-US')).toBe('¥6,000')
    expect(
      formatCurrency(getCurrency('USD'), '9007199254740993.01', 'en-US'),
    ).toBe('$9,007,199,254,740,993.01')
  })
})
