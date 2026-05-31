import { generateReqId } from '@wecom/aibot-node-sdk'

export function createTraceId(frame: { headers?: { req_id?: string } } | undefined): string {
  return frame?.headers?.req_id ?? generateReqId('trace')
}

export function getMessageId(frame: { headers?: Record<string, unknown>, body?: Record<string, unknown> } | undefined): string | undefined {
  const headers = frame?.headers
  const body = frame?.body
  const headerId = headers?.msgid
  if (typeof headerId === 'string') return headerId
  const bodyId = body?.msgid
  if (typeof bodyId === 'string') return bodyId
  return undefined
}
