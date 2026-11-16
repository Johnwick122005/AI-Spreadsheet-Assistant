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

export async function saveSheet(name, cells, raw, dirtyFlag = false) {
  const store = await getStore('sheets', 'readwrite');
  return new Promise((res, rej) => {
    const req = store.put({ name, cells, raw, dirty: dirtyFlag, updated_at: Date.now() });
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}

export async function getSheet(name) {
  const all = await getAll('sheets');
  return all.find((s) => s.name === name) || null;
}

export async function getAllSheets() { return getAll('sheets'); }

export async function deleteSheet(name) {
  const all = await getAll('sheets');
  const target = all.find((s) => s.name === name);
  if (!target) return;
  return del('sheets', target.id);
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
