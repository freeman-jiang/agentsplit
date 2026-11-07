// The current app's group URLs (P-GROUP-98, P-GROUP-100), mapped onto the
// router's /$group routes. The server sends the redirects
// (src/server/group-urls.ts); this map only keeps each URL as it is.
import type { LocationRewrite } from '@tanstack/react-router'
import { isIdSegment, normalizeSlug, slugProblem } from '~/shared/groups'

export const groupUrls: LocationRewrite = {
  /** From the address bar to the routes. */
  input: ({ url }) => {
    const [, first, second, ...rest] = url.pathname.split('/')
    // A group without a slug lives at /groups/<id>/…; /groups/create is the create screen.
    if (first === 'groups' && second && second !== 'create') {
      url.pathname = `/${[second, ...rest].join('/')}`
      return url
    }
    // /<slug> alone shows the group's expenses, and the address bar keeps /<slug>, as in the current app.
    if (first && second === undefined && slugProblem(normalizeSlug(first)) === null) {
      url.pathname = `/${first}/expenses`
      return url
    }
    return undefined
  },
  /** From the routes to the address bar and to each link. */
  output: ({ url }) => {
    const [, first = ''] = url.pathname.split('/')
    if (!isIdSegment(first)) return undefined
    url.pathname = `/groups${url.pathname}`
    return url
  },
}
