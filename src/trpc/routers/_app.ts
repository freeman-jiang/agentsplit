import { categoriesRouter } from '@/trpc/routers/categories'
import { groupsRouter } from '@/trpc/routers/groups'
import { inferRouterOutputs } from '@trpc/server'
import { createTRPCRouter } from '../init'
import { expensesRouter } from './expenses'
import { profileRouter } from './profile'
import { referenceRouter } from './reference'

export const appRouter = createTRPCRouter({
  reference: referenceRouter,
  expenses: expensesRouter,
  profile: profileRouter,
  groups: groupsRouter,
  categories: categoriesRouter,
})

export type AppRouter = typeof appRouter
export type AppRouterOutput = inferRouterOutputs<AppRouter>
