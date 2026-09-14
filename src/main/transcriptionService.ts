/**
 * TranscriptionService - native-capture STT coordinator.
 *
 * Deepgram remains the default direct provider. When the user explicitly
 * selects OpenAI in Settings this class delegates the same Raven provider
 * interface to OpenAITranscriptionService, keeping AudioManager unchanged.
 */

import { BrowserWindow } from 'electron'
import type WebSocket from 'ws'
import { sessionManager } from './services/sessionManager'
import { getSetting } from './store'
import { createLogger } from './logger'
import { parseSttProviderPreference } from '../shared/sttCapabilities'
import { OpenAITranscriptionService } from './services/openAITranscriptionService'
import {
  AUDIO_SAMPLE_RATE,
  AUDIO_CHANNELS,
  DEEPGRAM_KEEPALIVE_MS,
  DEEPGRAM_ENDPOINTING_MS,
  DEEPGRAM_UTTERANCE_END_MS,
  TRANSCRIPT_MERGE_WINDOW_MS,
  TRANSCRIPT_FLUSH_TIMEOUT_MS,
} from './constants'

const log = createLogger('Transcription')
const DEEPGRAM_WS_BASE = 'wss://api.deepgram.com/v1/listen'

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
  isConnected: boolean
  keepAliveInterval: NodeJS.Timeout | null
  currentInterim: string
  sendCount: number
  reconnectAttempts: number
  pendingAudio: Buffer[]
}

const RECONNECT_BUFFER_MAX_CHUNKS = 50
const MAX_RECONNECT_ATTEMPTS = 3
const RECONNECT_DELAY_MS = 1000
const MAX_TRANSCRIPT_ENTRIES = 5000

function newConnectionState(): ConnectionState {
  return {
    ws: null,
    isConnected: false,
    keepAliveInterval: null,
    currentInterim: '',
    sendCount: 0,
    reconnectAttempts: 0,
    pendingAudio: [],
  }
}

export class TranscriptionService {
  private micConnection = newConnectionState()
  private systemConnection = newConnectionState()
  private overlayWindow: BrowserWindow | null = null
  private dashboardWindow: BrowserWindow | null = null
  private apiKey = ''
  private transcriptEntries: TranscriptEntry[] = []
  private isActive = false
  private reconnecting = new Set<AudioSource>()
  private openaiDelegate: OpenAITranscriptionService | null = null
  private activeEngine: 'deepgram' | 'openai' = 'deepgram'

  setWindows(dashboard: BrowserWindow | null, overlay: BrowserWindow | null): void {
    this.dashboardWindow = dashboard
    this.overlayWindow = overlay
    this.openaiDelegate?.setWindows(dashboard, overlay)
  }

  setApiKey(key: string): void {
    this.apiKey = key
  }

  async start(): Promise<{ success: boolean; error?: string }> {
    const preference = parseSttProviderPreference(getSetting('sttProvider'))
    if (preference === 'openai') {
      this.activeEngine = 'openai'
      if (!this.openaiDelegate) this.openaiDelegate = new OpenAITranscriptionService()
      this.openaiDelegate.setWindows(this.dashboardWindow, this.overlayWindow)
      this.openaiDelegate.setApiKey((getSetting('openaiApiKey') as string) || '')
      this.openaiDelegate.clearTranscript()
      log.info('Starting OpenAI gpt-live-transcribe for native capture')
      return await this.openaiDelegate.start()
    }

    this.activeEngine = 'deepgram'
    if (!this.apiKey) {
      log.error('No Deepgram API key!')
      return { success: false, error: 'No Deepgram API key configured' }
    }

    log.info('Starting Deepgram connections...')
    this.isActive = true
    const [micResult, systemResult] = await Promise.all([
      this.startConnection('mic'),
      this.startConnection('system'),
    ])

    if (!micResult.success && !systemResult.success) {
      this.isActive = false
      return { success: false, error: 'Failed to start transcription' }
    }
    return { success: true }
  }

  private stateFor(source: AudioSource): ConnectionState {
    return source === 'mic' ? this.micConnection : this.systemConnection
  }

  private async startConnection(source: AudioSource): Promise<{ success: boolean }> {
    const state = this.stateFor(source)
    if (state.isConnected) return { success: true }

    try {
      const { default: WebSocketModule } = await import('ws')
      const transcriptionLanguage = (getSetting('transcriptionLanguage') as string) || 'en'
      const params = new URLSearchParams({
        model: 'nova-3',
        language: transcriptionLanguage,
        smart_format: 'true',
        interim_results: 'true',
        punctuate: 'true',
        diarize: 'false',
        sample_rate: String(AUDIO_SAMPLE_RATE),
        channels: String(AUDIO_CHANNELS),
        encoding: 'linear16',
        endpointing: String(DEEPGRAM_ENDPOINTING_MS),
        utterance_end_ms: String(DEEPGRAM_UTTERANCE_END_MS),
      })

      const vocabString = (getSetting('vocabulary') as string) || ''
      const userTerms = vocabString.split(',').map((t) => t.trim()).filter(Boolean)
      const seen = new Set<string>()
      const finalTerms: string[] = []
      for (const term of ['Raven', ...userTerms]) {
        const key = term.toLowerCase()
        if (seen.has(key)) continue
        seen.add(key)
        finalTerms.push(term)
        if (finalTerms.length >= 100) break
      }
      for (const term of finalTerms) params.append('keyterms', term)

      state.ws = new WebSocketModule(`${DEEPGRAM_WS_BASE}?${params.toString()}`, {
        headers: { Authorization: `Token ${this.apiKey}` },
      }) as WebSocket

      return await new Promise((resolve) => {
        let settled = false
        const finish = (value: { success: boolean }) => {
          if (settled) return
          settled = true
          resolve(value)
        }
        const timeout = setTimeout(() => {
          log.error(`${source} Deepgram WebSocket connection timed out after 10s`)
          try { state.ws?.close() } catch { /* ignore */ }
          finish({ success: false })
        }, 10_000)

        state.ws!.onopen = () => {
          clearTimeout(timeout)
          state.isConnected = true
          state.reconnectAttempts = 0
          state.keepAliveInterval = setInterval(() => {
            if (!state.ws || !state.isConnected) return
            try { state.ws.send(JSON.stringify({ type: 'KeepAlive' })) } catch (err) {
              log.error(`${source} keep-alive error:`, err)
            }
          }, DEEPGRAM_KEEPALIVE_MS)
          this.broadcastStatus(`${source}-connected`)
          finish({ success: true })
        }

        state.ws!.onmessage = (event: { data: unknown }) => {
          try {
            const data = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data))
            this.handleTranscriptResult(data, source)
          } catch (err) {
            log.error(`${source} Deepgram parse error:`, err)
          }
        }

        state.ws!.onerror = (event: { message?: string }) => {
          clearTimeout(timeout)
          log.error(`${source} Deepgram WebSocket error:`, event.message || event)
          finish({ success: false })
        }

        state.ws!.onclose = (event: { code?: number; reason?: string }) => {
          clearTimeout(timeout)
          const code = event?.code ?? 'unknown'
          const reason = event?.reason ?? 'no reason'
          log.warn(`${source} Deepgram WebSocket closed (code=${code}, reason="${reason}")`)
          state.isConnected = false
          state.ws = null
          this.clearKeepAlive(state)
          if (this.isActive && code !== 1000) void this.attemptReconnect(source)
        }
      })
    } catch (err) {
      log.error(`${source} failed to connect to Deepgram:`, err)
      return { success: false }
    }
  }

  private async attemptReconnect(source: AudioSource): Promise<void> {
    if (this.reconnecting.has(source)) return
    this.reconnecting.add(source)
    const state = this.stateFor(source)
    state.reconnectAttempts++

    if (state.reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
      log.error(`${source} exceeded max Deepgram reconnect attempts`)
      this.reconnecting.delete(source)
      this.broadcastStatus(`${source}-disconnected`)
      return
    }

    await new Promise((resolve) => setTimeout(resolve, RECONNECT_DELAY_MS * state.reconnectAttempts))
    if (!this.isActive) {
      this.reconnecting.delete(source)
      return
    }

    state.sendCount = 0
    const result = await this.startConnection(source)
    this.reconnecting.delete(source)
    if (!result.success && this.isActive) void this.attemptReconnect(source)
  }

  private handleTranscriptResult(
    data: { channel?: { alternatives?: Array<{ transcript?: string }> }; is_final?: boolean },
    source: AudioSource,
  ): void {
    const transcript = data.channel?.alternatives?.[0]?.transcript
    if (!transcript) return
    const state = this.stateFor(source)
    if (data.is_final) this.handleFinalTranscript(transcript, source)
    else {
      state.currentInterim = transcript
      this.handleInterimTranscript(transcript, source)
    }
  }

  private handleFinalTranscript(text: string, source: AudioSource): void {
    const speaker: 'you' | 'them' = source === 'mic' ? 'you' : 'them'
    const now = Date.now()
    const state = this.stateFor(source)
    const lastEntry = this.transcriptEntries[this.transcriptEntries.length - 1]
    const shouldMerge = lastEntry
      && lastEntry.speaker === speaker
      && (now - lastEntry.timestamp) < TRANSCRIPT_MERGE_WINDOW_MS

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
    this.broadcastTranscript({ entry: latestEntry, isFinal: true, fullTranscript: this.getFullTranscriptText() })
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
      entry: { id: `interim-${source}`, source, text, speaker, timestamp: Date.now(), isFinal: false },
      isFinal: false,
      fullTranscript: this.getFullTranscriptText(),
      interims: { mic: this.micConnection.currentInterim, system: this.systemConnection.currentInterim },
    })
  }

  sendAudio(buffer: Buffer | ArrayBuffer, source: AudioSource): void {
    if (this.activeEngine === 'openai' && this.openaiDelegate) {
      this.openaiDelegate.sendAudio(buffer, source)
      return
    }

    const state = this.stateFor(source)
    const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer)
    if (!state.ws || !state.isConnected) {
      if (state.pendingAudio.length < RECONNECT_BUFFER_MAX_CHUNKS) state.pendingAudio.push(Buffer.from(buf))
      return
    }

    if (state.pendingAudio.length > 0) {
      const pending = state.pendingAudio.splice(0)
      for (const chunk of pending) {
        try { state.ws.send(chunk) } catch { break }
      }
    }

    try {
      state.sendCount++
      state.ws.send(buf)
    } catch (err) {
      log.error(`${source} Deepgram send error:`, err)
    }
  }

  async stop(): Promise<void> {
    if (this.activeEngine === 'openai' && this.openaiDelegate) {
      await this.openaiDelegate.stop()
      return
    }

    this.isActive = false
    await Promise.all([
      this.stopConnection(this.micConnection),
      this.stopConnection(this.systemConnection),
    ])
    this.micConnection.reconnectAttempts = 0
    this.systemConnection.reconnectAttempts = 0
  }

  private async stopConnection(state: ConnectionState): Promise<void> {
    this.clearKeepAlive(state)
    if (state.ws) {
      try {
        if (state.isConnected) {
          state.ws.send(JSON.stringify({ type: 'CloseStream' }))
          await new Promise<void>((resolve) => {
            const timeout = setTimeout(() => {
              try { state.ws?.close() } catch { /* ignore */ }
              resolve()
            }, TRANSCRIPT_FLUSH_TIMEOUT_MS)
            const originalOnClose = state.ws!.onclose
            state.ws!.onclose = (event) => {
              clearTimeout(timeout)
              if (typeof originalOnClose === 'function') originalOnClose.call(state.ws, event)
              resolve()
            }
          })
        } else {
          state.ws.close()
        }
      } catch (err) {
        log.error('Deepgram close error:', err)
        try { state.ws?.close() } catch { /* ignore */ }
      }
    }
    state.ws = null
    state.isConnected = false
    state.currentInterim = ''
  }

  getFullTranscript(): string {
    if (this.activeEngine === 'openai' && this.openaiDelegate) return this.openaiDelegate.getFullTranscript()
    return this.getFullTranscriptText()
  }

  getFullTranscriptWithInterims(): string {
    if (this.activeEngine === 'openai' && this.openaiDelegate) return this.openaiDelegate.getFullTranscriptWithInterims()
    let text = this.getFullTranscriptText()
    const displayName = (getSetting('displayName') as string) || 'You'
    if (this.systemConnection.currentInterim) text += `\nThem (still speaking): ${this.systemConnection.currentInterim}`
    if (this.micConnection.currentInterim) text += `\n${displayName} (still speaking): ${this.micConnection.currentInterim}`
    return text
  }

  getTranscriptEntries(): TranscriptEntry[] {
    if (this.activeEngine === 'openai' && this.openaiDelegate) return this.openaiDelegate.getTranscriptEntries()
    return this.transcriptEntries
  }

  getTranscriptBySource(source: 'mic' | 'system' | 'all'): string {
    if (this.activeEngine === 'openai' && this.openaiDelegate) return this.openaiDelegate.getTranscriptBySource(source)
    const displayName = (getSetting('displayName') as string) || 'You'
    const filtered = source === 'all' ? this.transcriptEntries : this.transcriptEntries.filter((entry) => entry.source === source)
    return filtered.map((entry) => `${entry.speaker === 'you' ? displayName : 'Them'}: ${entry.text}`).join('\n')
  }

  clearTranscript(): void {
    if (this.activeEngine === 'openai' && this.openaiDelegate) {
      this.openaiDelegate.clearTranscript()
      return
    }
    this.transcriptEntries = []
    this.micConnection.currentInterim = ''
    this.systemConnection.currentInterim = ''
  }

  private getFullTranscriptText(): string {
    const displayName = (getSetting('displayName') as string) || 'You'
    return this.transcriptEntries.map((entry) => `${entry.speaker === 'you' ? displayName : 'Them'}: ${entry.text}`).join('\n')
  }

  private broadcastTranscript(data: {
    entry: TranscriptEntry
    isFinal: boolean
    fullTranscript: string
    interims?: { mic: string; system: string }
  }): void {
    try {
      if (this.overlayWindow && !this.overlayWindow.isDestroyed()) this.overlayWindow.webContents.send('transcription:update', data)
    } catch (err) {
      log.error('Broadcast to overlay failed:', err)
    }
    try {
      if (this.dashboardWindow && !this.dashboardWindow.isDestroyed()) this.dashboardWindow.webContents.send('transcription:update', data)
    } catch (err) {
      log.error('Broadcast to dashboard failed:', err)
    }
  }

  private broadcastStatus(status: string): void {
    const payload = { status }
    try {
      if (this.overlayWindow && !this.overlayWindow.isDestroyed()) this.overlayWindow.webContents.send('transcription:status', payload)
    } catch { /* ignore */ }
    try {
      if (this.dashboardWindow && !this.dashboardWindow.isDestroyed()) this.dashboardWindow.webContents.send('transcription:status', payload)
    } catch { /* ignore */ }
  }

  private clearKeepAlive(state: ConnectionState): void {
    if (!state.keepAliveInterval) return
    clearInterval(state.keepAliveInterval)
    state.keepAliveInterval = null
  }
}
