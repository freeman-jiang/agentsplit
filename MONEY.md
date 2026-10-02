# AgentSplit monetary representation

Expense amounts, monetary splits, balances, repayments and statistical totals
use decimal strings at face value in API/MCP JSON. Each expense has an explicit
`currencyCode` from the locally supported currency catalog. The group currency
is a default for new expenses; changing it does not change existing expenses.
There are no exchange-rate lookups or conversions in expense operations.

```json
{ "amount": "6000", "currencyCode": "USD" }
```

This represents USD 6000. The same amount with `"JPY"` represents JPY 6000.
The form holds ordinary typed decimal text and submits it directly; the browser
does not multiply money by 100. Percentage splits likewise use `"33.33"` for
33.33%, not a scaled integer. Share weights use strings such as `"1"` and `"2"`.

The shared Zod schema validates writes before any database operation. Numeric
JSON values, whitespace, exponents, leading plus signs, leading zeroes, grouping
separators, hexadecimal, incomplete decimals, non-finite values and unknown
currencies are rejected. A leading minus represents income. Valid trailing
zeroes are normalized without rounding. Expense amounts must be nonzero and
have an absolute value no greater than 10 million.

Database money and share fields use PostgreSQL `NUMERIC(30,12)`. Parsing rejects
text beyond its 18 integer / 12 fraction digit limits before the database can
round it. Decimal arithmetic uses an isolated 64-digit configuration of the
existing decimal library; monetary JSON never passes through `Number`.
Number conversions used by charts calculate layout ratios only. Formatting
passes exact strings to the standard Intl formatter.

Explicit monetary shares must sum exactly to the expense amount and have the
same sign. Percentage shares must sum exactly to 100. Beneficiary IDs must be
unique. UI and tRPC calls share the same backend validation and splitter.

Expense amounts and explicit monetary shares must use the currency's normal
precision (USD: two decimal places; JPY: whole numbers). Finer values are rejected,
not rounded on input. When a calculated split has leftover units, the participant
selected in **Paid by** receives the first one if they are a beneficiary. Remaining
units follow largest fractional remainder, with stable participant-ID ties. A
person receives at most one extra unit. If the payer is not a beneficiary, ordinary
largest-remainder allocation applies. Income uses the same rule on absolute values
and then restores the negative sign. Explicit monetary shares are unchanged.

## Disposable beta ledger reset

The currency/decimal schema deployment resets existing expense, revision and
dependent attachment-reference rows, as explicitly authorized for this unused
beta. It preserves groups, participants, categories, credentials and physical
attachment objects. The setup SQL remains versioned so fresh installations and
deployments reproduce the same schema; there is no old-money conversion or
history-preservation migration.

## Verification

`bun run test` includes parsing, exact arithmetic, serialization, formatting,
split conservation, settlement, statistics, and authenticated MCP tests in two
time zones. `bun run test:integration:audit` exercises real PostgreSQL write
transactions, revision guards, concurrency, and currency operations. The latter
requires a dedicated loopback database whose name ends in `_audit_test` and
never runs against the deployed database.
