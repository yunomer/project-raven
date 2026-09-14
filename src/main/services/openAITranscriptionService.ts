/**
 * OpenAI realtime transcription service.
 *
 * Raven captures mono PCM16 at 16 kHz. OpenAI realtime transcription expects
 * 24 kHz PCM, so audio is resampled before it is appended to the session.
 * Mic and system audio use independent WebSocket sessions so Raven can keep
 * deterministic You/Them labels without diarization.
 *
 * gpt-live-transcribe does not support server-side turn detection. Raven uses
 * manual audio-buffer commits instead, which both finalizes transcript turns
 * and keeps the implementation independent of a second VAD dependency.
 */

import { BrowserWindow } from 'electron'
import type WebSocket from 'ws'
import { createLogger } from '../logger'
import { getSetting } from '../store'
import { sessionManager } from './sessionManager'
import { AUDIO_SAMPLE_RATE, TRANSCRIPT_MERGE_WINDOW_MS } from '../constants'

const log = createLogger('OpenAITranscription')

const OPENAI_REALTIME_TRANSCRIPTION_URL = 'wss://api.openai.com/v1/realtime?intent=transcription'
const OPENAI_TRANSCRIPTION_MODEL = 'gpt-live-transcribe'
const OPENAI_SAMPLE_RATE = 24_000
const MAX_RECONNECT_ATTEMPTS = 3
const RECONNECT_DELAY_MS = 1_000
const RECONNECT_BUFFER_MAX_CHUNKS = 50
const MAX_TRANSCRIPT_ENTRIES = 5_000
const SESSION_SETUP_TIMEOUT_MS = 10_000
const MANUAL_COMMIT_INTERVAL_MS = 2_500
const MIN_COMMIT_AUDIO_MS = 100
const STOP_FLUSH_WAIT_MS = 1_200

type AudioSource = 'mic' | 'system'

interface TranscriptEntry {
  id: string
  source: AudioSource
  text: string
  speaker: 'you' | 'them'
  timestamp: number
  isFinal: boolean
}

interface ConnectionState {
  ws: WebSocket | null
  /** True only after OpenAI acknowledges our session.update. */
  isConnected: boolean
  currentInterim: string
  sendCount: number
  reconnectAttempts: number
  pendingAudio: Buffer[]
  interimByItem: Map<string, string>
  /** Duration currently sitting in OpenAI's uncommitted input buffer. */
  bufferedAudioMs: number
}

function createConnectionState(): ConnectionState {
  return {
    ws: null,
    isConnected: false,
    currentInterim: '',
    sendCount: 0,
    reconnectAttempts: 0,
    pendingAudio: [],
    interimByItem: new Map(),
    bufferedAudioMs: 0,
  }
}

/**
 * Resample mono signed PCM16 using linear interpolation.
 * Raven currently feeds 16 kHz PCM and OpenAI expects 24 kHz PCM.
 */
export function resamplePcm16Mono(
  input: Buffer,
  inputRate = AUDIO_SAMPLE_RATE,
  outputRate = OPENAI_SAMPLE_RATE,
): Buffer {
  if (inputRate === outputRate) return Buffer.from(input)
  if (input.length < 2 || inputRate <= 0 || outputRate <= 0) return Buffer.alloc(0)

  const inputSamples = Math.floor(input.length / 2)
  if (inputSamples === 0) return Buffer.alloc(0)

  const outputSamples = Math.max(1, Math.round(inputSamples * outputRate / inputRate))
  const output = Buffer.allocUnsafe(outputSamples * 2)
  const ratio = inputRate / outputRate

  for (let i = 0; i < outputSamples; i++) {
    const sourcePos = i * ratio
    const leftIndex = Math.min(Math.floor(sourcePos), inputSamples - 1)
    const rightIndex = Math.min(leftIndex + 1, inputSamples - 1)
    const fraction = sourcePos - leftIndex
    const left = input.readInt16LE(leftIndex * 2)
    const right = input.readInt16LE(rightIndex * 2)
    const sample = Math.round(left + (right - left) * fraction)
    output.writeInt16LE(Math.max(-32768, Math.min(32767, sample)), i * 2)
  }

  return output
}

/** Duration of mono PCM16 audio represented by a buffer. */
export function pcm16DurationMs(buffer: Buffer, sampleRate: number): number {
  if (sampleRate <= 0 || buffer.length < 2) return 0
  return (Math.floor(buffer.length / 2) / sampleRate) * 1_000
}

function buildVocabulary(): string[] {
  const raw = (getSetting('vocabulary') as string) || ''
  const userTerms = raw.split(',').map((term) => term.trim()).filter(Boolean)
  const seen = new Set<string>()
  const terms: string[] = []

  for (const rawTerm of ['Raven', ...userTerms]) {
    const term = rawTerm.replace(/[<>\r\n]/g, '').trim().slice(0, 80)
    if (!term) continue
    const key = term.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    terms.push(term)
    if (terms.length >= 100) break
  }

  return terms
}

function normalizeLanguage(language: string): string | null {
  if (!language || language === 'multi') return null
  return language.toLowerCase().split(/[-_]/)[0] || null
}

export class OpenAITranscriptionService {
  private micState = createConnectionState()
  private systemState = createConnectionState()
  private overlayWindow: BrowserWindow | null = null
  private dashboardWindow: BrowserWindow | null = null
  private transcriptEntries: TranscriptEntry[] = []
  private apiKey = ''
  private isActive = false
  private reconnecting = new Set<AudioSource>()

  setWindows(dashboard: BrowserWindow | null, overlay: BrowserWindow | null): void {
    this.dashboardWindow = dashboard
    this.overlayWindow = overlay
  }

  setApiKey(key: string): void {
    this.apiKey = key
  }

  async start(): Promise<{ success: boolean; error?: string }> {
    if (!this.apiKey) {
      log.error('No OpenAI API key configured')
      return { success: false, error: 'No OpenAI API key configured' }
    }

    this.isActive = true
    const [micResult, systemResult] = await Promise.all([
      this.startConnection('mic'),
      this.startConnection('system'),
    ])

    log.info(`Connection results - Mic: ${micResult.success}, System: ${systemResult.success}`)

    if (!micResult.success && !systemResult.success) {
      this.isActive = false
      return { success: false, error: 'Failed to configure OpenAI realtime transcription' }
    }

    return { success: true }
  }

  private stateFor(source: AudioSource): ConnectionState {
    return source === 'mic' ? this.micState : this.systemState
  }

  private async startConnection(source: AudioSource): Promise<{ success: boolean }> {
    const state = this.stateFor(source)
    if (state.isConnected) return { success: true }

    try {
      const { default: WebSocketModule } = await import('ws')
      state.ws = new WebSocketModule(OPENAI_REALTIME_TRANSCRIPTION_URL, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
      }) as WebSocket

      return await new Promise((resolve) => {
        let settled = false
        const finish = (result: { success: boolean }) => {
          if (settled) return
          settled = true
          resolve(result)
        }

        const timeout = setTimeout(() => {
          log.error(`${source} OpenAI transcription session setup timed out after ${SESSION_SETUP_TIMEOUT_MS}ms`)
          try { state.ws?.close(1000) } catch { /* ignore */ }
          finish({ success: false })
        }, SESSION_SETUP_TIMEOUT_MS)

        state.ws!.onopen = () => {
          log.info(`${source} OpenAI WebSocket opened; configuring transcription session`)

          const language = normalizeLanguage((getSetting('transcriptionLanguage') as string) || 'en')
          const keywords = buildVocabulary()
          const transcription: Record<string, unknown> = {
            model: OPENAI_TRANSCRIPTION_MODEL,
            keywords,
            prompt: 'A live meeting or interview. Preserve names, technical terms, acronyms, numbers, and punctuation accurately.',
          }
          if (language) transcription.languages = [language]

          // gpt-live-transcribe is a realtime-only STT model and explicitly
          // does not support server_vad/semantic_vad. Omitting turn_detection
          // means Raven must commit the input audio buffer itself.
          state.ws!.send(JSON.stringify({
            type: 'session.update',
            session: {
              type: 'transcription',
              audio: {
                input: {
                  format: { type: 'audio/pcm', rate: OPENAI_SAMPLE_RATE },
                  transcription,
                },
              },
            },
          }))
        }

        state.ws!.onmessage = (event: { data: unknown }) => {
          try {
            const data = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data)) as Record<string, unknown>
            const type = typeof data.type === 'string' ? data.type : ''

            // A TCP/WebSocket connection is not enough. Audio must not be sent
            // until OpenAI accepts the transcription configuration.
            if (type === 'session.updated' && !state.isConnected) {
              clearTimeout(timeout)
              state.isConnected = true
              state.reconnectAttempts = 0
              log.info(`${source} OpenAI transcription session ready`)
              this.broadcastStatus(`${source}-connected`)
              this.flushPendingAudio(state, source)
              finish({ success: true })
              return
            }

            if (type === 'error' && !state.isConnected) {
              clearTimeout(timeout)
              const error = data.error as { message?: string } | undefined
              log.error(`${source} OpenAI session configuration failed:`, error?.message || data)
              try { state.ws?.close(1000) } catch { /* ignore */ }
              finish({ success: false })
              return
            }

            this.handleServerEvent(data, source)
          } catch (err) {
            log.error(`${source} OpenAI message parse error:`, err)
          }
        }

        state.ws!.onerror = (event: { message?: string }) => {
          clearTimeout(timeout)
          log.error(`${source} OpenAI WebSocket error:`, event.message || event)
          finish({ success: false })
        }

        state.ws!.onclose = (event: { code?: number; reason?: unknown }) => {
          clearTimeout(timeout)
          const code = event?.code ?? 'unknown'
          const reason = event?.reason == null ? 'no reason' : String(event.reason)
          log.warn(`${source} OpenAI WebSocket closed (code=${code}, reason="${reason}")`)
          const wasReady = state.isConnected
          state.isConnected = false
          state.ws = null
          state.bufferedAudioMs = 0
          if (!wasReady) finish({ success: false })
          if (this.isActive && code !== 1000 && wasReady) void this.attemptReconnect(source)
        }
      })
    } catch (err) {
      log.error(`${source} failed to connect to OpenAI:`, err)
      return { success: false }
    }
  }

  private handleServerEvent(data: Record<string, unknown>, source: AudioSource): void {
    const type = typeof data.type === 'string' ? data.type : ''

    if (type === 'conversation.item.input_audio_transcription.delta') {
      const delta = typeof data.delta === 'string' ? data.delta : ''
      if (!delta) return
      const itemId = typeof data.item_id === 'string' ? data.item_id : `interim-${source}`
      const state = this.stateFor(source)
      const interim = `${state.interimByItem.get(itemId) || ''}${delta}`
      state.interimByItem.set(itemId, interim)
      state.currentInterim = interim
      this.handleInterimTranscript(interim, source)
      return
    }

    if (type === 'conversation.item.input_audio_transcription.completed') {
      const transcript = typeof data.transcript === 'string' ? data.transcript.trim() : ''
      const itemId = typeof data.item_id === 'string' ? data.item_id : ''
      const state = this.stateFor(source)
      if (itemId) state.interimByItem.delete(itemId)
      const remainingInterims = Array.from(state.interimByItem.values())
      state.currentInterim = remainingInterims.length > 0 ? remainingInterims[remainingInterims.length - 1] : ''
      if (transcript) {
        log.debug(`${source} OpenAI final transcript: "${transcript.slice(0, 120)}"`)
        this.handleFinalTranscript(transcript, source)
      }
      return
    }

    if (type === 'input_audio_buffer.committed') {
      log.debug(`${source} OpenAI audio buffer committed`)
      return
    }

    if (type === 'error') {
      const error = data.error as { message?: string; code?: string } | undefined
      log.error(`${source} OpenAI transcription error:`, error?.message || data)
    }
  }

  private handleFinalTranscript(text: string, source: AudioSource): void {
    const speaker: 'you' | 'them' = source === 'mic' ? 'you' : 'them'
    const now = Date.now()
    const state = this.stateFor(source)
    const lastEntry = this.transcriptEntries[this.transcriptEntries.length - 1]
    const shouldMerge = Boolean(
      lastEntry
      && lastEntry.speaker === speaker
      && (now - lastEntry.timestamp) < TRANSCRIPT_MERGE_WINDOW_MS,
    )

    if (shouldMerge && lastEntry) {
      lastEntry.text = `${lastEntry.text} ${text}`
      lastEntry.timestamp = now
    } else {
      if (this.transcriptEntries.length >= MAX_TRANSCRIPT_ENTRIES) {
        this.transcriptEntries = this.transcriptEntries.slice(-Math.floor(MAX_TRANSCRIPT_ENTRIES * 0.8))
      }
      this.transcriptEntries.push({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        source,
        text,
        speaker,
        timestamp: now,
        isFinal: true,
      })
    }

    state.currentInterim = ''
    const latestEntry = this.transcriptEntries[this.transcriptEntries.length - 1]
    sessionManager.addTranscriptEntry({
      id: latestEntry.id,
      source: latestEntry.source,
      text: latestEntry.text,
      timestamp: latestEntry.timestamp,
      isFinal: true,
    })

    this.broadcastTranscript({
      entry: latestEntry,
      isFinal: true,
      fullTranscript: this.getFullTranscriptText(),
    })
  }

  private handleInterimTranscript(text: string, source: AudioSource): void {
    const speaker: 'you' | 'them' = source === 'mic' ? 'you' : 'them'
    sessionManager.addTranscriptEntry({
      id: `interim-${source}`,
      source,
      text,
      timestamp: Date.now(),
      isFinal: false,
    })

    this.broadcastTranscript({
      entry: {
        id: `interim-${source}`,
        source,
        text,
        speaker,
        timestamp: Date.now(),
        isFinal: false,
      },
      isFinal: false,
      fullTranscript: this.getFullTranscriptText(),
      interims: {
        mic: this.micState.currentInterim,
        system: this.systemState.currentInterim,
      },
    })
  }

  sendAudio(buffer: Buffer | ArrayBuffer, source: AudioSource): void {
    const state = this.stateFor(source)
    const raw = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer)

    if (!state.ws || !state.isConnected) {
      if (state.pendingAudio.length < RECONNECT_BUFFER_MAX_CHUNKS) state.pendingAudio.push(Buffer.from(raw))
      return
    }

    this.flushPendingAudio(state, source)
    this.sendChunk(state, raw, source)
  }

  private flushPendingAudio(state: ConnectionState, source: AudioSource): void {
    if (!state.ws || !state.isConnected || state.pendingAudio.length === 0) return
    const pending = state.pendingAudio.splice(0)
    log.info(`${source} flushing ${pending.length} buffered chunks after OpenAI session became ready`)
    for (const chunk of pending) {
      if (!state.ws || !state.isConnected) break
      this.sendChunk(state, chunk, source)
    }
  }

  private sendChunk(state: ConnectionState, raw: Buffer, source: AudioSource): void {
    if (!state.ws || !state.isConnected) return

    try {
      const pcm24k = resamplePcm16Mono(raw)
      if (pcm24k.length === 0) return

      state.sendCount++
      state.ws.send(JSON.stringify({
        type: 'input_audio_buffer.append',
        audio: pcm24k.toString('base64'),
      }))
      state.bufferedAudioMs += pcm16DurationMs(pcm24k, OPENAI_SAMPLE_RATE)

      if (state.sendCount <= 3 || state.sendCount % 200 === 0) {
        log.debug(
          `${source} OpenAI audio send #${state.sendCount}: ${raw.length}B -> ${pcm24k.length}B, `
          + `uncommitted=${Math.round(state.bufferedAudioMs)}ms`,
        )
      }

      if (state.bufferedAudioMs >= MANUAL_COMMIT_INTERVAL_MS) {
        this.commitAudioBuffer(state, source, 'interval')
      }
    } catch (err) {
      log.error(`${source} OpenAI audio send error:`, err)
    }
  }

  private commitAudioBuffer(
    state: ConnectionState,
    source: AudioSource,
    reason: 'interval' | 'stop',
  ): boolean {
    if (!state.ws || !state.isConnected || state.bufferedAudioMs < MIN_COMMIT_AUDIO_MS) return false

    try {
      const durationMs = state.bufferedAudioMs
      state.ws.send(JSON.stringify({ type: 'input_audio_buffer.commit' }))
      state.bufferedAudioMs = 0
      log.debug(`${source} OpenAI audio commit (${reason}, ${Math.round(durationMs)}ms)`)
      return true
    } catch (err) {
      log.error(`${source} OpenAI audio commit error:`, err)
      return false
    }
  }

  private async attemptReconnect(source: AudioSource): Promise<void> {
    if (this.reconnecting.has(source)) return
    this.reconnecting.add(source)
    const state = this.stateFor(source)
    state.reconnectAttempts++

    if (state.reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
      log.error(`${source} exceeded OpenAI reconnect attempts`)
      this.reconnecting.delete(source)
      this.broadcastStatus(`${source}-disconnected`)
      return
    }

    const delay = RECONNECT_DELAY_MS * state.reconnectAttempts
    await new Promise((resolve) => setTimeout(resolve, delay))
    if (!this.isActive) {
      this.reconnecting.delete(source)
      return
    }

    const result = await this.startConnection(source)
    this.reconnecting.delete(source)
    if (!result.success && this.isActive) void this.attemptReconnect(source)
  }

  async stop(): Promise<void> {
    this.isActive = false
    await Promise.all([
      this.stopConnection(this.micState, 'mic'),
      this.stopConnection(this.systemState, 'system'),
    ])
    this.micState.reconnectAttempts = 0
    this.systemState.reconnectAttempts = 0
  }

  private async stopConnection(state: ConnectionState, source: AudioSource): Promise<void> {
    if (!state.ws) {
      this.resetConnectionState(state)
      return
    }

    try {
      if (state.isConnected) {
        const hadInterim = state.currentInterim.trim().length > 0
        const committed = this.commitAudioBuffer(state, source, 'stop')
        if (committed || hadInterim) {
          // Give the low-latency model time to emit the final completed event
          // before the socket disappears and SessionManager saves the meeting.
          await new Promise((resolve) => setTimeout(resolve, STOP_FLUSH_WAIT_MS))
        }
      }
      state.ws.close(1000)
    } catch (err) {
      log.error(`${source} OpenAI close error:`, err)
      try { state.ws.close() } catch { /* ignore */ }
    }

    this.resetConnectionState(state)
  }

  private resetConnectionState(state: ConnectionState): void {
    state.ws = null
    state.isConnected = false
    state.currentInterim = ''
    state.interimByItem.clear()
    state.pendingAudio = []
    state.bufferedAudioMs = 0
  }

  getFullTranscript(): string {
    return this.getFullTranscriptText()
  }

  getFullTranscriptWithInterims(): string {
    let text = this.getFullTranscriptText()
    const displayName = (getSetting('displayName') as string) || 'You'
    if (this.systemState.currentInterim) text += `\nThem (still speaking): ${this.systemState.currentInterim}`
    if (this.micState.currentInterim) text += `\n${displayName} (still speaking): ${this.micState.currentInterim}`
    return text
  }

  getTranscriptEntries(): TranscriptEntry[] {
    return this.transcriptEntries
  }

  getTranscriptBySource(source: 'mic' | 'system' | 'all'): string {
    const displayName = (getSetting('displayName') as string) || 'You'
    const filtered = source === 'all'
      ? this.transcriptEntries
      : this.transcriptEntries.filter((entry) => entry.source === source)
    return filtered
      .map((entry) => `${entry.speaker === 'you' ? displayName : 'Them'}: ${entry.text}`)
      .join('\n')
  }

  clearTranscript(): void {
    this.transcriptEntries = []
    this.micState.currentInterim = ''
    this.systemState.currentInterim = ''
    this.micState.interimByItem.clear()
    this.systemState.interimByItem.clear()
  }

  private getFullTranscriptText(): string {
    const displayName = (getSetting('displayName') as string) || 'You'
    return this.transcriptEntries
      .map((entry) => `${entry.speaker === 'you' ? displayName : 'Them'}: ${entry.text}`)
      .join('\n')
  }

  private broadcastTranscript(data: {
    entry: TranscriptEntry
    isFinal: boolean
    fullTranscript: string
    interims?: { mic: string; system: string }
  }): void {
    try {
      if (this.overlayWindow && !this.overlayWindow.isDestroyed()) {
        this.overlayWindow.webContents.send('transcription:update', data)
      }
    } catch (err) {
      log.error('Broadcast to overlay failed:', err)
    }

    try {
      if (this.dashboardWindow && !this.dashboardWindow.isDestroyed()) {
        this.dashboardWindow.webContents.send('transcription:update', data)
      }
    } catch (err) {
      log.error('Broadcast to dashboard failed:', err)
    }
  }

  private broadcastStatus(status: string): void {
    const payload = { status }
    try {
      if (this.overlayWindow && !this.overlayWindow.isDestroyed()) {
        this.overlayWindow.webContents.send('transcription:status', payload)
      }
    } catch { /* ignore */ }

    try {
      if (this.dashboardWindow && !this.dashboardWindow.isDestroyed()) {
        this.dashboardWindow.webContents.send('transcription:status', payload)
      }
    } catch { /* ignore */ }
  }
}
