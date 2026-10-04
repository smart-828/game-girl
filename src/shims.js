// If this browser blocks storage (private mode, strict hosts), give the
// emulator in-memory stand-ins so games still run. Progress then lasts
// only until the page is closed.
import { indexedDB as memoryIDB, IDBKeyRange as MemoryKeyRange } from 'fake-indexeddb'

export let storageLimited = false

function makeMemoryStorage() {
  const m = new Map()
  return {
    get length() { return m.size },
    key: (i) => [...m.keys()][i] ?? null,
    getItem: (k) => (m.has(String(k)) ? m.get(String(k)) : null),
    setItem: (k, v) => { m.set(String(k), String(v)) },
    removeItem: (k) => { m.delete(String(k)) },
    clear: () => m.clear(),
  }
}

for (const name of ['localStorage', 'sessionStorage']) {
  try {
    const s = window[name]
    const probe = '__gg_probe__'
    s.setItem(probe, '1')
    s.removeItem(probe)
  } catch {
    storageLimited = true
    try { Object.defineProperty(window, name, { value: makeMemoryStorage(), configurable: true }) } catch { /* ignore */ }
  }
}

try {
  const req = window.indexedDB.open('__gg_probe__')
  req.onsuccess = () => { try { req.result.close(); window.indexedDB.deleteDatabase('__gg_probe__') } catch { /* ignore */ } }
} catch {
  storageLimited = true
  try {
    Object.defineProperty(window, 'indexedDB', { value: memoryIDB, configurable: true })
    Object.defineProperty(window, 'IDBKeyRange', { value: MemoryKeyRange, configurable: true })
  } catch { /* ignore */ }
}
