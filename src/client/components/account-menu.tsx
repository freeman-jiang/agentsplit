import { Link } from '@tanstack/react-router'

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

/** The first user-perceived character of a word, so an emoji or a combined letter stays whole. */
const firstGrapheme = (word: string) => graphemes.segment(word)[Symbol.iterator]().next().value?.segment ?? ''

/**
 * Up to two initials, from the first and the last word. Words with a letter
 * come first, so "👩🏽‍💻 Priya Rao" gives "PR"; a name of only emoji keeps them.
 */
function initialsOf(name: string) {
  const all = name.trim().split(/\s+/).filter(Boolean)
  const lettered = all.filter((word) => /\p{L}/u.test(word))
  const words = lettered.length > 0 ? lettered : all
  const first = words[0] === undefined ? '' : firstGrapheme(words[0])
  const last = words.length > 1 ? firstGrapheme(words.at(-1) ?? '') : ''
  return (first + last).toLocaleUpperCase()
}

/** Local initials keep the avatar independent of third-party image requests. */
export function AccountMenu({ name }: { name: string }) {
  const initials = initialsOf(name) || 'U'
  return (
    <Link
      to="/settings"
      aria-label="Account"
      title={`${name || 'Your account'} · Account`}
      className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-primary/25 bg-primary/10 text-sm font-medium text-primary press hover:bg-primary/20 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background focus-visible:outline-none"
    >
      <span aria-hidden="true">{initials}</span>
    </Link>
  )
}
