import { useState, type ReactNode } from 'react'
import { Alert, AlertDescription } from '~/client/ui/alert'
import { Button } from '~/client/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '~/client/ui/card'
import { Input } from '~/client/ui/input'
import { Label } from '~/client/ui/label'
import { NativeSelect } from '~/client/ui/native-select'
import { Textarea } from '~/client/ui/textarea'
import { normalizeSlug, slugProblem } from '~/shared/api'
import { CURRENCIES, type CurrencyCode } from '~/shared/currencies'

export type GroupFormValues = { name: string; slug: string; information: string; defaultCurrency: CurrencyCode }

const CODES = Object.keys(CURRENCIES).sort() as CurrencyCode[]

/** The problem with each field, checked as the server checks it, so the form can say so before saving. */
function problems(values: GroupFormValues) {
  const name = values.name.trim()
  const slug = normalizeSlug(values.slug)
  return {
    name: name.length < 2 ? 'Enter at least 2 characters.' : name.length > 50 ? 'Enter at most 50 characters.' : null,
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
          setError(e instanceof Error ? e.message : String(e))
        } finally {
          setSaving(false)
        }
      }}
    >
      <Card className="mb-4">
        <CardHeader>
          <CardTitle>Group information</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-2 [&>*]:min-w-0">
          <div className="space-y-2">
            <Label htmlFor="group-name">Group name</Label>
            <Input
              id="group-name"
              className="text-base"
              placeholder="Summer vacations"
              maxLength={50}
              value={values.name}
              aria-invalid={touched && !!issues.name}
              aria-describedby="group-name-help"
              onChange={(e) => set('name', e.target.value)}
            />
            <p id="group-name-help" className="text-sm text-muted-foreground">
              Enter a name for your group.
            </p>
            {fieldError(issues.name, 'group-name-error')}
          </div>
          <div className="space-y-2">
            <Label htmlFor="group-slug">Custom URL (optional)</Label>
            <Input
              id="group-slug"
              className="text-base"
              placeholder="macademia"
              autoCapitalize="none"
              autoCorrect="off"
              maxLength={63}
              value={values.slug}
              aria-invalid={touched && !!issues.slug}
              aria-describedby="group-slug-help"
              onChange={(e) => set('slug', e.target.value)}
            />
            <p id="group-slug-help" className="text-sm text-muted-foreground">
              Use /{normalizeSlug(values.slug) || 'your-group'} to open this group. Members still need to sign in.
            </p>
            {fieldError(issues.slug, 'group-slug-error')}
          </div>
          <div className="space-y-2">
            <Label htmlFor="group-currency">Default currency</Label>
            <NativeSelect
              id="group-currency"
              value={values.defaultCurrency}
              aria-describedby="group-currency-help"
              onChange={(e) => set('defaultCurrency', e.target.value as CurrencyCode)}
            >
              {CODES.map((code) => (
                <option key={code} value={code}>
                  {code} · {CURRENCIES[code].name}
                </option>
              ))}
            </NativeSelect>
            <p id="group-currency-help" className="text-sm text-muted-foreground">
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
              className="text-base"
              maxLength={10_000}
              placeholder="What information is relevant to group participants?"
              value={values.information}
              onChange={(e) => set('information', e.target.value)}
            />
          </div>
        </CardContent>
      </Card>
      {props.children}
      {error && (
        <Alert variant="destructive" className="mb-4">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <div className="mt-4 flex gap-2">
        <Button type="submit" disabled={saving}>
          {props.mode === 'edit' ? (saving ? 'Saving…' : 'Save') : saving ? 'Creating…' : 'Create'}
        </Button>
        {props.cancel}
      </div>
    </form>
  )
}
