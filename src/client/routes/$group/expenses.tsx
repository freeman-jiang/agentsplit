import { createFileRoute, Outlet } from '@tanstack/react-router'

export const Route = createFileRoute('/$group/expenses')({ component: Outlet })
