/*======================================================================
  Offline Storage — IndexedDB
======================================================================*/

const DB_NAME = 'ai_spreadsheet';
const DB_VERSION = 1;
const STORES = ['sheets', 'settings'];

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      STORES.forEach((s) => {
        if (!db.objectStoreNames.contains(s)) {
          db.createObjectStore(s, { keyPath: 'id', autoIncrement: true });
        }
      });
    };
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror = (e) => reject(e.target.error);
  });
  return dbPromise;
}

async function getStore(name, mode = 'readonly') {
  const db = await openDB();
  const tx = db.transaction(name, mode);
  return tx.objectStore(name);
}

export async function getAll(storeName) {
  const store = await getStore(storeName);
  return new Promise((res, rej) => {
    const req = store.getAll();
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}

export async function getById(storeName, id) {
  const store = await getStore(storeName);
  return new Promise((res, rej) => {
    const req = store.get(id);
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}

export async function put(storeName, record) {
  const store = await getStore(storeName, 'readwrite');
  return new Promise((res, rej) => {
    const req = store.put({ ...record, updated_at: Date.now() });
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}

export async function del(storeName, id) {
  const store = await getStore(storeName, 'readwrite');
  return new Promise((res, rej) => {
    const req = store.delete(id);
    req.onsuccess = () => res(id);
    req.onerror = () => rej(req.error);
  });
}

/* ---------- Sheet CRUD ---------- */

/* Keeps one record per sheet name. Older builds used autoIncrement ids
   without looking up the existing row, so duplicated names can exist in
   IndexedDB; writes now update the newest record and the reader collapses
   duplicates by name. */
async function sheetRecordsByName() {
  const all = await getAll('sheets');
  const byName = new Map();
  all.forEach((record) => {
    if (!record || !record.name) return;
    const seen = byName.get(record.name);
    if (!seen || (record.updated_at || 0) >= (seen.updated_at || 0)) {
      byName.set(record.name, record);
    }
  });
  return byName;
}

export async function saveSheet(name, cells, raw, dirtyFlag = false, meta = null) {
  const byName = await sheetRecordsByName();
  const existing = byName.get(name);
  const store = await getStore('sheets', 'readwrite');
  const record = {
    name,
    cells: cells || {},
    raw: raw || {},
    dirty: !!dirtyFlag,
    updated_at: Date.now(),
  };
  if (meta) record.meta = meta;
  if (existing && existing.id !== undefined) record.id = existing.id;

  return new Promise((res, rej) => {
    const req = store.put(record);
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}

export async function getSheet(name) {
  const byName = await sheetRecordsByName();
  return byName.get(name) || null;
}

export async function getAllSheets() {
  const byName = await sheetRecordsByName();
  return [...byName.values()].sort((a, b) => (a.id || 0) - (b.id || 0));
}

export async function deleteSheet(name) {
  const all = await getAll('sheets');
  const targets = all.filter((s) => s.name === name);
  for (const target of targets) await del('sheets', target.id);
}

/* ---------- Settings ---------- */

export async function saveSetting(key, value) {
  const store = await getStore('settings', 'readwrite');
  return new Promise((res, rej) => {
    const req = store.put({ key, value, updated_at: Date.now() });
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}

export async function getSetting(key) {
  const all = await getAll('settings');
  const s = all.find((x) => x.key === key);
  return s ? s.value : null;
}

/* ---------- Export / Import ---------- */

export async function exportStore(storeName) {
  const rows = await getAll(storeName);
  return rows.map((r) => {
    const { id, updated_at, ...clean } = r;
    return clean;
  });
}

export async function importStore(storeName, rows) {
  const store = await getStore(storeName, 'readwrite');
  for (const row of rows) {
    await new Promise((res, rej) => {
      const req = store.put({ ...row, updated_at: Date.now() });
      req.onsuccess = res;
      req.onerror = rej;
    });
  }
}

export async function clearStore(storeName) {
  const store = await getStore(storeName, 'readwrite');
  return new Promise((res, rej) => {
    const req = store.clear();
    req.onsuccess = () => res();
    req.onerror = () => rej(req.error);
  });
}
