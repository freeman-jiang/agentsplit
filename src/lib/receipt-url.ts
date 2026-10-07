/** Keep durable storage pointers in the ledger; fetch bytes through authorization. */
export function receiptDownloadUrl(groupId: string, url: string, baseUrl = '') {
  return `${baseUrl}/api/receipts?${new URLSearchParams({ groupId, url })}`
}
