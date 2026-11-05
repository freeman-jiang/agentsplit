import { createFileRoute, Outlet } from '@tanstack/react-router'

// The list, create and edit screens of a group's expenses share the group layout.
export const Route = createFileRoute('/$group/expenses')({ component: Outlet })
