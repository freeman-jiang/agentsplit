export async function POST() {
  return Response.json({ error: 'Expense uploads are disabled' }, { status: 403 })
}
