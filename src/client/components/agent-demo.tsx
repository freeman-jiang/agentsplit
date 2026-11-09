import { ArrowUp, Check, LoaderCircle } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { cn } from '~/client/cn'

// The landing page's example of an agent using AgentSplit: a chat that never
// ends. Each turn types a request into the input, sends it, thinks, calls the
// MCP tools (their real names), and streams the answer. Older messages scroll
// off the top. The people and amounts are made up. With reduced motion the
// first two turns show finished and nothing moves.

type Turn = {
  readonly ask: string
  readonly tools: ReadonlyArray<{ readonly name: string; readonly args: string; readonly result: string }>
  readonly answer: string
}

const TURNS: ReadonlyArray<Turn> = [
  {
    ask: 'Add dinner at Nopa, $84. I paid, split it with Sam and Alex.',
    tools: [
      { name: 'list_groups', args: '', result: 'Roommates · You, Sam, Alex' },
      { name: 'create_expense', args: 'Dinner at Nopa · $84.00 · split evenly', result: 'Saved to Roommates' },
    ],
    answer: 'Added Dinner at Nopa for $84.00. Sam and Alex each owe you $28.00.',
  },
  {
    ask: 'How much did we spend on groceries this month?',
    tools: [{ name: 'get_spending_stats', args: 'Roommates · November', result: 'Groceries · 4 expenses · $212.40' }],
    answer: '$212.40 across 4 grocery runs. The biggest was Trader Joe’s on Nov 6, at $86.10.',
  },
  {
    ask: 'Who added the internet bill, and when?',
    tools: [
      { name: 'list_expenses', args: '"internet"', result: 'Internet · $60.00 · Nov 2' },
      { name: 'list_activity', args: 'Internet', result: '2 changes' },
    ],
    answer: 'Sam added it on Nov 2 at 9:14 PM, through ChatGPT. Alex changed the split to even on Nov 3.',
  },
  {
    ask: 'Who owes what right now?',
    tools: [{ name: 'get_balances', args: 'Roommates', result: 'Sam −$40.20 · Alex −$15.60 · You +$55.80' }],
    answer: 'Sam owes you $40.20 and Alex owes you $15.60. Two payments settle everything.',
  },
]

/** Milliseconds: per typed character, per streamed word, and the pauses between the steps of a turn. */
const PACE = { char: 32, word: 55, send: 350, think: 1000, tool: 750, between: 200, hold: 1800 }

type Item =
  | { readonly kind: 'ask'; readonly id: number; readonly text: string }
  | { readonly kind: 'thinking'; readonly id: number }
  | { readonly kind: 'tool'; readonly id: number; readonly name: string; readonly args: string; readonly result: string; readonly done: boolean }
  | { readonly kind: 'answer'; readonly id: number; readonly text: string; readonly words: number }

type Chat = { readonly input: string; readonly items: ReadonlyArray<Item> }

/** Items past this many have long scrolled out of view. */
const KEEP = 16

/** The finished turns, for reduced motion. */
function finished(turns: ReadonlyArray<Turn>): Chat {
  let id = 0
  const items: Item[] = []
  for (const turn of turns) {
    items.push({ kind: 'ask', id: id++, text: turn.ask })
    for (const tool of turn.tools) items.push({ kind: 'tool', id: id++, ...tool, done: true })
    items.push({ kind: 'answer', id: id++, text: turn.answer, words: Number.POSITIVE_INFINITY })
  }
  return { input: '', items }
}

/** The rejection of a pause after the demo unmounts. */
const STOPPED = Symbol('stopped')

function usePlayer(): Chat {
  const [chat, setChat] = useState<Chat>({ input: '', items: [] })
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setChat(finished(TURNS.slice(0, 2)))
      return
    }
    let stopped = false
    const timers = new Set<number>()
    const wait = (ms: number) =>
      new Promise<void>((resolve, reject) => {
        const timer = window.setTimeout(() => {
          timers.delete(timer)
          if (stopped) reject(STOPPED)
          else resolve()
        }, ms)
        timers.add(timer)
      })
    const update = (f: (chat: Chat) => Chat) => setChat((chat) => f(chat))
    const add = (item: Item) => update((chat) => ({ ...chat, items: [...chat.items, item].slice(-KEEP) }))
    const replace = (id: number, f: (item: Item) => Item | null) =>
      update((chat) => ({ ...chat, items: chat.items.flatMap((item) => (item.id === id ? (f(item) ?? []) : [item])) }))

    async function play() {
      let id = 0
      for (let n = 0; ; n++) {
        const turn = TURNS[n % TURNS.length]
        if (!turn) return
        for (let i = 1; i <= turn.ask.length; i++) {
          update((chat) => ({ ...chat, input: turn.ask.slice(0, i) }))
          await wait(PACE.char)
        }
        await wait(PACE.send)
        update((chat) => ({ ...chat, input: '' }))
        add({ kind: 'ask', id: id++, text: turn.ask })
        const thinking = id++
        add({ kind: 'thinking', id: thinking })
        await wait(PACE.think)
        replace(thinking, () => null)
        for (const tool of turn.tools) {
          const call = id++
          add({ kind: 'tool', id: call, ...tool, done: false })
          await wait(PACE.tool)
          replace(call, (item) => (item.kind === 'tool' ? { ...item, done: true } : item))
          await wait(PACE.between)
        }
        const answer = id++
        const words = turn.answer.split(' ').length
        add({ kind: 'answer', id: answer, text: turn.answer, words: 0 })
        for (let w = 1; w <= words; w++) {
          await wait(PACE.word)
          replace(answer, (item) => (item.kind === 'answer' ? { ...item, words: w } : item))
        }
        await wait(PACE.hold)
      }
    }
    play().catch((error: unknown) => {
      if (error !== STOPPED) throw error
    })
    return () => {
      stopped = true
      timers.forEach((timer) => window.clearTimeout(timer))
    }
  }, [])
  return chat
}

function Row({ item }: { item: Item }) {
  switch (item.kind) {
    case 'ask':
      return <div className="ml-auto w-fit max-w-[85%] animate-fade-in rounded-2xl bg-secondary px-3.5 py-2">{item.text}</div>
    case 'thinking':
      return <div className="w-fit animate-fade-in text-shimmer">Thinking</div>
    case 'tool':
      return (
        <div className="animate-fade-in font-mono text-xs">
          <div className="flex items-center gap-2">
            {item.done ? (
              <Check className="size-3.5 shrink-0 text-owed" />
            ) : (
              <LoaderCircle className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
            )}
            <span className="font-medium">{item.name}</span>
            {item.args && <span className="truncate text-muted-foreground">{item.args}</span>}
          </div>
          <div className={cn('mt-0.5 pl-5.5 text-muted-foreground transition-opacity duration-200', !item.done && 'opacity-0')}>{item.result}</div>
        </div>
      )
    case 'answer': {
      const all = item.text.split(' ')
      const streaming = item.words < all.length
      return (
        <p className="animate-fade-in">
          {all.slice(0, item.words).join(' ')}
          {streaming && <span className="ml-0.5 inline-block size-2 translate-y-[-1px] rounded-full bg-foreground align-middle" />}
        </p>
      )
    }
  }
}

/** A made-up chat in which an agent works with AgentSplit's MCP tools. */
export function AgentDemo() {
  const chat = usePlayer()
  // A long request scrolls the input, as a real one does, so the newest letters stay in view.
  const input = useRef<HTMLSpanElement>(null)
  useLayoutEffect(() => {
    if (input.current) input.current.scrollLeft = input.current.scrollWidth
  }, [chat.input])
  return (
    <figure aria-label="An agent adds and looks up shared expenses with AgentSplit" className="w-full max-w-lg overflow-hidden rounded-2xl border bg-card text-left text-sm shadow-sm">
      <div className="flex items-center justify-between border-b px-4 py-2.5 text-xs text-muted-foreground">
        <span>Your agent</span>
        <span className="inline-flex items-center gap-1.5">
          <span className="size-1.5 rounded-full bg-owed" />
          AgentSplit connected
        </span>
      </div>
      <div aria-hidden="true" className="relative h-80 overflow-hidden sm:h-96">
        <div className="absolute inset-x-0 bottom-0 flex flex-col gap-3 p-4">
          {chat.items.map((item) => (
            <Row key={item.id} item={item} />
          ))}
        </div>
        <div className="pointer-events-none absolute inset-x-0 top-0 h-16 bg-gradient-to-b from-card to-transparent" />
      </div>
      <div aria-hidden="true" className="border-t p-3">
        <div className="flex items-center gap-2 rounded-full border bg-background py-1.5 pr-1.5 pl-4">
          <span ref={input} className={cn('min-w-0 flex-1 overflow-hidden whitespace-nowrap', !chat.input && 'text-muted-foreground')}>
            {chat.input || 'Message your agent'}
            {chat.input && <span className="ml-px inline-block h-4 w-px translate-y-0.5 animate-pulse bg-foreground" />}
          </span>
          <span
            className={cn(
              'flex size-7 shrink-0 items-center justify-center rounded-full transition-colors duration-200',
              chat.input ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground',
            )}
          >
            <ArrowUp className="size-4" />
          </span>
        </div>
      </div>
    </figure>
  )
}
