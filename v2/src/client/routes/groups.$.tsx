import { createFileRoute, redirect } from '@tanstack/react-router'

// Old group URLs keep working: /groups/<id>/<tab> opens /<id>/<tab>, which
// then moves to the group's slug if it has one (P-GROUP-45, P-GROUP-100).
export const Route = createFileRoute('/groups/$')({
  beforeLoad: ({ params, location }) => {
    const [groupId, ...rest] = (params._splat ?? '').split('/')
    if (!groupId) throw redirect({ to: '/groups', replace: true })
    throw redirect({ href: `/${encodeURIComponent(groupId)}/${rest.join('/') || 'expenses'}${location.searchStr}${location.hash ? `#${location.hash}` : ''}`, replace: true })
  },
})
