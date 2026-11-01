// =============================================================
// Аварийная сеть: мини-сервер внутри приложения (договор «hub» v1).
//
// Основной сервер недоступен — приложение само ищет аварийный узел в
// локальной сети (Wi-Fi, раздача с телефона, офис без интернета), а не
// найдя — поднимает свой: на ПК desktop/emergency-hub.js, на Android
// EmergencyHub.java. Узел — тупой пересыльщик: хранит и рассылает
// конверты, ничего не открывая.
//
// Конверт: {type, msgId, from, to, body} — те же поля, что у LoRa.
// body — результат Sealer.seal: подпись автора тем же ключом устройства,
// что и в LoRa, но книга чужих ключей своя (smess_hub_peers), чтобы
// соседи по сети не смешивались с собеседниками в эфире. Текст узел
// видит — это честно написано в интерфейсе; шифрование каждому
// получателю — следующий этап.
//
// Сообщение чата уходит кадром CHAT со сквозным client_id и приходит
// событием 'mesh-message' (via:'hub') — приложение склеит копии с
// серверными, когда основной вернётся. TEXT — лента «Эфир аварийной сети».
//
// Слово «relay» занято (lib/connection.ts — пути против блокировок).
// =============================================================

import { Sealer, SealStore, Trust, localSealStore, idOf } from '../lora/seal';
import { SMESH_ALL, SMESH_T_CHAT, SMESH_T_TEXT, encodeChatBody, decodeChatBody } from '../lora/smesh';

export type HubState = 'off' | 'searching' | 'serving' | 'joined';
export interface HubStatus {
  state: HubState;
  /** Включено руками (кнопкой), а не по пропаже основного сервера */
  manual: boolean;
  /** Сервер — это устройство */
  self: boolean;
  hubName: string;
  hubId: string;
  clients: number;
  url: string;
  error?: string;
}
export interface HubFeedItem { at: number; name: string; text: string; trust?: Trust; kind?: 'msg' | 'note'; own?: boolean }

/** Конверт договора v1 */
interface Envelope { type: number; msgId: number; from: string; to: string; body: string }

const DOWN_AFTER_MS = 20_000;     // основной молчит столько — включаемся
const UP_AFTER_MS = 60_000;       // основной жив столько — выключаемся
const SEARCH_EVERY_MS = 30_000;   // поиск соседних узлов
const STOP_OWN_AFTER_MS = 120_000; // свой узел без людей после перехода к чужому
const TICK_MS = 5_000;
const ALL = 'ffffffffffff';

// ── ключ устройства ─────────────────────────────────────────────
const hubStore: SealStore = {
  load: localSealStore.load,
  save: localSealStore.save,
  loadBook: () => { try { return localStorage.getItem('smess_hub_peers'); } catch { return null; } },
  saveBook: j => { try { localStorage.setItem('smess_hub_peers', j); } catch { /* */ } },
};

const feed: HubFeedItem[] = [];
const feedListeners = new Set<(f: HubFeedItem[]) => void>();
const pushFeed = (m: HubFeedItem) => {
  feed.push(m);
  if (feed.length > 200) feed.shift();
  feedListeners.forEach(l => l([...feed]));
};
const note = (text: string) => pushFeed({ at: Date.now(), name: 'Аварийная сеть', text, kind: 'note' });

const sealer = new Sealer(hubStore, note);

const hex = (b: Uint8Array) => Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
const unhex = (s: string) => Uint8Array.from(s.match(/../g) || [], x => parseInt(x, 16));
const b64 = {
  enc: (u: Uint8Array) => { let s = ''; for (const x of u) s += String.fromCharCode(x); return btoa(s); },
  dec: (s: string) => Uint8Array.from(atob(s), c => c.charCodeAt(0)),
};
/** Псевдономер узла для Sealer — последние 4 байта адреса */
const nodeOf = (a: Uint8Array) => ((a[2] << 24) | (a[3] << 16) | (a[4] << 8) | a[5]) >>> 0;

let selfAddr: Uint8Array | null = null;
function self(): Uint8Array {
  if (selfAddr) return selfAddr;
  sealer.ensureIdentity();
  if (sealer.active) {
    selfAddr = sealer.self();
  } else {
    // Открытая сборка без подписей: постоянный случайный адрес устройства
    let s = '';
    try { s = localStorage.getItem('smess_hub_dev') || ''; } catch { /* */ }
    if (!/^[0-9a-f]{12}$/.test(s)) {
      s = hex(crypto.getRandomValues(new Uint8Array(6)));
      try { localStorage.setItem('smess_hub_dev', s); } catch { /* */ }
    }
    selfAddr = unhex(s);
  }
  sealer.init(nodeOf(selfAddr));
  return selfAddr;
}

// ── мост к узлу на устройстве ───────────────────────────────────
interface Native {
  start(name: string): Promise<{ ok: boolean; port?: number; hub?: string; urls?: string[]; error?: string }>;
  stop(): Promise<void>;
  status(): Promise<{ running: boolean; port: number; hub: string; clients: number }>;
}
function native(): Native | null {
  const desk = (window as any).electronAPI;
  if (desk?.hubStart) return {
    start: name => desk.hubStart(name),
    stop: () => desk.hubStop(),
    status: () => desk.hubStatus(),
  };
  const br = (window as any).AndroidBridge;
  if (br?.hubStart) return {
    start: async name => JSON.parse(br.hubStart(name)),
    stop: async () => { br.hubStop(); },
    status: async () => JSON.parse(br.hubStatus()),
  };
  return null;
}
/** Аварийная сеть есть только в приложении (APK, ПК): сайту в браузере некуда поднять узел и нечем искать соседей */
export const hubSupported = () => !!native();

// ── соединение ──────────────────────────────────────────────────
interface Sock { send(s: string): boolean; close(): void }
interface SockEvents { open(): void; msg(s: string): void; close(why: string): void }

function openSock(url: string, ev: SockEvents): Sock {
  const br = (window as any).AndroidBridge;
  if (br?.hubWsOpen) {
    // Страница APK грузится как https — обычный ws:// WebView не пустит
    let id = '';
    let done = false;
    const on = (e: Event) => {
      const d = (e as CustomEvent).detail;
      if (!d || d.id !== id || done) return;
      if (d.kind === 'open') ev.open();
      else if (d.kind === 'msg') ev.msg(String(d.data));
      else if (d.kind === 'close') { done = true; window.removeEventListener('hub-ws', on); ev.close(d.data?.reason || 'закрыто'); }
    };
    window.addEventListener('hub-ws', on);
    id = String(br.hubWsOpen(url));
    return {
      send: s => !!br.hubWsSend(id, s),
      close: () => { if (!done) { done = true; window.removeEventListener('hub-ws', on); br.hubWsClose(id); } },
    };
  }
  let ws: WebSocket;
  let done = false;
  try { ws = new WebSocket(url); } catch (e) { setTimeout(() => ev.close((e as Error).message), 0); return { send: () => false, close: () => {} }; }
  ws.onopen = () => ev.open();
  ws.onmessage = e => { if (typeof e.data === 'string') ev.msg(e.data); };
  ws.onclose = e => { if (!done) { done = true; ev.close(e.reason || `код ${e.code}`); } };
  return {
    send: s => { if (ws.readyState !== WebSocket.OPEN) return false; ws.send(s); return true; },
    close: () => { done = true; try { ws.close(); } catch { /* */ } },
  };
}

class HubLink {
  private sock: Sock | null = null;
  private ping: ReturnType<typeof setInterval> | null = null;
  ready = false;
  hub = '';
  name = '';
  clients = 0;

  constructor(readonly url: string, private ev: { ready(l: HubLink): void; msg(f: Envelope, seq: number): void; info(l: HubLink): void; gone(l: HubLink, why: string): void }) {}

  open() {
    const opened = setTimeout(() => this.sock?.close(), 8000);
    this.sock = openSock(this.url, {
      open: () => {
        clearTimeout(opened);
        const last = lastSeen();
        this.sock!.send(JSON.stringify({ t: 'hello', v: 1, dev: hex(self()), hub: last.hub, since: last.seq }));
        this.ping = setInterval(() => this.sock?.send('{"t":"ping"}'), 20_000);
      },
      msg: s => this.onFrame(s),
      close: why => { clearTimeout(opened); this.shut(); this.ev.gone(this, why); },
    });
  }

  private onFrame(s: string) {
    let o: any;
    try { o = JSON.parse(s); } catch { return; }
    if (o.t === 'welcome') {
      this.ready = true;
      this.hub = String(o.hub || '');
      this.name = String(o.name || '');
      this.clients = Number(o.clients) || 0;
      // Другой узел — его номера сообщений с нашими не сравнимы
      if (lastSeen().hub !== this.hub) saveSeen(this.hub, 0);
      this.ev.ready(this);
    } else if (o.t === 'msg' && o.f) {
      if (Number(o.seq) > lastSeen().seq) saveSeen(this.hub, Number(o.seq));
      this.ev.msg(o.f, Number(o.seq));
    } else if (o.t === 'peers') {
      this.clients = Number(o.clients) || 0;
      this.ev.info(this);
    } else if (o.t === 'err') {
      console.warn('[hub] узел отказал:', o.error);
    }
  }

  send(f: Envelope): boolean { return this.ready && !!this.sock?.send(JSON.stringify({ t: 'pub', f })); }

  private shut() { if (this.ping) clearInterval(this.ping); this.ping = null; this.ready = false; }
  close() { this.shut(); const s = this.sock; this.sock = null; s?.close(); }
}

function lastSeen(): { hub: string; seq: number } {
  try { const j = JSON.parse(localStorage.getItem('smess_hub_last') || '{}'); return { hub: String(j.hub || ''), seq: Number(j.seq) || 0 }; } catch { return { hub: '', seq: 0 }; }
}
function saveSeen(hub: string, seq: number) {
  try { localStorage.setItem('smess_hub_last', JSON.stringify({ hub, seq })); } catch { /* */ }
}

// ── состояние ───────────────────────────────────────────────────
let status: HubStatus = { state: 'off', manual: false, self: false, hubName: '', hubId: '', clients: 0, url: '' };
const listeners = new Set<(s: HubStatus) => void>();
const setStatus = (s: Partial<HubStatus>) => { status = { ...status, ...s }; listeners.forEach(l => l(status)); };
export const getHubStatus = () => status;
export function onHubStatus(l: (s: HubStatus) => void) { listeners.add(l); l(status); return () => { listeners.delete(l); }; }
export function onHubFeed(l: (f: HubFeedItem[]) => void) { feedListeners.add(l); l([...feed]); return () => { feedListeners.delete(l); }; }

/** Разрешить этому устройству становиться сервером (по умолчанию да) */
export function hubAllowServe(v?: boolean): boolean {
  try {
    if (v !== undefined) localStorage.setItem('smess_hub_serve', v ? '1' : '0');
    return localStorage.getItem('smess_hub_serve') !== '0';
  } catch { return true; }
}

// ── приём ───────────────────────────────────────────────────────
interface Env {
  chatKnown(chatId: string): boolean;
  senderName(chatId: string, userId: string): string;
  deviceName(): string;
  mainUp(): boolean;
  discover(): Promise<Array<{ mode?: string; hub?: string; name?: string; urls?: string[] }>>;
  visible(): boolean;
}
let env: Env | null = null;

const seen = new Set<string>();
function remember(key: string): boolean {
  if (seen.has(key)) return false;
  seen.add(key);
  if (seen.size > 4000) seen.delete(seen.values().next().value as string);
  return true;
}

// Подпись доказывает устройство, а не человека: в CHAT любое устройство
// может назваться любым участником. Поэтому помним, какими ключами
// подписывался каждый участник, и новый ключ у знакомого — повод
// насторожиться (сменил телефон или подделка).
function senderKeyTrust(senderId: string, key: string, name: string, trust: Trust): Trust {
  if (trust === 'none') return trust;
  try {
    const pins = JSON.parse(localStorage.getItem('smess_hub_senders') || '{}');
    const known: string[] = pins[senderId] || [];
    if (known.includes(key)) return trust;
    if (known.length) {
      note(`${name}: сообщение подписано новым устройством (${key}). Если не ждали — это может быть подделка`);
      pins[senderId] = [...known, key].slice(-4);
      localStorage.setItem('smess_hub_senders', JSON.stringify(pins));
      return 'none';
    }
    pins[senderId] = [key];
    localStorage.setItem('smess_hub_senders', JSON.stringify(pins));
  } catch { /* */ }
  return trust;
}

function onEnvelope(f: Envelope) {
  if (!f || typeof f.from !== 'string' || !/^[0-9a-f]{12}$/i.test(f.from)) return;
  if (!remember(`${f.from.toLowerCase()}:${f.msgId}`)) return;
  const from = unhex(f.from.toLowerCase());
  const me = self();
  if (from.every((x, i) => x === me[i])) return; // своё эхо
  let body: Uint8Array;
  try { body = b64.dec(f.body || ''); } catch { return; }
  const to = unhex(String(f.to || ALL).toLowerCase());
  const o = sealer.open(nodeOf(from), { type: f.type >>> 0, msgId: f.msgId >>> 0, from, to }, body);
  if (!o) {
    note(`Сообщение от устройства ${idOf(from)} не прошло проверку подписи — отброшено`);
    return;
  }
  if (o.type === SMESH_T_CHAT) {
    const c = decodeChatBody(o.body);
    if (!c || !env?.chatKnown(c.chatId)) return; // только в свои чаты
    const name = env.senderName(c.chatId, c.senderId);
    const trust = senderKeyTrust(c.senderId, idOf(from), name, o.trust);
    window.dispatchEvent(new CustomEvent('mesh-message', { detail: {
      id: c.clientId, cid: c.clientId, chatId: c.chatId, userId: c.senderId,
      name, text: c.text, ts: Date.now(), hops: 0, via: 'hub', trust,
    } }));
  } else if (o.type === SMESH_T_TEXT) {
    let name = idOf(from), text = '';
    try { const j = JSON.parse(new TextDecoder().decode(o.body)); name = String(j.n || name); text = String(j.t || ''); }
    catch { text = new TextDecoder().decode(o.body); }
    if (text) pushFeed({ at: Date.now(), name, text, trust: o.trust, kind: 'msg' });
  }
}

// ── отправка ────────────────────────────────────────────────────
function envelope(type: number, body: Uint8Array): Envelope | null {
  const me = self();
  const msgId = crypto.getRandomValues(new Uint32Array(1))[0];
  const s = sealer.seal({ type, msgId, from: me, to: SMESH_ALL }, body);
  if (!s) return null;
  remember(`${hex(me)}:${msgId}`);
  return { type: s.type, msgId, from: hex(s.from), to: ALL, body: b64.enc(s.body) };
}

/** Сообщение чата через аварийную сеть (тот же client_id, что уйдёт на сервер). true — ушло. */
export function hubSendChat(chatId: string, senderId: string, clientId: string, text: string): boolean {
  if (!link?.ready) return false;
  try {
    const f = envelope(SMESH_T_CHAT, encodeChatBody({ chatId, senderId, clientId, text }));
    return !!f && link.send(f);
  } catch (e) {
    console.warn('[hub] сообщение чата не упаковалось:', (e as Error).message);
    return false;
  }
}

/** «Сказать всем» в ленту аварийной сети. Ошибка — текстом. */
export function hubSay(name: string, text: string): string | null {
  if (!link?.ready) return 'Аварийная сеть не подключена';
  const f = envelope(SMESH_T_TEXT, new TextEncoder().encode(JSON.stringify({ n: name, t: text })));
  if (!f || !link.send(f)) return 'Не ушло — узел недоступен';
  pushFeed({ at: Date.now(), name, text, trust: sealer.active ? 'signed' : 'none', kind: 'msg', own: true });
  return null;
}

export const hubSelfId = () => (sealer.available ? idOf(self()) : '');
export const hubProtected = () => sealer.available;

// ── контроллер ──────────────────────────────────────────────────
let link: HubLink | null = null;
let ownPort = 0;
let ownHubId = '';
let ownStopAt = 0;
let wanted = false;
let manual = false;
let downSince = 0;
let upSince = 0;
let sawDown = false;  // пока сеть включена, основной пропадал
let lastSearch = 0;
let busy = false;
let timer: ReturnType<typeof setInterval> | null = null;

function connect(url: string, hubId: string, own: boolean): Promise<boolean> {
  return new Promise(resolve => {
    let settled = false;
    const l = new HubLink(url, {
      ready: x => {
        if (!settled) { settled = true; resolve(true); }
        link?.close();
        link = x;
        setStatus({ state: own ? 'serving' : 'joined', self: own, hubName: x.name, hubId: x.hub || hubId, clients: x.clients, url, error: undefined });
      },
      msg: f => onEnvelope(f),
      info: x => { if (link === x) setStatus({ clients: x.clients }); },
      gone: (x, why) => {
        if (!settled) { settled = true; resolve(false); return; }
        if (link !== x) return;
        link = null;
        if (wanted) { setStatus({ state: 'searching', self: false, error: `связь с узлом потеряна: ${why}` }); lastSearch = 0; }
        else setStatus({ state: 'off', self: false });
      },
    });
    l.open();
    setTimeout(() => { if (!settled) { settled = true; l.close(); resolve(false); } }, 10_000);
  });
}

async function search() {
  if (!env) return;
  lastSearch = Date.now();
  const found = (await env.discover().catch(() => []))
    .filter(s => s.mode === 'hub' && typeof s.hub === 'string' && s.hub !== ownHubId && (s.urls || []).length)
    .sort((a, b) => (a.hub! < b.hub! ? -1 : 1));
  const best = found[0];
  const current = status.hubId;
  // Уже в узле с меньшим номером — оставаться
  if (best && link?.ready && current && current <= best.hub!) return;
  if (best) {
    for (const u of best.urls!) {
      if (await connect(u, best.hub!, false)) {
        if (ownPort) ownStopAt = Date.now() + STOP_OWN_AFTER_MS;
        return;
      }
    }
  }
  if (link?.ready) return;
  // Никого — становимся сервером сами. Без человека у экрана не поднимаем:
  // узел держит Wi-Fi и процессор, а сам по себе ушедший в фон сокет — не авария.
  const n = native();
  if (!n || !hubAllowServe() || !(manual || env.visible())) {
    setStatus({ state: 'searching', error: n && hubAllowServe() ? undefined : 'узлов рядом нет, а этому устройству быть сервером не разрешено' });
    return;
  }
  const r = await n.start(env.deviceName()).catch(e => ({ ok: false, error: (e as Error).message } as const));
  if (!r.ok || !r.port) { setStatus({ state: 'searching', error: r.error || 'узел не запустился' }); return; }
  ownPort = r.port;
  ownHubId = r.hub || '';
  ownStopAt = 0;
  if (!(await connect(`ws://127.0.0.1:${r.port}/hub`, ownHubId, true))) setStatus({ state: 'searching', error: 'свой узел поднят, но подключиться к нему не вышло' });
}

async function stopOwn() {
  if (!ownPort) return;
  ownPort = 0;
  ownStopAt = 0;
  await native()?.stop().catch(() => {});
}

async function tick() {
  if (!env || busy) return;
  busy = true;
  try {
    const now = Date.now();
    if (env.mainUp()) { downSince = 0; upSince = upSince || now; }
    else { upSince = 0; downSince = downSince || now; }

    if (!manual && !wanted && downSince && now - downSince >= DOWN_AFTER_MS) {
      wanted = true;
      note('Основной сервер недоступен — включаю аварийную сеть');
    }
    // Авария — это пропажа дольше порога, а не секунды, пока сокет
    // подключается после запуска приложения
    if (wanted && downSince && now - downSince >= DOWN_AFTER_MS) sawDown = true;
    // Включённая кнопкой при живом основном — это выбор человека (офис без
    // интернета, проба), её не трогаем. Пережила пропажу основного — гаснет
    // вместе с аварией, как и включённая сама.
    if (wanted && upSince && now - upSince >= UP_AFTER_MS && (!manual || sawDown)) {
      wanted = false;
      manual = false;
      sawDown = false;
      setStatus({ manual: false });
      note('Основной сервер снова доступен — аварийная сеть выключена, накопленное уйдёт на сервер');
    }

    if (!wanted) {
      if (link) { link.close(); link = null; }
      // Свой узел гасим, когда в нём никого, кроме нас
      if (ownPort) {
        const st = await native()?.status().catch(() => null);
        if (!st?.running || (st.clients || 0) === 0) await stopOwn();
      }
      if (status.state !== 'off') setStatus({ state: 'off', self: false, hubName: '', hubId: '', clients: 0, url: '' });
      return;
    }

    if (status.state === 'off') setStatus({ state: 'searching', error: undefined });
    if (!link?.ready || now - lastSearch >= SEARCH_EVERY_MS) await search();

    // Перешли к чужому узлу — свой погасить, когда к нему никто не придёт
    if (ownPort && status.state === 'joined' && ownStopAt && now >= ownStopAt) {
      const st = await native()?.status().catch(() => null);
      if (!st?.running || (st.clients || 0) === 0) await stopOwn();
      else ownStopAt = now + STOP_OWN_AFTER_MS;
    }
  } finally {
    busy = false;
  }
}

/** Кнопка «Включить аварийную сеть» */
export function hubEnable() {
  manual = true;
  wanted = true;
  lastSearch = 0;
  setStatus({ manual: true });
  void tick();
}

/** Кнопка «Выключить» — до следующей пропажи основного сервера */
export function hubDisable() {
  manual = false;
  wanted = false;
  downSince = 0;
  sawDown = false;
  setStatus({ manual: false });
  void tick();
}

/** Запуск контроллера (один раз, из приложения) */
export function startHubController(e: Env) {
  env = e;
  if (timer || !hubSupported()) return;
  // Свой узел мог пережить перезагрузку страницы (ПК: живёт в главном
  // процессе; Android: служба вернула его после убийства процесса).
  native()?.status().then(st => {
    if (st?.hub) ownHubId = st.hub;
    if (st?.running && st.port) ownPort = st.port;
  }).catch(() => {}).finally(() => {
    timer = setInterval(() => { void tick(); }, TICK_MS);
    void tick();
  });
}

/** Для проверки: остановить всё и забыть состояние */
export function _resetHubForTest() {
  if (timer) clearInterval(timer);
  timer = null;
  link?.close();
  link = null;
  ownPort = 0; ownHubId = ''; ownStopAt = 0; wanted = false; manual = false; downSince = 0; upSince = 0; sawDown = false; lastSearch = 0; busy = false;
  seen.clear();
  feed.length = 0;
  selfAddr = null;
  status = { state: 'off', manual: false, self: false, hubName: '', hubId: '', clients: 0, url: '' };
}
export const _tickForTest = tick;
