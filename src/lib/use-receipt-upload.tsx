'use client'

import { useParams } from 'next/navigation'
import { useRef } from 'react'

export function useReceiptUpload() {
  const input = useRef<HTMLInputElement>(null)
  const { groupId } = useParams<{ groupId: string }>()
  async function uploadToS3(file: File) {
    const form = new FormData()
    form.set('groupId', groupId)
    form.set('file', file)
    const response = await fetch('/api/receipts', {
      method: 'POST',
      body: form,
    })
    if (!response.ok) throw new Error('Receipt upload failed')
    return (await response.json()) as {
      url: string
      id: string
      width: number
      height: number
    }
  }
  return {
    uploadToS3,
    inputRef: input,
    openFileDialog: () => input.current?.click(),
  }
}
export function ReceiptFileInput({
  onChange,
  accept,
  inputRef,
}: {
  onChange: (file: File) => void
  accept: string
  inputRef: React.RefObject<HTMLInputElement | null>
}) {
  return (
    <input
      ref={inputRef}
      type="file"
      accept={accept}
      hidden
      onChange={(e) => {
        const file = e.target.files?.[0]
        if (file) onChange(file)
        e.target.value = ''
      }}
    />
  )
}
