// Game library storage (IndexedDB), with an in-memory fallback
// for browsers or previews where IndexedDB is unavailable.

const DB_NAME = 'gamegirl'
const STORE = 'games'
const SAVES = 'saves'
const memory = new Map()
const memorySaves = new Map()
let dbPromise = null

function openDb() {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, 2)
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' })
        if (!db.objectStoreNames.contains(SAVES)) db.createObjectStore(SAVES)
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => resolve(null)
      req.onblocked = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
  return dbPromise
}

function run(mode, fn, store = STORE) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        if (!db) return resolve(undefined)
        try {
          const tx = db.transaction(store, mode)
          const req = fn(tx.objectStore(store))
          tx.oncomplete = () => resolve(req && req.result)
          tx.onerror = () => reject(tx.error)
        } catch (e) {
          reject(e)
        }
      }),
  )
}

export async function listGames() {
  try {
    const all = await run('readonly', (s) => s.getAll())
    if (all) return all.map(({ id, name, added }) => ({ id, name, added })).sort((a, b) => a.name.localeCompare(b.name))
  } catch { /* fall through */ }
  return [...memory.values()].map(({ id, name, added }) => ({ id, name, added }))
}

export async function getGame(id) {
  try {
    const g = await run('readonly', (s) => s.get(id))
    if (g) return g
  } catch { /* fall through */ }
  return memory.get(id)
}

export async function addGame(name, bytes, fixedId) {
  const game = { id: fixedId || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, name, added: Date.now(), data: bytes }
  memory.set(game.id, game)
  try {
    await run('readwrite', (s) => s.put(game))
  } catch { /* kept in memory only */ }
  return game
}

export async function deleteGame(id) {
  memory.delete(id)
  try {
    await run('readwrite', (s) => s.delete(id))
  } catch { /* ignore */ }
}

// Small settings store
export function loadSettings() {
  try {
    return JSON.parse(localStorage.getItem('gamegirl-settings') || '{}')
  } catch {
    return {}
  }
}

export function saveSettings(settings) {
  try {
    localStorage.setItem('gamegirl-settings', JSON.stringify(settings))
  } catch { /* ignore */ }
}

// Game saves (battery saves and quick saves), keyed like "ram:<gameId>"
export async function putSave(key, value) {
  memorySaves.set(key, value)
  try { await run('readwrite', (s) => s.put(value, key), SAVES) } catch { /* kept in memory only */ }
}

export async function getSave(key) {
  try {
    const v = await run('readonly', (s) => s.get(key), SAVES)
    if (v !== undefined) return v
  } catch { /* fall through */ }
  return memorySaves.get(key)
}
