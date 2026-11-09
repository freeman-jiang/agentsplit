import { Check, CornerDownLeft } from 'lucide-react'
import { useEffect, useState } from 'react'
import { cn } from '~/client/cn'

// The landing page's example of an agent using AgentSplit: a request is typed,
// the agent calls the MCP tools in turn (their real names), and it answers.
// The data is made up. With reduced motion the finished exchange shows at once.

const REQUEST = 'Add dinner at Nopa, $84. I paid, split it with Sam and Alex.'

const STEPS = [
  { tool: 'list_groups', args: '', result: 'Roommates · You, Sam, Alex' },
  { tool: 'create_expense', args: '"Dinner at Nopa", $84.00, paid by you, split evenly', result: 'Saved' },
  { tool: 'get_balances', args: 'Roommates', result: 'Sam owes you $28.00 · Alex owes you $28.00' },
] as const

const REPLY = 'Done. Sam and Alex each owe you $28.'

/** Milliseconds per typed character, before the first step, between steps, and before the loop starts again. */
const TIMING = { char: 28, think: 500, step: 900, reply: 600, hold: 5000 }

type Frame = { typed: number; steps: number; reply: boolean }
const FINISHED: Frame = { typed: REQUEST.length, steps: STEPS.length, reply: true }

function useScript(): Frame {
  const [frame, setFrame] = useState<Frame>({ typed: 0, steps: 0, reply: false })
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setFrame(FINISHED)
      return
    }
    const timers: number[] = []
    const at = (ms: number, next: Frame) => timers.push(window.setTimeout(() => setFrame(next), ms))
    function play(start: number) {
      let t = start
      at(t, { typed: 0, steps: 0, reply: false })
      for (let i = 1; i <= REQUEST.length; i++) at((t += TIMING.char), { typed: i, steps: 0, reply: false })
      t += TIMING.think
      for (let s = 1; s <= STEPS.length; s++) at((t += s === 1 ? 0 : TIMING.step), { typed: REQUEST.length, steps: s, reply: false })
      at((t += TIMING.reply + TIMING.step), FINISHED)
      timers.push(window.setTimeout(() => play(0), t + TIMING.hold))
    }
    play(400)
    return () => timers.forEach((id) => window.clearTimeout(id))
  }, [])
  return frame
}

/** A made-up agent session that adds an expense through AgentSplit's MCP tools. */
export function AgentDemo() {
  const frame = useScript()
  const typing = frame.typed < REQUEST.length
  return (
    <figure aria-label="An agent adds an expense with AgentSplit" className="w-full max-w-lg rounded-2xl border bg-card text-left text-sm shadow-sm">
      <div className="flex items-center justify-between border-b px-4 py-2.5 text-xs text-muted-foreground">
        <span>Your agent</span>
        <span className="inline-flex items-center gap-1.5">
          <span className="size-1.5 rounded-full bg-owed" />
          AgentSplit connected
        </span>
      </div>
      <div className="space-y-3 p-4" aria-hidden="true">
        <div className="ml-auto w-fit max-w-[90%] rounded-2xl bg-secondary px-3.5 py-2">
          {REQUEST.slice(0, frame.typed)}
          {typing && <span className="ml-px inline-block h-4 w-px translate-y-0.5 animate-pulse bg-foreground" />}
          {/* The untyped rest keeps its space, so the card never changes size and the page never moves. */}
          <span className="invisible">{REQUEST.slice(frame.typed)}</span>
          {!typing && frame.steps === 0 && <CornerDownLeft className="ml-1.5 inline size-3.5 text-muted-foreground" />}
        </div>
        <ol className="space-y-2 font-mono text-xs">
          {STEPS.map((step, i) => {
            return (
              <li key={step.tool} className={cn('rounded-lg border px-3 py-2', i < frame.steps ? 'animate-fade-in' : 'invisible')}>
                <div className="flex items-center gap-2">
                  <Check className="size-3.5 shrink-0 text-owed" />
                  <span className="font-medium text-foreground">{step.tool}</span>
                  {step.args && <span className="truncate text-muted-foreground">{step.args}</span>}
                </div>
                <div className="mt-1 pl-5.5 text-muted-foreground">{step.result}</div>
              </li>
            )
          })}
        </ol>
        <p className={frame.reply ? 'animate-fade-in' : 'invisible'}>{REPLY}</p>
      </div>
    </figure>
  )
}
