import { useCallback, useEffect, useRef, useState } from 'react'
import { getEngine } from './engine'
import { storageLimited } from './shims'

const APP_VERSION = 'v5'

// Collects problems so they can be shown in the menu and sent to Claude
const problems = []
function describe(e) {
  if (!e) return 'unknown'
  if (e instanceof Error || e instanceof DOMException) return `${e.name}: ${e.message}`
  if (e instanceof ErrorEvent) return `ErrorEvent: ${e.message} @${e.filename}:${e.lineno}`
  if (e instanceof Event) return `Event(${e.type}) on ${e.target?.constructor?.name || '?'}`
  if (typeof e === 'object') { try { return JSON.stringify(e).slice(0, 300) } catch { return String(e) } }
  return String(e)
}
function note(where, e) {
  problems.push(`[${where}] ${describe(e)}`)
  if (problems.length > 12) problems.shift()
}
if (typeof window !== 'undefined') {
  window.addEventListener('error', (ev) => note('page', ev.error || ev))
  window.addEventListener('unhandledrejection', (ev) => note('promise', ev.reason))
}

// Runs one start-up step, labelling any failure and giving up if it hangs
function step(label, promise, ms = 15000) {
  return Promise.race([
    Promise.resolve(promise).catch((e) => { const err = new Error(`${label} failed: ${describe(e)}`); err.step = true; throw err }),
    new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error(`${label} timed out`), { step: true })), ms)),
  ])
}
import { unzipSync, gunzipSync } from 'fflate'
import { FREE_GAMES } from './free/catalog'
const FREE_BY_ID = Object.fromEntries(FREE_GAMES.map((f) => [f.id, f]))
import { listGames, getGame, addGame, deleteGame, loadSettings, saveSettings, putSave, getSave } from './storage'

const SHELLS = [
  { name: 'Stone', value: '#D8D3C6' },
  { name: 'Mint', value: '#A9D6C4' },
  { name: 'Coral', value: '#F2B49A' },
  { name: 'Sky', value: '#AFC8E8' },
]
const PALETTES = [
  { name: 'Auto', value: null },
  { name: 'Green', value: 'green' },
  { name: 'Grey', value: 'grayscale' },
]
const BUTTONS = ['UP', 'RIGHT', 'DOWN', 'LEFT', 'A', 'B', 'SELECT', 'START']
const emptyPad = () => Object.fromEntries(BUTTONS.map((b) => [b, false]))

const KEYMAP = {
  ArrowUp: 'UP', ArrowDown: 'DOWN', ArrowLeft: 'LEFT', ArrowRight: 'RIGHT',
  KeyW: 'UP', KeyS: 'DOWN', KeyA: 'LEFT', KeyD: 'RIGHT',
  KeyX: 'A', KeyZ: 'B', Enter: 'START', ShiftLeft: 'SELECT', ShiftRight: 'SELECT', Backspace: 'SELECT',
}

function cleanName(fileName) {
  return fileName.replace(/\.(gbc?|zip)$/i, '').replace(/[_-]+/g, ' ').trim() || 'Untitled'
}

// Reads a picked file and returns { name, bytes } for a .gb/.gbc ROM (unzipping if needed)
async function readRomFile(file) {
  const buf = new Uint8Array(await file.arrayBuffer())
  if (/\.zip$/i.test(file.name) || (buf[0] === 0x50 && buf[1] === 0x4b)) {
    const entries = unzipSync(buf)
    const romName = Object.keys(entries).find((n) => /\.gbc?$/i.test(n))
    if (!romName) throw new Error('No Game Boy game found inside that zip file.')
    return { name: cleanName(romName.split('/').pop()), bytes: entries[romName] }
  }
  if (buf.length < 0x150) throw new Error('That file is too small to be a game.')
  return { name: cleanName(file.name), bytes: buf }
}

let engineRef = null
if (typeof window !== 'undefined') window.__gg = { fps: () => engineRef?.fps ?? -1, kind: () => engineRef?.kind, engine: () => engineRef }

export default function App() {
  const canvasRef = useRef(null)
  const fileRef = useRef(null)
  const sources = useRef({ touch: emptyPad(), keys: emptyPad(), pad: emptyPad() })
  const lastSent = useRef('')
  const running = useRef(false)
  const menuRef = useRef(false)
  const busyRef = useRef(false)
  const loadedRom = useRef(null)
  const currentId = useRef(null)
  const engine = useRef(null)
  const [engineName, setEngineName] = useState('')

  const [settings, setSettings] = useState(() => ({
    shell: SHELLS[0].value, sound: true, haptics: true, palette: null, ...loadSettings(),
  }))
  const settingsRef = useRef(settings)
  const [pressed, setPressed] = useState(emptyPad())
  const [games, setGames] = useState([])
  const [current, setCurrent] = useState(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState('')
  const [error, setError] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(null)

  useEffect(() => {
    settingsRef.current = settings
    saveSettings(settings)
    const meta = document.querySelector('meta[name="theme-color"]')
    if (meta) meta.setAttribute('content', settings.shell)
    document.body.style.background = settings.shell
  }, [settings])

  const refreshGames = useCallback(async () => setGames(await listGames()), [])
  useEffect(() => { refreshGames() }, [refreshGames])

  // Load the console and free games in the background, so they are ready
  // (and saved for offline use in the installed app)
  useEffect(() => {
    const t = setTimeout(() => {
      getEngine().catch(() => {})
      import('./free/roms').catch(() => {})
    }, 2500)
    return () => clearTimeout(t)
  }, [])

  // Sound can only start after a tap; wake it on the first touch
  useEffect(() => {
    const wake = () => { try { engine.current?.wakeAudio() } catch { /* ignore */ } }
    window.addEventListener('pointerdown', wake)
    return () => window.removeEventListener('pointerdown', wake)
  }, [])

  const flash = useCallback((msg) => {
    setToast(msg)
    clearTimeout(flash.t)
    flash.t = setTimeout(() => setToast(''), 1600)
  }, [])

  // ---------- Emulator control ----------
  const setBusyBoth = (v) => { busyRef.current = v; setBusy(v) }

  const pushInput = useCallback(() => {
    const { touch, keys, pad } = sources.current
    const merged = {}
    for (const b of BUTTONS) merged[b] = touch[b] || keys[b] || pad[b]
    const sig = BUTTONS.map((b) => (merged[b] ? 1 : 0)).join('')
    if (sig === lastSent.current) return
    lastSent.current = sig
    setPressed(merged)
    if (running.current && !menuRef.current && !busyRef.current) {
      try { engine.current?.setInput(merged) } catch { /* not ready */ }
    }
  }, [])

  // Battery saves (the game's own save slots) are kept per game
  const saveProgress = useCallback(async () => {
    const eng = engine.current
    if (!eng || !eng.loaded || !currentId.current) return
    try {
      const ram = eng.getRam()
      if (ram) await putSave(`ram:${currentId.current}`, ram)
    } catch (e) { note('save', e) }
  }, [])

  const ensureEngine = useCallback(async () => {
    if (engine.current) return engine.current
    const eng = await step('Starting the console', getEngine())
    eng.attach(canvasRef.current)
    eng.onCrash = () => { note('game', 'The game stopped (crashed)'); setError('The game stopped unexpectedly. Try Restart.') }
    engine.current = eng
    engineRef = eng
    setEngineName(eng.kind)
    return eng
  }, [])

  const boot = useCallback(async (bytes, id) => {
    const eng = await ensureEngine()
    eng.attach(canvasRef.current)
    eng.load(bytes, settingsRef.current.palette)
    let ram = null
    try { ram = await getSave(`ram:${id}`) } catch (e) { note('load save', e) }
    if (ram) eng.setRam(new Uint8Array(ram))
    loadedRom.current = bytes
    currentId.current = id
  }, [ensureEngine])

  const resume = useCallback(async () => {
    const eng = engine.current
    if (!running.current || !eng) return
    lastSent.current = ''
    eng.setSound(settingsRef.current.sound)
    eng.wakeAudio()
    eng.start()
    pushInput()
  }, [pushInput])

  const openMenu = useCallback(async () => {
    if (menuRef.current) return
    menuRef.current = true
    setMenuOpen(true)
    setConfirmDelete(null)
    if (running.current) {
      engine.current?.stop()
      saveProgress()
    }
  }, [saveProgress])

  const closeMenu = useCallback(async () => {
    menuRef.current = false
    setMenuOpen(false)
    setError('')
    if (running.current) await resume()
  }, [resume])

  const startGame = useCallback(async (id) => {
    if (busyRef.current) return
    setError('')
    setBusyBoth(true)
    try {
      const game = await getGame(id)
      if (!game) throw new Error('That game could not be found.')
      await saveProgress()
      await boot(new Uint8Array(game.data), game.id)
      running.current = true
      setCurrent({ id: game.id, name: game.name })
      setSettings((s) => ({ ...s, lastGame: game.id }))
      menuRef.current = false
      setMenuOpen(false)
      await resume()
    } catch (e) {
      running.current = false
      setCurrent(null)
      note('start', e)
      setError(`Sorry, that game would not start. ${describe(e)}`)
    } finally {
      setBusyBoth(false)
    }
  }, [boot, resume, saveProgress])

  // Re-power the console with a new screen palette, keeping exactly where you were
  const relaunchKeepingProgress = useCallback(() => {
    const eng = engine.current
    if (!eng || !eng.loaded || !loadedRom.current) return
    try {
      const snap = eng.snapshot()
      eng.load(loadedRom.current, settingsRef.current.palette)
      eng.restore(snap)
    } catch (e) { note('palette', e) }
  }, [])

  const quickSave = async () => {
    try {
      await putSave(`state:${currentId.current}`, engine.current.snapshot())
      flash('SAVED')
      await closeMenu()
    } catch (e) { note('quick save', e); setError('Could not save right now.') }
  }

  const quickLoad = async () => {
    try {
      const snap = await getSave(`state:${currentId.current}`)
      if (!snap) { setError('No quick save yet for this game.'); return }
      engine.current.restore(snap)
      flash('LOADED')
      await closeMenu()
    } catch (e) { note('quick load', e); setError('Could not load the quick save.') }
  }

  const restart = async () => {
    const eng = engine.current
    if (!eng || !loadedRom.current) return
    const ram = eng.getRam()
    eng.load(loadedRom.current, settingsRef.current.palette)
    if (ram) eng.setRam(ram)
    await closeMenu()
  }

  const onPickFile = async (e) => {
    const files = [...(e.target.files || [])]
    e.target.value = ''
    if (!files.length) return
    setError('')
    let last = null
    for (const f of files) {
      try {
        const { name, bytes } = await readRomFile(f)
        last = await addGame(name, bytes)
      } catch (err) {
        setError(err?.message || `Could not add ${f.name}.`)
      }
    }
    await refreshGames()
    if (last && files.length === 1) flash('ADDED')
  }

  const removeGame = async (id) => {
    if (confirmDelete !== id) { setConfirmDelete(id); return }
    await deleteGame(id)
    setConfirmDelete(null)
    if (current?.id === id) {
      engine.current?.stop()
      running.current = false
      loadedRom.current = null
      currentId.current = null
      setCurrent(null)
    }
    refreshGames()
  }

  const updateSetting = async (key, value) => {
    setSettings((s) => ({ ...s, [key]: value }))
    settingsRef.current = { ...settingsRef.current, [key]: value }
    if (key === 'sound') engine.current?.setSound(value)
    if (key === 'palette' && running.current) relaunchKeepingProgress()
  }

  // ---------- Input ----------
  const setButton = useCallback((source, button, down) => {
    const src = sources.current[source]
    if (src[button] === down) return
    src[button] = down
    if (down) {
      if (settingsRef.current.haptics && navigator.vibrate) {
        try { navigator.vibrate(button === 'START' || button === 'SELECT' ? 6 : 10) } catch { /* ignore */ }
      }
      if (menuRef.current) {
        if (running.current && (button === 'START' || button === 'B')) closeMenu()
      } else if (!running.current && (button === 'START' || button === 'A')) {
        openMenu()
      }
    }
    pushInput()
  }, [closeMenu, openMenu, pushInput])

  const setDirections = useCallback((dirs) => {
    const src = sources.current.touch
    let changed = false
    let newPress = false
    for (const d of ['UP', 'DOWN', 'LEFT', 'RIGHT']) {
      if (src[d] !== dirs[d]) {
        if (dirs[d]) newPress = true
        src[d] = dirs[d]
        changed = true
      }
    }
    if (!changed) return
    if (newPress && settingsRef.current.haptics && navigator.vibrate) {
      try { navigator.vibrate(8) } catch { /* ignore */ }
    }
    pushInput()
  }, [pushInput])

  // Keyboard (handy on a laptop)
  useEffect(() => {
    const handle = (down) => (e) => {
      if (e.target instanceof HTMLInputElement) return
      if (e.code === 'Escape' && down) { menuRef.current ? closeMenu() : openMenu(); return }
      const b = KEYMAP[e.code]
      if (!b) return
      e.preventDefault()
      setButton('keys', b, down)
    }
    const kd = handle(true), ku = handle(false)
    window.addEventListener('keydown', kd)
    window.addEventListener('keyup', ku)
    return () => { window.removeEventListener('keydown', kd); window.removeEventListener('keyup', ku) }
  }, [setButton, openMenu, closeMenu])

  // Bluetooth / USB controllers (standard mapping)
  useEffect(() => {
    if (!navigator.getGamepads) return
    let raf = 0
    const poll = () => {
      const gp = [...navigator.getGamepads()].find(Boolean)
      if (!gp) { raf = 0; return }
      const btn = (i) => !!gp.buttons[i]?.pressed
      const ax = gp.axes || []
      const next = {
        A: btn(1) || btn(3), B: btn(0) || btn(2), SELECT: btn(8), START: btn(9),
        UP: btn(12) || (ax[1] ?? 0) < -0.5, DOWN: btn(13) || (ax[1] ?? 0) > 0.5,
        LEFT: btn(14) || (ax[0] ?? 0) < -0.5, RIGHT: btn(15) || (ax[0] ?? 0) > 0.5,
      }
      if (btn(16) && !sources.current.pad.HOME) { menuRef.current ? closeMenu() : openMenu() }
      sources.current.pad.HOME = btn(16)
      for (const b of BUTTONS) setButton('pad', b, next[b])
      raf = requestAnimationFrame(poll)
    }
    const onConnect = () => { if (!raf) raf = requestAnimationFrame(poll) }
    window.addEventListener('gamepadconnected', onConnect)
    return () => { window.removeEventListener('gamepadconnected', onConnect); cancelAnimationFrame(raf) }
  }, [setButton, openMenu, closeMenu])

  // Save progress when the app goes to the background; resume on return
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === 'hidden') saveProgress()
      else if (running.current && !menuRef.current && !busyRef.current) setTimeout(() => resume(), 150)
    }
    document.addEventListener('visibilitychange', onVis)
    window.addEventListener('pagehide', saveProgress)
    const timer = setInterval(() => { if (running.current && !menuRef.current) saveProgress() }, 60000)
    return () => {
      document.removeEventListener('visibilitychange', onVis)
      window.removeEventListener('pagehide', saveProgress)
      clearInterval(timer)
    }
  }, [resume, saveProgress])

  const lastGame = games.find((g) => g.id === settings.lastGame)
  const owned = new Set(games.map((g) => g.id))

  // Free games: copy into the library on first play, then start
  const playFree = async (free) => {
    if (busyRef.current) return
    setError('')
    try {
      if (!owned.has(free.id)) {
        setBusyBoth(true)
        const { ROMS } = await import('./free/roms')
        const bin = atob(ROMS[free.id])
        const gz = new Uint8Array(bin.length)
        for (let i = 0; i < bin.length; i++) gz[i] = bin.charCodeAt(i)
        await addGame(free.title, gunzipSync(gz), free.id)
        await refreshGames()
        setBusyBoth(false)
      }
      await startGame(free.id)
    } catch {
      setBusyBoth(false)
      setError(`Could not open ${free.title}. Please try again.`)
    }
  }

  return (
    <div className="gg" style={{ '--shell': settings.shell }}>
      <div className="device">
        <div className="topbar">
          <div className="power">
            <span className={`led ${current ? 'on' : ''}`} />
            <span className="label">POWER</span>
          </div>
          <button type="button" className="iconbtn" aria-label="Menu and game library" onClick={() => (menuOpen ? closeMenu() : openMenu())}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="3" y="4" width="18" height="16" rx="2" /><path d="M7 8h10M7 12h10M7 16h6" />
            </svg>
          </button>
        </div>

        <div className="bezel">
          <div className="lcd">
            <canvas ref={canvasRef} className={`screen ${current ? 'show' : ''}`} width="160" height="144" />
            {!current && !busy && (
              <div className="title">
                <div className="sprite" aria-hidden="true">
                  {'010010111111111111011110001100'.split('').map((c, i) => <i key={i} className={c === '1' ? 'px' : ''} />)}
                </div>
                <div className="logo">GAME<br />GIRL</div>
                <div className="blink">PRESS START</div>
              </div>
            )}
            {busy && <div className="title"><div className="blink">LOADING</div></div>}
            {toast && <div className="toast">{toast}</div>}
          </div>
          <div className="bezel-labels">
            <span>GAME GIRL</span>
            <span className="now">{current ? current.name : 'COLOUR'}</span>
          </div>
        </div>

        <div className="controls">
          <div className="row">
            <DPad pressed={pressed} onChange={setDirections} />
            <div className="ab">
              <PadButton className="round b" label="B" button="B" pressed={pressed.B} setButton={setButton} />
              <PadButton className="round a" label="A" button="A" pressed={pressed.A} setButton={setButton} />
            </div>
          </div>
          <div className="startselect">
            <div className="pill-wrap">
              <PadButton className="pill" label="" ariaLabel="Select" button="SELECT" pressed={pressed.SELECT} setButton={setButton} />
              <span className="label">SELECT</span>
            </div>
            <div className="pill-wrap">
              <PadButton className="pill" label="" ariaLabel="Start" button="START" pressed={pressed.START} setButton={setButton} />
              <span className="label">START</span>
            </div>
          </div>
          <div className="speaker" aria-hidden="true"><i /><i /><i /><i /><i /></div>
        </div>
      </div>

      {menuOpen && (
        <div className="menu" role="dialog" aria-label="Menu">
          <div className="menu-inner">
            <div className="menu-head">
              <h1>MENU</h1>
              <button type="button" className="close" onClick={closeMenu} aria-label="Close menu">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
              </button>
            </div>

            {error && <p className="error" role="alert">{error}</p>}

            {current && (
              <section>
                <h2>Now playing</h2>
                <p className="playing">{current.name}</p>
                <div className="actions">
                  <button type="button" className="act primary" onClick={closeMenu}>Resume</button>
                  <button type="button" className="act" onClick={quickSave}>Quick save</button>
                  <button type="button" className="act" onClick={quickLoad}>Quick load</button>
                  <button type="button" className="act" onClick={restart}>Restart</button>
                </div>
              </section>
            )}

            <section>
              <h2>Your games</h2>
              {games.length === 0 && (
                <p className="hint">No games yet. Pick one from <b>Free games</b> below to start playing.</p>
              )}
              {!current && lastGame && (
                <button type="button" className="act primary wide" onClick={() => startGame(lastGame.id)}>Continue {lastGame.name}</button>
              )}
              <ul className="games">
                {games.map((g) => (
                  <li key={g.id} className={current?.id === g.id ? 'active' : ''}>
                    <button type="button" className="game" onClick={() => startGame(g.id)} disabled={busy}>
                      {FREE_BY_ID[g.id]?.thumb
                        ? <img className="minithumb" src={FREE_BY_ID[g.id].thumb} alt="" width="40" height="36" />
                        : <span className="cart" aria-hidden="true" />}
                      <span className="gname">{g.name}</span>
                    </button>
                    <button type="button" className={`del ${confirmDelete === g.id ? 'confirm' : ''}`} onClick={() => removeGame(g.id)} aria-label={`Delete ${g.name}`}>
                      {confirmDelete === g.id ? 'Delete?' : (
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12h10l1-12M9 7V4h6v3" /></svg>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
              <button type="button" className="act add wide" onClick={() => fileRef.current?.click()}>+ Add game</button>
              <input ref={fileRef} type="file" multiple hidden onChange={onPickFile} />
            </section>

            <section>
              <h2>Free games</h2>
              <p className="hint">Free homebrew games, made by independent developers and shared openly. Tap one to play.</p>
              <ul className="shelf">
                {FREE_GAMES.map((f) => (
                  <li key={f.id}>
                    <button type="button" className="freegame" onClick={() => playFree(f)} disabled={busy}>
                      {f.thumb ? <img className="thumb" src={f.thumb} alt="" width="80" height="72" /> : <span className="thumb" />}
                      <span className="finfo">
                        <span className="ftitle">{f.title}</span>
                        <span className="fblurb">{f.blurb}</span>
                        <span className="fmeta">
                          <span className="tag">{f.genre}</span>
                          {f.colour && <span className="tag colour">Colour</span>}
                          {owned.has(f.id) && <span className="tag mine">In your games</span>}
                        </span>
                        <span className="credit">by {f.by} · {f.license}</span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>

            <section>
              <h2>Settings</h2>
              <div className="setting">
                <span>Sound</span>
                <Toggle on={settings.sound} onChange={(v) => updateSetting('sound', v)} label="Sound" />
              </div>
              <div className="setting">
                <span>Vibration</span>
                <Toggle on={settings.haptics} onChange={(v) => updateSetting('haptics', v)} label="Vibration" />
              </div>
              <div className="setting">
                <span>Screen colours</span>
                <div className="seg">
                  {PALETTES.map((p) => (
                    <button type="button" key={p.name} className={settings.palette === p.value ? 'on' : ''} onClick={() => updateSetting('palette', p.value)}>{p.name}</button>
                  ))}
                </div>
              </div>
              <div className="setting">
                <span>Casing</span>
                <div className="swatches">
                  {SHELLS.map((s) => (
                    <button type="button" key={s.value} aria-label={s.name} className={settings.shell === s.value ? 'on' : ''} style={{ background: s.value }} onClick={() => updateSetting('shell', s.value)} />
                  ))}
                </div>
              </div>
            </section>

            <section>
              <h2>About</h2>
              <p className="hint">Game Girl {APP_VERSION} · {engineName} engine{storageLimited ? ' · saving limited' : ''}</p>
              {problems.length > 0 && (
                <div className="problems">
                  <p className="hint">Problem details (copy these to Claude):</p>
                  <pre className="problem-log">{problems.join('\n')}</pre>
                  <button type="button" className="act" onClick={() => {
                    const text = `Game Girl ${APP_VERSION} ${engineName}\n${navigator.userAgent}\n${problems.join('\n')}`
                    navigator.clipboard?.writeText(text).then(() => flash('COPIED')).catch(() => {})
                  }}>Copy problem details</button>
                </div>
              )}
              <p className="hint">Free games come from Homebrew Hub (hh.gbdev.io), where you can find many more. You can also add your own <b>.gb</b>, <b>.gbc</b> or <b>.zip</b> game files with <b>Add game</b>. Screen colours only change original Game Boy games.</p>
            </section>
          </div>
        </div>
      )}
    </div>
  )
}

function PadButton({ className, label, ariaLabel, button, pressed, setButton }) {
  const down = (e) => {
    e.preventDefault()
    try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* ignore */ }
    setButton('touch', button, true)
  }
  const up = () => setButton('touch', button, false)
  return (
    <button
      type="button"
      className={`padbtn ${className} ${pressed ? 'down' : ''}`}
      aria-label={ariaLabel || `${label} button`}
      onPointerDown={down}
      onPointerUp={up}
      onPointerCancel={up}
      onLostPointerCapture={up}
      onContextMenu={(e) => e.preventDefault()}
    >
      {label}
    </button>
  )
}

function DPad({ pressed, onChange }) {
  const ref = useRef(null)
  const active = useRef(null)

  const compute = (e) => {
    const r = ref.current.getBoundingClientRect()
    const dx = e.clientX - (r.left + r.width / 2)
    const dy = e.clientY - (r.top + r.height / 2)
    const dead = r.width * 0.1
    const none = { UP: false, DOWN: false, LEFT: false, RIGHT: false }
    if (Math.hypot(dx, dy) < dead) return none
    const angle = (Math.atan2(dy, dx) * 180) / Math.PI // 0 = right, 90 = down
    const near = (target) => Math.abs(((angle - target + 540) % 360) - 180) <= 67.5
    return { RIGHT: near(0), DOWN: near(90), LEFT: near(180), UP: near(-90) }
  }

  const down = (e) => {
    e.preventDefault()
    active.current = e.pointerId
    try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* ignore */ }
    onChange(compute(e))
  }
  const move = (e) => { if (active.current === e.pointerId) onChange(compute(e)) }
  const up = (e) => {
    if (active.current !== e.pointerId) return
    active.current = null
    onChange({ UP: false, DOWN: false, LEFT: false, RIGHT: false })
  }

  return (
    <div
      ref={ref}
      className="dpad"
      role="group"
      aria-label="Direction pad"
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      onLostPointerCapture={up}
      onContextMenu={(e) => e.preventDefault()}
    >
      <span className={`arm up ${pressed.UP ? 'down' : ''}`} />
      <span className={`arm left ${pressed.LEFT ? 'down' : ''}`} />
      <span className="hub"><i /></span>
      <span className={`arm right ${pressed.RIGHT ? 'down' : ''}`} />
      <span className={`arm downarm ${pressed.DOWN ? 'down' : ''}`} />
    </div>
  )
}

function Toggle({ on, onChange, label }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} className={`toggle ${on ? 'on' : ''}`} onClick={() => onChange(!on)}>
      <span />
    </button>
  )
}
