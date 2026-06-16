import { encode, decode } from '@msgpack/msgpack'

// ─── NT4 Protocol ─────────────────────────────────────────────────────────────
// WebSocket subprotocol: "networktables.first.wpi.edu"
// Text frames: JSON control messages
// Binary frames: MessagePack data updates → [topic_id, timestamp_us, type_id, value]
//
// NT4 type IDs: 0=boolean, 1=double, 2=int, 3=float, 4=string, ...
// We only use type 1 (double) for setpoints/actuals.

const NT4_TYPE_DOUBLE = 1

export interface NT4Topic {
  name: string
  id: number
  typeStr: string
}

export type NT4DataCallback = (topic: string, timestampUs: number, value: unknown) => void
export type NT4StatusCallback = (status: 'connecting' | 'connected' | 'disconnected' | 'error', msg?: string) => void

export class NT4Client {
  private ws: WebSocket | null = null
  private subUid = 1
  private pubUid = 1
  private topicsByName = new Map<string, NT4Topic>()
  private topicsById = new Map<number, NT4Topic>()
  private publishedTopics = new Map<string, number>()  // name → pubUid
  private subscribers = new Map<string, number>()      // name → subUid
  private dataCallback: NT4DataCallback
  private statusCallback: NT4StatusCallback
  private url: string
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private stopped = false

  constructor(url: string, onData: NT4DataCallback, onStatus: NT4StatusCallback) {
    this.url = url
    this.dataCallback = onData
    this.statusCallback = onStatus
  }

  connect(): void {
    this.stopped = false
    this.tryConnect()
  }

  private tryConnect(): void {
    if (this.stopped) return
    this.statusCallback('connecting')

    try {
      this.ws = new WebSocket(this.url, 'networktables.first.wpi.edu')
      this.ws.binaryType = 'arraybuffer'

      this.ws.onopen = () => {
        this.statusCallback('connected')
        // Re-subscribe and re-publish topics after reconnect
        for (const [name, subUid] of this.subscribers) {
          this.sendSubscribe(name, subUid)
        }
        for (const [name, pubUid] of this.publishedTopics) {
          this.sendPublish(name, pubUid)
        }
      }

      this.ws.onmessage = (evt) => {
        if (typeof evt.data === 'string') {
          this.handleTextMessage(evt.data)
        } else {
          this.handleBinaryMessage(evt.data as ArrayBuffer)
        }
      }

      this.ws.onerror = () => {
        this.statusCallback('error', 'WebSocket error')
      }

      this.ws.onclose = () => {
        if (!this.stopped) {
          this.statusCallback('disconnected')
          this.reconnectTimer = setTimeout(() => this.tryConnect(), 3000)
        }
      }
    } catch {
      this.statusCallback('error', 'Failed to create WebSocket')
      if (!this.stopped) {
        this.reconnectTimer = setTimeout(() => this.tryConnect(), 3000)
      }
    }
  }

  disconnect(): void {
    this.stopped = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.ws?.close()
    this.ws = null
    this.topicsByName.clear()
    this.topicsById.clear()
    this.statusCallback('disconnected')
  }

  subscribe(topicName: string): void {
    const uid = this.subUid++
    this.subscribers.set(topicName, uid)
    if (this.isConnected()) this.sendSubscribe(topicName, uid)
  }

  publish(topicName: string, typeStr = 'double'): void {
    if (this.publishedTopics.has(topicName)) return
    const uid = this.pubUid++
    this.publishedTopics.set(topicName, uid)
    if (this.isConnected()) this.sendPublish(topicName, uid, typeStr)
  }

  publishValue(topicName: string, value: number): void {
    const pubUid = this.publishedTopics.get(topicName)
    if (pubUid === undefined || !this.isConnected()) return
    const timestampUs = Math.floor(performance.now() * 1000)
    const msg = encode([pubUid, timestampUs, NT4_TYPE_DOUBLE, value])
    this.ws!.send(msg)
  }

  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN
  }

  private sendSubscribe(topicName: string, uid: number): void {
    const msg = JSON.stringify({
      method: 'subscribe',
      params: {
        topics: [{ name: topicName }],
        subuid: uid,
        options: { periodic: 0.02, all: false, topicsonly: false, prefix: false }
      }
    })
    this.ws?.send(msg)
  }

  private sendPublish(topicName: string, uid: number, typeStr = 'double'): void {
    const msg = JSON.stringify({
      method: 'publish',
      params: { name: topicName, pubuid: uid, type: typeStr, properties: {} }
    })
    this.ws?.send(msg)
  }

  private handleTextMessage(raw: string): void {
    try {
      const msg = JSON.parse(raw)
      // NT4 announces topic metadata via text messages
      if (msg.method === 'announce') {
        const topic: NT4Topic = { name: msg.params.name, id: msg.params.id, typeStr: msg.params.type }
        this.topicsByName.set(topic.name, topic)
        this.topicsById.set(topic.id, topic)
      }
    } catch {
      // ignore malformed text
    }
  }

  private handleBinaryMessage(buf: ArrayBuffer): void {
    try {
      // NT4 binary: array of [topic_id, timestamp_us, type_id, value]
      const decoded = decode(new Uint8Array(buf))
      if (!Array.isArray(decoded) || decoded.length < 4) return
      const [topicId, timestampUs, , value] = decoded as [number, number, number, unknown]
      const topic = this.topicsById.get(topicId)
      if (topic) {
        this.dataCallback(topic.name, timestampUs as number, value)
      }
    } catch {
      // ignore malformed binary
    }
  }
}

// ─── Robot IP helpers ─────────────────────────────────────────────────────────

export function robotIP(teamNumber: string): string {
  const n = parseInt(teamNumber, 10)
  if (isNaN(n)) return '10.0.0.2'
  const te = Math.floor(n / 100)
  const am = n % 100
  return `10.${te}.${am}.2`
}

export function nt4URL(teamNumber: string, appName = 'GainLab'): string {
  const ip = robotIP(teamNumber)
  return `ws://${ip}:5810/nt/${appName}`
}
