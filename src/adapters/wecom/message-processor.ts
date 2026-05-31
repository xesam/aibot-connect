import type {
  WSClient, WsFrame, BaseMessage, TextMessage,
  ImageMessage, FileMessage, VoiceMessage,
} from '@wecom/aibot-node-sdk'
import { log, type Logger } from '../../logger.js'
import type { ProcessedMessage } from '../../types.js'

// BaseMessage has `[key: string]: any` and `msgtype: MessageType | string`,
// so TypeScript's built-in discriminated-union narrowing via literal comparison
// does not produce a narrowed subtype. Explicit type guards are required.
function isTextMessage(body: BaseMessage): body is TextMessage {
  return body.msgtype === 'text'
}
function isImageMessage(body: BaseMessage): body is ImageMessage {
  return body.msgtype === 'image'
}
function isFileMessage(body: BaseMessage): body is FileMessage {
  return body.msgtype === 'file'
}
function isVoiceMessage(body: BaseMessage): body is VoiceMessage {
  return body.msgtype === 'voice'
}

export class WecomMessageProcessor {
  private ws: WSClient
  private logger: Logger

  constructor(ws: WSClient, logger?: Logger) {
    this.ws = ws
    this.logger = logger ?? log
  }

  async process(frame: WsFrame<BaseMessage>): Promise<ProcessedMessage> {
    const body = frame.body!
    const chatId = body.chattype === 'group'
      ? (body.chatid ?? body.from.userid)
      : body.from.userid
    const userId = body.from.userid

    if (isTextMessage(body)) {
      return { chatId, userId, type: 'text', content: body.text?.content ?? '', raw: frame }
    }
    if (isImageMessage(body)) {
      const imageBuffer = await this.downloadFile(body.image?.url, body.image?.aeskey)
      return { chatId, userId, type: 'image', content: '[图片]', fileBuffer: imageBuffer, raw: frame }
    }
    if (isFileMessage(body)) {
      const result = await this.downloadFileWithName(body.file?.url, body.file?.aeskey)
      return {
        chatId, userId, type: 'file',
        content: `[文件: ${result.fileName ?? ''}]`,
        fileBuffer: result.buffer,
        fileName: result.fileName,
        raw: frame,
      }
    }
    if (isVoiceMessage(body)) {
      return { chatId, userId, type: 'voice', content: body.voice?.content ?? '', raw: frame }
    }
    return { chatId, userId, type: 'unsupported', content: `不支持的消息类型: ${body.msgtype}`, raw: frame }
  }

  private async downloadFile(url: string | undefined, aeskey: string | undefined): Promise<Buffer | undefined> {
    if (!url) return undefined
    try {
      const { buffer } = await this.ws.downloadFile(url, aeskey)
      return buffer
    } catch (error) {
      this.logger.error('[MessageProcessor] Download failed:', error)
      return undefined
    }
  }

  private async downloadFileWithName(
    url: string | undefined,
    aeskey: string | undefined,
  ): Promise<{ buffer: Buffer; fileName?: string }> {
    if (!url) return { buffer: Buffer.alloc(0) }
    try {
      const result = await this.ws.downloadFile(url, aeskey)
      return { buffer: result.buffer, fileName: result.filename }
    } catch (error) {
      this.logger.error('[MessageProcessor] Download failed:', error)
      return { buffer: Buffer.alloc(0) }
    }
  }
}
