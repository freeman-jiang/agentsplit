// A net balance is a decimal string: negative when the person owes, positive
// when they get money back.

type NetTone = 'zero' | 'owe' | 'owed'

export const isZero = (net: string) => !/[1-9]/.test(net)
export const magnitude = (net: string) => (net.startsWith('-') ? net.slice(1) : net)
export const netTone = (net: string): NetTone => (isZero(net) ? 'zero' : net.startsWith('-') ? 'owe' : 'owed')

/** The rail and the lists of people: zero is muted, a debt red, a credit green. */
export const NET_CLASS: Record<NetTone, string> = { zero: 'text-muted-foreground', owe: 'text-owe', owed: 'text-owed' }

const LABELS = {
  you: { zero: 'Settled up', owe: 'You owe', owed: 'You are owed' },
  them: { zero: 'Settled up', owe: 'owes', owed: 'gets back' },
} as const satisfies Record<string, Record<NetTone, string>>

/** "You owe" or "owes", "You are owed" or "gets back", or "Settled up". */
export const netLabel = (net: string, person: keyof typeof LABELS) => LABELS[person][netTone(net)]
