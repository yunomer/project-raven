import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  BrowserWindow: class BrowserWindow {},
}))

vi.mock('../store', () => ({
  getSetting: vi.fn(() => ''),
}))

vi.mock('../services/sessionManager', () => ({
  sessionManager: {
    addTranscriptEntry: vi.fn(),
  },
}))

import { resamplePcm16Mono } from '../services/openAITranscriptionService'

describe('OpenAI realtime transcription audio resampling', () => {
  it('converts Raven 16 kHz PCM16 to OpenAI 24 kHz PCM16', () => {
    const input = Buffer.alloc(160 * 2)
    for (let i = 0; i < 160; i++) {
      input.writeInt16LE(Math.round(Math.sin(i / 10) * 10_000), i * 2)
    }

    const output = resamplePcm16Mono(input, 16_000, 24_000)

    expect(output.length).toBe(240 * 2)
    expect(output.readInt16LE(0)).toBe(input.readInt16LE(0))
  })

  it('returns an independent copy when no sample-rate conversion is needed', () => {
    const input = Buffer.from([0x01, 0x00, 0x02, 0x00])
    const output = resamplePcm16Mono(input, 24_000, 24_000)

    expect(output).toEqual(input)
    expect(output).not.toBe(input)
  })

  it('handles empty PCM buffers without producing invalid samples', () => {
    expect(resamplePcm16Mono(Buffer.alloc(0), 16_000, 24_000)).toEqual(Buffer.alloc(0))
  })
})
