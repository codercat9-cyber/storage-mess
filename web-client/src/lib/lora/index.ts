// =============================================================
// LoRa в приложении: подключение своего узла Meshtastic и обмен.
//   • APK — по Bluetooth (AndroidBridge.mt*, Java только GATT);
//   • браузер/десктоп — по USB через Web Serial.
// Сообщения чатов уходят кадрами CHAT; принятое отдаётся событием
// 'mesh-message' (как BLE-mesh) — приложение склеит по client_id.
// =============================================================

import { LoraLink, LoraTransport, LinkState } from './link';
import { useChatStore } from '@/store/chat';

export interface LoraStatus { state: LinkState | 'off'; via: 'ble' | 'serial' | null; myNum: number; nodes: number; name?: string }
export interface AirMessage { at: number; name: string; text: string }

let link: LoraLink | null = null;
let via: LoraStatus['via'] = null;
let status: LoraStatus = { state: 'off', via: null, myNum: 0, nodes: 0 };
const air: AirMessage[] = [];
const listeners = new Set<(s: LoraStatus) => void>();
const airListeners = new Set<(a: AirMessage[]) => void>();

const setStatus = (s: Partial<LoraStatus>) => {
  status = { ...status, ...s };
  listeners.forEach(l => l(status));
};
export const getLoraStatus = () => status;
export const getAir = () => [...air];
export function onLoraStatus(l: (s: LoraStatus) => void) { listeners.add(l); l(status); return () => listeners.delete(l); }
export function onAir(l: (a: AirMessage[]) => void) { airListeners.add(l); l([...air]); return () => airListeners.delete(l); }

const bridge = () => (window as any).AndroidBridge;
export const hasBle = () => !!bridge()?.mtConnect;
export const hasSerial = () => typeof navigator !== 'undefined' && 'serial' in navigator;

function senderName(chatId: string, userId: string): string {
  const chat = useChatStore.getState().chats.find(c => c.id === chatId) as any;
  const m = chat?.members?.find((x: any) => (x.id || x.user_id) === userId);
  return m?.display_name || m?.username || 'LoRa';
}

function attach(t: LoraTransport, how: 'ble' | 'serial') {
  link?.close();
  via = how;
  link = new LoraLink(t, {
    state: (s, info) => setStatus({ state: s, via, myNum: info.myNum, nodes: info.nodes }),
    chat: m => {
      // Только в свои чаты — эфир общий
      if (!useChatStore.getState().chats.some(c => c.id === m.chatId)) return;
      window.dispatchEvent(new CustomEvent('mesh-message', { detail: {
        id: m.clientId, cid: m.clientId, chatId: m.chatId, userId: m.senderId,
        name: senderName(m.chatId, m.senderId), text: m.text, ts: Date.now(), hops: 0, via: 'lora',
      } }));
    },
    text: m => {
      air.push({ at: Date.now(), name: m.name, text: m.text });
      if (air.length > 100) air.shift();
      airListeners.forEach(l => l([...air]));
    },
  });
  setStatus({ state: 'connecting', via, myNum: 0, nodes: 0 });
  link.start();
}

// ── APK: Bluetooth ─────────────────────────────────────────────
const b64 = {
  enc: (u: Uint8Array) => btoa(String.fromCharCode(...u)),
  dec: (s: string) => Uint8Array.from(atob(s), c => c.charCodeAt(0)),
};

export function scanBle(): void { bridge()?.mtScan?.(); }

export function connectBle(address: string, name?: string): void {
  const br = bridge();
  if (!br?.mtConnect) throw new Error('В этой сборке нет Bluetooth-моста к Meshtastic');
  const handlers: ((d: Uint8Array) => void)[] = [];
  const onData = (e: Event) => { const d = b64.dec((e as CustomEvent).detail?.b64 || ''); handlers.forEach(h => h(d)); };
  const onState = (e: Event) => { if ((e as CustomEvent).detail?.state === 'disconnected') setStatus({ state: 'closed' }); };
  window.addEventListener('mt-fromradio', onData);
  window.addEventListener('mt-state', onState);
  attach({
    framed: true,
    write: d => { br.mtWrite(b64.enc(d)); },
    onData: cb => { handlers.push(cb); },
    close: () => { window.removeEventListener('mt-fromradio', onData); window.removeEventListener('mt-state', onState); br.mtDisconnect?.(); },
  }, 'ble');
  setStatus({ name });
  br.mtConnect(address);
  try { localStorage.setItem('lora_ble_addr', address); localStorage.setItem('lora_ble_name', name || ''); } catch { /* */ }
}

// ── браузер/десктоп: USB (Web Serial) ──────────────────────────
export async function connectSerial(): Promise<void> {
  const serial = (navigator as any).serial;
  if (!serial) throw new Error('Браузер не умеет Web Serial (нужен Chrome/Edge или наш десктоп)');
  const port = await serial.requestPort();
  await port.open({ baudRate: 115200 });
  const writer = port.writable.getWriter();
  const handlers: ((d: Uint8Array) => void)[] = [];
  let reading = true;
  (async () => {
    const reader = port.readable.getReader();
    try {
      while (reading) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) handlers.forEach(h => h(value));
      }
    } catch { /* порт отключили */ } finally { reader.releaseLock(); setStatus({ state: 'closed' }); }
  })();
  attach({
    framed: false,
    write: d => writer.write(d),
    onData: cb => { handlers.push(cb); },
    close: () => { reading = false; writer.releaseLock(); port.close().catch(() => {}); },
  }, 'serial');
}

export function disconnectLora() { link?.close(); link = null; setStatus({ state: 'off', via: null }); }

/** Отправка сообщения чата в LoRa, если узел подключён. true — ушло. */
export async function loraSendChat(chatId: string, senderId: string, clientId: string, text: string): Promise<boolean> {
  if (!link || link.state !== 'ready') return false;
  try { await link.sendChat({ chatId, senderId, clientId, text }); return true; } catch { return false; }
}

export async function loraSendAir(text: string): Promise<boolean> {
  if (!link || link.state !== 'ready') return false;
  try { await link.sendText(text); return true; } catch { return false; }
}

/** APK: переподключиться к последнему узлу при старте. */
export function autoReconnect() {
  try {
    const a = localStorage.getItem('lora_ble_addr');
    if (a && hasBle() && !link) connectBle(a, localStorage.getItem('lora_ble_name') || undefined);
  } catch { /* */ }
}
