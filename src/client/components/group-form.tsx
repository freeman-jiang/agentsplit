import { useState, type ReactNode } from 'react'
import { describeError } from '~/client/errors'
import { Alert, AlertDescription } from '~/client/ui/alert'
import { Button } from '~/client/ui/button'
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '~/client/ui/card'
import { Input } from '~/client/ui/input'
import { Label } from '~/client/ui/label'
import { CurrencySelect } from '~/client/ui/currency-select'
import { Textarea } from '~/client/ui/textarea'
import type { CurrencyCode } from '~/shared/currencies'
import { normalizeSlug, slugProblem } from '~/shared/groups'
import { LIMITS } from '~/shared/limits'

type GroupFormValues = { name: string; slug: string; information: string; defaultCurrency: CurrencyCode }

/** The problem with each field, checked as the server checks it, so the form can say so before saving. */
function problems(values: GroupFormValues) {
  const name = values.name.trim()
  const slug = normalizeSlug(values.slug)
  return {
    name:
      name.length < LIMITS.groupNameMin
        ? `Enter at least ${LIMITS.groupNameMin} characters.`
        : name.length > LIMITS.nameMax
          ? `Enter at most ${LIMITS.nameMax} characters.`
          : null,
    slug: slug ? slugProblem(slug) : null,
  }
}

/**
 * The group information card of the create form and the Settings tab: name,
 * custom URL, default currency and information. Ported from the current
 * app's GroupForm, without the custom currency symbol: v2 has only the
 * registered currencies.
 */
export function GroupForm(props: {
  initial: GroupFormValues
  mode: 'create' | 'edit'
  /** Extra cards between the information card and the buttons, such as participants. */
  children?: ReactNode
  cancel?: ReactNode
  onSubmit: (values: GroupFormValues) => Promise<void>
}) {
  const [values, setValues] = useState(props.initial)
  const [touched, setTouched] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const issues = problems(values)
  const set = <K extends keyof GroupFormValues>(key: K, value: GroupFormValues[K]) => setValues((v) => ({ ...v, [key]: value }))
  const fieldError = (message: string | null, id: string) =>
    touched && message ? (
      <p id={id} className="text-sm text-destructive">
        {message}
      </p>
    ) : null

  const alert = error && (
    <Alert variant="destructive">
      <AlertDescription>{error}</AlertDescription>
    </Alert>
  )
  const actions = (
    <>
      <Button type="submit" disabled={saving}>
        {props.mode === 'edit' ? (saving ? 'Saving…' : 'Save') : saving ? 'Creating…' : 'Create'}
      </Button>
      {props.cancel}
    </>
  )

  return (
    <form
      noValidate
      onSubmit={async (event) => {
        event.preventDefault()
        setTouched(true)
        if (issues.name || issues.slug) return
        setSaving(true)
        setError(null)
        try {
          await props.onSubmit({ ...values, name: values.name.trim() })
        } catch (e) {
          setError(describeError(e).message)
        } finally {
          setSaving(false)
        }
      }}
    >
      <Card className={props.mode === 'create' ? 'mb-4' : undefined}>
        <CardHeader>
          <CardTitle>Group information</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-2 [&>*]:min-w-0">
          <div className="space-y-2">
            <Label htmlFor="group-name">Group name</Label>
            <Input
              id="group-name"
              className="h-11"
              placeholder="Summer vacations"
              maxLength={LIMITS.nameMax}
              value={values.name}
              aria-invalid={touched && !!issues.name}
              aria-describedby="group-name-help"
              onChange={(e) => set('name', e.target.value)}
            />
            <p id="group-name-help" className="text-xs text-muted-foreground">
              Enter a name for your group.
            </p>
            {fieldError(issues.name, 'group-name-error')}
          </div>
          <div className="space-y-2">
            <Label htmlFor="group-slug">Custom URL (optional)</Label>
            <Input
              id="group-slug"
              className="h-11"
              placeholder="maple"
              autoCapitalize="none"
              autoCorrect="off"
              maxLength={LIMITS.slugMax}
              value={values.slug}
              aria-invalid={touched && !!issues.slug}
              aria-describedby="group-slug-help"
              onChange={(e) => set('slug', e.target.value)}
            />
            <p id="group-slug-help" className="text-xs text-muted-foreground">
              Use /{normalizeSlug(values.slug) || 'your-group'} to open this group. Members still need to sign in.
            </p>
            {fieldError(issues.slug, 'group-slug-error')}
          </div>
          <div className="space-y-2">
            <Label htmlFor="group-currency">Default currency</Label>
            <CurrencySelect
              id="group-currency"
              className="h-11"
              value={values.defaultCurrency}
              aria-describedby="group-currency-help"
              onChange={(currency) => set('defaultCurrency', currency)}
            />
            <p id="group-currency-help" className="text-xs text-muted-foreground">
              {props.mode === 'edit'
                ? 'Changes the default for new expenses only. Existing amounts, currencies and balances stay unchanged.'
                : 'The starting currency for new expenses. Each expense can use a different currency.'}
            </p>
          </div>
          <div className="col-span-full space-y-2">
            <Label htmlFor="group-information">Group information</Label>
            <Textarea
              id="group-information"
              rows={2}
              maxLength={LIMITS.informationMax}
              placeholder="What information is relevant to group participants?"
              value={values.information}
              onChange={(e) => set('information', e.target.value)}
            />
          </div>
        </CardContent>
        {/* On Settings the card saves itself, so Save sits in its footer. */}
        {props.mode === 'edit' && (
          <CardFooter className="flex-col items-stretch gap-4 border-t py-4">
            {alert}
            <div className="flex justify-end gap-2">{actions}</div>
          </CardFooter>
        )}
      </Card>
      {props.children}
      {props.mode === 'create' && (
        <>
          {alert && <div className="mb-4">{alert}</div>}
          <div className="mt-4 flex gap-2">{actions}</div>
        </>
      )}
    </form>
  )
}
