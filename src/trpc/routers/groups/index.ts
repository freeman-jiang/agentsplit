import { createTRPCRouter } from '@/trpc/init'
import { activitiesRouter } from '@/trpc/routers/groups/activities'
import { groupBalancesRouter } from '@/trpc/routers/groups/balances'
import { createGroupProcedure } from '@/trpc/routers/groups/create.procedure'
import { groupExpensesRouter } from '@/trpc/routers/groups/expenses'
import { getGroupProcedure } from '@/trpc/routers/groups/get.procedure'
import { groupStatsRouter } from '@/trpc/routers/groups/stats'
import { updateGroupProcedure } from '@/trpc/routers/groups/update.procedure'
import { groupAccessProcedure } from './access.procedure'
import { exportGroupProcedure } from './export.procedure'
import { getGroupDetailsProcedure } from './getDetails.procedure'
import { listGroupsProcedure } from './list.procedure'
import { processRecurringProcedure } from './recurring.procedure'

export const groupsRouter = createTRPCRouter({
  access: groupAccessProcedure,
  processRecurring: processRecurringProcedure,
  export: exportGroupProcedure,
  expenses: groupExpensesRouter,
  balances: groupBalancesRouter,
  stats: groupStatsRouter,
  activities: activitiesRouter,

  get: getGroupProcedure,
  getDetails: getGroupDetailsProcedure,
  list: listGroupsProcedure,
  create: createGroupProcedure,
  update: updateGroupProcedure,
})
