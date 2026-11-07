// Generated from the current app's src/lib/currency-data.json (en-US).
// Every money value is an integer count of minor units; `decimals` is the exponent.

export const CURRENCIES = {
  AUD: { decimals: 2, symbol: "AU$", name: "Australian Dollar" },
  BGN: { decimals: 2, symbol: "BGN", name: "Bulgarian Lev" },
  BRL: { decimals: 2, symbol: "R$", name: "Brazilian Real" },
  CAD: { decimals: 2, symbol: "CA$", name: "Canadian Dollar" },
  CHF: { decimals: 2, symbol: "CHF", name: "Swiss Franc" },
  CNY: { decimals: 2, symbol: "CN¥", name: "Chinese Yuan" },
  COP: { decimals: 0, symbol: "CO$", name: "Colombian Peso" },
  CZK: { decimals: 2, symbol: "Kč", name: "Czech Koruna" },
  DKK: { decimals: 2, symbol: "Dkr", name: "Danish Krone" },
  EUR: { decimals: 2, symbol: "€", name: "Euro" },
  GBP: { decimals: 2, symbol: "£", name: "British Pound" },
  HKD: { decimals: 2, symbol: "HK$", name: "Hong Kong Dollar" },
  HUF: { decimals: 0, symbol: "Ft", name: "Hungarian Forint" },
  IDR: { decimals: 0, symbol: "Rp", name: "Indonesian Rupiah" },
  ILS: { decimals: 2, symbol: "₪", name: "Israeli New Shekel" },
  INR: { decimals: 2, symbol: "Rs", name: "Indian Rupee" },
  ISK: { decimals: 0, symbol: "Ikr", name: "Icelandic Króna" },
  JPY: { decimals: 0, symbol: "¥", name: "Japanese Yen" },
  KRW: { decimals: 0, symbol: "₩", name: "South Korean Won" },
  MKD: { decimals: 2, symbol: "MKD", name: "Macedonian Denar" },
  MXN: { decimals: 2, symbol: "MX$", name: "Mexican Peso" },
  MYR: { decimals: 2, symbol: "RM", name: "Malaysian Ringgit" },
  NOK: { decimals: 2, symbol: "Nkr", name: "Norwegian Krone" },
  NZD: { decimals: 2, symbol: "NZ$", name: "New Zealand Dollar" },
  PHP: { decimals: 2, symbol: "₱", name: "Philippine Peso" },
  PLN: { decimals: 2, symbol: "zł", name: "Polish Zloty" },
  RON: { decimals: 2, symbol: "RON", name: "Romanian Leu" },
  SEK: { decimals: 2, symbol: "Skr", name: "Swedish Krona" },
  SGD: { decimals: 2, symbol: "S$", name: "Singapore Dollar" },
  THB: { decimals: 2, symbol: "฿", name: "Thai Baht" },
  TRY: { decimals: 2, symbol: "TL", name: "Turkish Lira" },
  USD: { decimals: 2, symbol: "$", name: "US Dollar" },
  VND: { decimals: 0, symbol: "₫", name: "Vietnamese Dong" },
  ZAR: { decimals: 2, symbol: "R", name: "South African Rand" },
} as const satisfies Record<string, { decimals: 0 | 2; symbol: string; name: string }>

export type CurrencyCode = keyof typeof CURRENCIES

export const CURRENCY_CODES = Object.keys(CURRENCIES) as [CurrencyCode, ...CurrencyCode[]]

export const isCurrencyCode = (code: string): code is CurrencyCode => Object.hasOwn(CURRENCIES, code)
