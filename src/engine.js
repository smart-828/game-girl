// Game Girl engine: runs the WasmBoy emulator core directly in the page.
// No background workers, no network fetches, no storage of its own.
// Uses the WebAssembly core when the page allows it (faster),
// otherwise the plain JavaScript core (works everywhere).

const WIDTH = 160
const HEIGHT = 144
const FRAME_MS = 1000 / 59.7275
const SAMPLE_RATE = 44100
const PALETTES = ['wasmboygb', 'brown', 'red', 'darkbrown', 'green', 'darkgreen', 'inverted', 'pastelmix', 'orange', 'yellow', 'blue', 'darkblue', 'grayscale']

function webAssemblyAllowed() {
  try {
    new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]))
    return true
  } catch {
    return false
  }
}

async function loadWasmCore() {
  const { WASM_CORE_BASE64 } = await import('./core/wasmCore.js')
  const bin = atob(WASM_CORE_BASE64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  const imports = {
    index: { consoleLog: () => {}, consoleLogTimeout: () => {} },
    env: { abort: () => {} },
  }
  const { instance } = await WebAssembly.instantiate(bytes, imports)
  return { exports: instance.exports, memory: () => new Uint8Array(instance.exports.memory.buffer), kind: 'fast' }
}

async function loadJsCore() {
  const mod = await import('wasmboy/dist/core/getWasmBoyTsCore.closure.esm.js')
  const core = await mod.default()
  return { exports: core.instance.exports, memory: () => core.byteMemory, kind: 'compatible' }
}

const num = (v) => (typeof v === 'number' ? v : v.valueOf())

// Battery-save size from the cartridge header
function ramSizeFor(rom) {
  const type = rom[0x147]
  if (type === 0x05 || type === 0x06) return 512 // MBC2 built-in RAM
  return [0, 0x800, 0x2000, 0x8000, 0x20000, 0x10000][rom[0x149]] || 0
}

class Engine {
  constructor(core) {
    this.core = core
    this.e = core.exports
    this.kind = core.kind
    this.loc = {
      rom: num(this.e.CARTRIDGE_ROM_LOCATION),
      ram: num(this.e.CARTRIDGE_RAM_LOCATION),
      frame: num(this.e.FRAME_LOCATION),
      audio: num(this.e.AUDIO_BUFFER_LOCATION),
      state: num(this.e.WASMBOY_STATE_LOCATION),
      stateSize: num(this.e.WASMBOY_STATE_SIZE),
      gbMem: num(this.e.GAMEBOY_INTERNAL_MEMORY_LOCATION),
      gbMemSize: num(this.e.GAMEBOY_INTERNAL_MEMORY_SIZE),
      pal: num(this.e.GBC_PALETTE_LOCATION),
      palSize: num(this.e.GBC_PALETTE_SIZE),
      ramMax: num(this.e.CARTRIDGE_RAM_SIZE),
    }
    this.canvas = null
    this.ctx = null
    this.image = null
    this.running = false
    this.loaded = false
    this.ramSize = 0
    this.sound = true
    this.audio = null
    this.audioTime = 0
    this.raf = 0
    this.last = 0
    this.acc = 0
    this.fps = 0
    this.fpsFrames = 0
    this.fpsSince = 0
    this.input = [0, 0, 0, 0, 0, 0, 0, 0]
    this.onCrash = null
    this.tick = this.tick.bind(this)
  }

  attach(canvas) {
    if (this.canvas === canvas) return
    this.canvas = canvas
    canvas.width = WIDTH
    canvas.height = HEIGHT
    this.ctx = canvas.getContext('2d')
    this.image = this.ctx.createImageData(WIDTH, HEIGHT)
  }

  // Power on with a game: clean memory, insert cartridge, start the console
  load(rom, palette) {
    this.stop()
    const mem = this.core.memory()
    mem.fill(0)
    mem.set(rom, this.loc.rom)
    // config(bootROM, GBC, audioBatch, graphicsBatch, timersBatch, noScanline, accumulateSamples, tileRendering, tileCaching, audioDebug)
    this.e.config(0, 1, 0, 0, 0, 0, 0, 0, 0, 0)
    this.setPalette(palette)
    this.e.clearAudioBuffer()
    this.ramSize = ramSizeFor(rom)
    this.loaded = true
    this.draw()
  }

  setPalette(palette) {
    if (!palette) return
    const i = PALETTES.indexOf(palette)
    if (i >= 0) this.e.setManualColorizationPalette(i)
  }

  getRam() {
    if (!this.loaded || !this.ramSize) return null
    return this.core.memory().slice(this.loc.ram, this.loc.ram + this.ramSize)
  }

  setRam(bytes) {
    if (!this.loaded || !bytes || !bytes.length) return
    this.core.memory().set(bytes.subarray(0, this.loc.ramMax), this.loc.ram)
  }

  snapshot() {
    this.e.saveState()
    const mem = this.core.memory()
    return {
      v: 1,
      state: mem.slice(this.loc.state, this.loc.state + this.loc.stateSize),
      gbMem: mem.slice(this.loc.gbMem, this.loc.gbMem + this.loc.gbMemSize),
      pal: mem.slice(this.loc.pal, this.loc.pal + this.loc.palSize),
      ram: mem.slice(this.loc.ram, this.loc.ram + this.loc.ramMax),
    }
  }

  restore(snap) {
    if (!snap || snap.v !== 1) throw new Error('That save is from an older version.')
    const mem = this.core.memory()
    mem.set(snap.gbMem, this.loc.gbMem)
    mem.set(snap.pal, this.loc.pal)
    mem.set(snap.ram, this.loc.ram)
    mem.set(snap.state, this.loc.state)
    this.e.loadState()
    this.e.clearAudioBuffer()
    this.draw()
  }

  setInput(p) {
    this.input = [p.UP, p.RIGHT, p.DOWN, p.LEFT, p.A, p.B, p.SELECT, p.START].map((v) => (v ? 1 : 0))
    if (this.loaded) this.e.setJoypadState(...this.input)
  }

  // ---- Sound ----
  setSound(on) {
    this.sound = !!on
    if (!on && this.audio) this.audioTime = 0
  }

  wakeAudio() {
    try {
      if (!this.audio) {
        const AC = window.AudioContext || window.webkitAudioContext
        if (!AC) return
        this.audio = new AC()
        this.gain = this.audio.createGain()
        this.gain.gain.value = 0.9
        this.gain.connect(this.audio.destination)
      }
      if (this.audio.state === 'suspended') this.audio.resume()
    } catch { this.audio = null }
  }

  pushAudio() {
    const n = this.e.getNumberOfSamplesInAudioBuffer()
    if (!n) return
    const a = this.audio
    if (this.sound && a && a.state === 'running') {
      const now = a.currentTime
      if (this.audioTime < now + 0.02) this.audioTime = now + 0.06
      // Too far ahead (e.g. after a hitch): drop this chunk to stay in sync
      if (this.audioTime > now + 0.3) { this.e.clearAudioBuffer(); return }
      const mem = this.core.memory()
      const buf = a.createBuffer(2, n, SAMPLE_RATE)
      const L = buf.getChannelData(0)
      const R = buf.getChannelData(1)
      let p = this.loc.audio
      for (let i = 0; i < n; i++) {
        L[i] = sample(mem[p++])
        R[i] = sample(mem[p++])
      }
      const src = a.createBufferSource()
      src.buffer = buf
      src.connect(this.gain)
      src.start(this.audioTime)
      this.audioTime += n / SAMPLE_RATE
    }
    this.e.clearAudioBuffer()
  }

  // ---- Main loop ----
  start() {
    if (this.running || !this.loaded) return
    this.running = true
    this.last = performance.now()
    this.acc = FRAME_MS
    this.fpsSince = this.last
    this.fpsFrames = 0
    this.e.setJoypadState(...this.input)
    this.raf = requestAnimationFrame(this.tick)
  }

  stop() {
    this.running = false
    cancelAnimationFrame(this.raf)
    this.raf = 0
  }

  tick(now) {
    if (!this.running) return
    this.acc += Math.min(now - this.last, 250)
    this.last = now
    let frames = 0
    while (this.acc >= FRAME_MS && frames < 4) {
      const r = this.e.executeFrame()
      if (r < 0) {
        this.stop()
        if (this.onCrash) this.onCrash()
        return
      }
      this.pushAudio()
      this.acc -= FRAME_MS
      frames++
    }
    if (this.acc > FRAME_MS * 4) this.acc = 0 // too slow to catch up: skip ahead
    if (frames) this.draw()
    this.fpsFrames += frames
    if (now - this.fpsSince >= 1000) {
      this.fps = Math.round((this.fpsFrames * 1000) / (now - this.fpsSince))
      this.fpsFrames = 0
      this.fpsSince = now
    }
    this.raf = requestAnimationFrame(this.tick)
  }

  draw() {
    if (!this.ctx) return
    const mem = this.core.memory()
    const out = this.image.data
    let p = this.loc.frame
    for (let i = 0; i < WIDTH * HEIGHT * 4; i += 4) {
      out[i] = mem[p++]
      out[i + 1] = mem[p++]
      out[i + 2] = mem[p++]
      out[i + 3] = 255
    }
    this.ctx.putImageData(this.image, 0, 0)
  }
}

function sample(v) {
  let s = (v - 1) / 127 - 1
  if (s > -0.008 && s < 0.008) s = 0
  return s / 2.5
}

let enginePromise = null
export function getEngine() {
  if (!enginePromise) {
    enginePromise = (async () => {
      let core = null
      if (webAssemblyAllowed()) {
        try { core = await loadWasmCore() } catch { core = null }
      }
      if (!core) core = await loadJsCore()
      return new Engine(core)
    })()
    enginePromise.catch(() => { enginePromise = null })
  }
  return enginePromise
}
