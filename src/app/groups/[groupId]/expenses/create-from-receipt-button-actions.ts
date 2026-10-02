'use server'

import { getCategories } from '@/lib/api'
import { env } from '@/lib/env'
import { getRuntimeFeatureFlags } from '@/lib/featureFlags'
import { DECIMAL_PATTERN, decimalStringSchema } from '@/lib/money'
import { getOpenAIClient } from '@/lib/openai'
import { prisma } from '@/lib/prisma'
import { readReceipt } from '@/lib/receipt-storage'
import { requireWebGroup } from '@/lib/session'
import { isAllowedUploadUrl } from '@/lib/uploaded-image-url'
import { formatCategoryForAIPrompt } from '@/lib/utils'
import { z } from 'zod'

// The model is contractually bound to this shape by `strict: true` below, but
// the response is still parsed rather than trusted: a self-hosted or older
// endpoint may ignore the schema.
const receiptResponseSchema = z.strictObject({
  amount: decimalStringSchema,
  categoryId: z.string(),
  date: z.string(),
  title: z.string(),
})

export async function extractExpenseInformationFromImage(
  imageUrl: string,
  groupId: string,
) {
  'use server'

  // Enforce the feature flag server-side: the UI gate only hides the button, it
  // does not prevent the action endpoint from being invoked directly.
  const { enableReceiptExtract } = await getRuntimeFeatureFlags()
  if (!enableReceiptExtract) {
    throw new Error('Receipt extraction is not enabled.')
  }

  // Only extract from images the app itself uploaded. Without this, an arbitrary
  // caller-supplied URL is forwarded to the model, enabling SSRF-via-OpenAI and
  // unbounded API spend.
  if (!isAllowedUploadUrl(imageUrl)) {
    throw new Error('Invalid image URL.')
  }

  await requireWebGroup(groupId)
  if (
    !(await prisma.receiptObject.findUnique({
      where: { groupId_url: { groupId, url: imageUrl } },
    }))
  )
    throw new Error('Receipt not found')
  const object = await readReceipt(imageUrl)
  const imageBytes = await object.Body?.transformToByteArray()
  if (!imageBytes) throw new Error('Receipt unavailable')
  imageUrl = `data:${object.ContentType};base64,${Buffer.from(imageBytes).toString('base64')}`
  const categories = await getCategories()
  const openai = getOpenAIClient()

  const completion = await openai.chat.completions.create({
    model: env.OPENAI_MODEL_RECEIPT_EXTRACT,
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'receipt_response',
        strict: true,
        schema: {
          type: 'object',
          properties: {
            amount: { type: 'string', pattern: DECIMAL_PATTERN.source },
            categoryId: { type: 'string' },
            date: { type: 'string' },
            title: { type: 'string' },
          },
          required: ['amount', 'categoryId', 'date', 'title'],
          additionalProperties: false,
        },
      },
    },
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: `
              This image contains a receipt.
              Read the total amount and store it as an exact decimal string, such as "12.34", without grouping separators or currency symbols.
              Then guess the category for this receipt among the following categories and store its ID: ${categories.map(
                (category) => formatCategoryForAIPrompt(category),
              )}.
              Guess the expense’s date and store it as yyyy-mm-dd.
              Guess a title for the expense.`,
          },
        ],
      },
      {
        role: 'user',
        content: [{ type: 'image_url', image_url: { url: imageUrl } }],
      },
    ],
  })

  const messageContent = completion.choices.at(0)?.message.content
  const parsed = (() => {
    if (!messageContent) return null
    try {
      return receiptResponseSchema.parse(JSON.parse(messageContent))
    } catch {
      // Malformed or schema-violating output: report "nothing extracted"
      // rather than passing junk on to the expense form.
      return null
    }
  })()

  return {
    amount: parsed?.amount ?? null,
    categoryId: parsed?.categoryId ?? null,
    date: parsed?.date ?? null,
    title: parsed?.title ?? null,
  }
}

export type ReceiptExtractedInfo = Awaited<
  ReturnType<typeof extractExpenseInformationFromImage>
>
