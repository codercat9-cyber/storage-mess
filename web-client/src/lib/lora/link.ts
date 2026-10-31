// =============================================================
// Звено «приложение ↔ свой узел Meshtastic» — поверх любого канала.
//
// Каналы:  BLE в APK (голый protobuf в характеристиках, Java делает
//          только GATT — см. MeshtasticBle.java) · USB/Web Serial в
//          браузере и на десктопе (кадры 0x94C3).
// Звено держит подключение (want_config, сердцебиение), список узлов,
// шлёт сообщения чата кадрами CHAT и принимает их. Принятое уходит
// приложению тем же событием, что и BLE-mesh ('mesh-message') — с
// client_id, так что копии из LoRa склеиваются с серверными.
//
// Содержимое в открытой сборке не шифруется: канал Meshtastic по
// умолчанию общий, его ключ публичен. Интерфейс об этом предупреждает.
// =============================================================

import {
  FrameParser, decodeFromRadio, encodeWantConfig, encodeHeartbeat, encodeSend, frame, WAKE,
  MT_BROADCAST, MT_PORT_TEXT, MT_PORT_PRIVATE, MtPacket,
} from './meshtastic';
import {
  addrFromNode, split, decodeFrame, Reassembler, SMESH_ALL, SMESH_T_CHAT, SMESH_T_TEXT,
  encodeChatBody, decodeChatBody, ChatBody,
} from './smesh';

export interface LoraTransport {
  /** true — канал сам режет на сообщения (BLE), false — поток байт (UART) */
  readonly framed: boolean;
  write(data: Uint8Array): Promise<void> | void;
  onData(cb: (data: Uint8Array) => void): void;
  close(): void;
}

export type LinkState = 'connecting' | 'ready' | 'closed';

export interface LinkEvents {
  state?: (s: LinkState, info: { myNum: number; nodes: number }) => void;
  chat?: (m: ChatBody & { fromNode: number; via: 'lora' }) => void;
  text?: (m: { fromNode: number; name: string; text: string }) => void;
}

const rand32 = () => (crypto.getRandomValues(new Uint32Array(1))[0] || 1) >>> 0;
const FRAME_GAP_MS = 1500; // кадр LongFast в эфире ~1 с; без паузы куски копятся в очереди узла

export class LoraLink {
  myNum = 0;
  nodes = new Map<number, { name: string; lastHeard: number }>();
  state: LinkState = 'connecting';
  channel = 0;
  private cfgId = 0;
  private parser: FrameParser;
  private rx = new Reassembler();
  private hb: ReturnType<typeof setInterval> | null = null;
  private retry: ReturnType<typeof setInterval> | null = null;
  private lastFrame = 0;
  private sendChain: Promise<void> = Promise.resolve();

  constructor(private t: LoraTransport, private ev: LinkEvents = {}) {
    this.parser = new FrameParser(f => this.onFromRadio(f));
    t.onData(d => (t.framed ? this.onFromRadio(d) : this.parser.push(d)));
  }

  start() {
    this.ask();
    // Пока узел льёт настройки — не перезапрашиваем (см. smess-lora, app.c)
    this.retry = setInterval(() => { if (this.state !== 'ready' && Date.now() - this.lastFrame > 8000) this.ask(); }, 2000);
    this.hb = setInterval(() => { if (this.state === 'ready') this.out(encodeHeartbeat(rand32())); }, 60000);
  }

  close() {
    if (this.hb) clearInterval(this.hb);
    if (this.retry) clearInterval(this.retry);
    this.state = 'closed';
    this.t.close();
    this.emitState();
  }

  /** Сообщение чата мессенджера — в эфир. Возвращает число кадров. */
  sendChat(m: ChatBody): Promise<number> {
    const body = encodeChatBody(m);
    const frames = split(SMESH_T_CHAT, rand32(), addrFromNode(this.myNum), SMESH_ALL, body);
    return this.queue(frames.map(f => encodeSend({ to: MT_BROADCAST, channel: this.channel, portnum: MT_PORT_PRIVATE, payload: f, id: rand32() })))
      .then(() => frames.length);
  }

  /** Обычный текст Meshtastic — виден в их приложениях. */
  sendText(text: string): Promise<number> {
    const payload = new TextEncoder().encode(text).slice(0, 200);
    return this.queue([encodeSend({ to: MT_BROADCAST, channel: this.channel, portnum: MT_PORT_TEXT, payload, id: rand32() })]).then(() => 1);
  }

  private queue(bodies: Uint8Array[]): Promise<void> {
    const run = this.sendChain.then(async () => {
      for (let i = 0; i < bodies.length; i++) {
        if (i) await new Promise(r => setTimeout(r, FRAME_GAP_MS));
        await this.out(bodies[i]);
      }
    });
    this.sendChain = run.catch(() => {});
    return run;
  }

  private async out(body: Uint8Array) {
    await this.t.write(this.t.framed ? body : frame(body));
  }

  private ask() {
    this.cfgId = rand32();
    if (!this.t.framed) this.t.write(WAKE);
    setTimeout(() => this.out(encodeWantConfig(this.cfgId)), this.t.framed ? 0 : 150);
    this.lastFrame = Date.now();
  }

  private emitState() {
    this.ev.state?.(this.state, { myNum: this.myNum, nodes: this.nodes.size });
  }

  private onFromRadio(f: Uint8Array) {
    const m = decodeFromRadio(f);
    if (!m) return;
    this.lastFrame = Date.now();
    switch (m.kind) {
      case 'myInfo': this.myNum = m.myNodeNum; break;
      case 'nodeInfo': this.nodes.set(m.node.num, { name: m.node.shortName || m.node.longName, lastHeard: m.node.lastHeard }); break;
      case 'configComplete':
        if (this.state !== 'ready') { this.state = 'ready'; this.emitState(); }
        break;
      case 'rebooted': this.state = 'connecting'; this.emitState(); break;
      case 'packet': this.onPacket(m.packet); break;
      default: break;
    }
  }

  private onPacket(p: MtPacket) {
    if (!p.hasDecoded || p.from === this.myNum) return;
    const name = this.nodes.get(p.from)?.name || '!' + p.from.toString(16).padStart(8, '0');
    if (p.portnum === MT_PORT_TEXT) {
      this.ev.text?.({ fromNode: p.from, name, text: new TextDecoder().decode(p.payload) });
      return;
    }
    if (p.portnum !== MT_PORT_PRIVATE) return;
    const f = decodeFrame(p.payload);
    if (!f) return;
    const done = this.rx.push(f);
    if (!done) return;
    if (done.type === SMESH_T_CHAT) {
      const c = decodeChatBody(done.body);
      if (c) this.ev.chat?.({ ...c, fromNode: p.from, via: 'lora' });
    } else if (done.type === SMESH_T_TEXT) {
      this.ev.text?.({ fromNode: p.from, name, text: new TextDecoder().decode(done.body) });
    }
  }
}
