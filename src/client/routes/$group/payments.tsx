import { createFileRoute, Outlet } from '@tanstack/react-router'

// The payment list, create and edit screens share the group layout.
export const Route = createFileRoute('/$group/payments')({ component: Outlet })
