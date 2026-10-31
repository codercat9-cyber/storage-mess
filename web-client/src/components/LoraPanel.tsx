import { useEffect, useState } from 'react';
import {
  onLoraStatus, onAir, LoraStatus, AirMessage, hasBle, hasSerial, scanBle, connectBle, connectSerial,
  disconnectLora, loraSendAir,
} from '@/lib/lora';

/** Настройки → LoRa: свой узел Meshtastic, эфир, аварийная связь без интернета. */
export default function LoraPanel() {
  const [st, setSt] = useState<LoraStatus | null>(null);
  const [air, setAir] = useState<AirMessage[]>([]);
  const [found, setFound] = useState<{ address: string; name: string; rssi: number }[]>([]);
  const [scanning, setScanning] = useState(false);
  const [note, setNote] = useState('');
  const [say, setSay] = useState('');

  useEffect(() => {
    const u1 = onLoraStatus(setSt);
    const u2 = onAir(setAir);
    const onScan = (e: Event) => {
      const d = (e as CustomEvent).detail;
      setFound(list => (list.some(x => x.address === d.address) ? list : [...list, d]));
    };
    const onState = (e: Event) => {
      const s = (e as CustomEvent).detail?.state;
      if (s === 'need-permission') setNote('Разрешите Bluetooth и нажмите «Найти» ещё раз');
      if (s === 'bluetooth-off') setNote('Включите Bluetooth');
      if (s === 'no-service') setNote('Это не узел Meshtastic');
      if (s !== 'scanning') setScanning(false);
    };
    window.addEventListener('mt-scan', onScan);
    window.addEventListener('mt-state', onState);
    return () => { u1(); u2(); window.removeEventListener('mt-scan', onScan); window.removeEventListener('mt-state', onState); };
  }, []);

  const state = st?.state || 'off';
  const label = state === 'ready'
    ? `на связи · узел !${(st?.myNum || 0).toString(16)} · в сети ${st?.nodes} узл.`
    : state === 'connecting' ? 'подключаюсь… (при первом подключении узел попросит PIN с экрана)'
    : state === 'closed' ? 'отключён' : 'не подключён';

  return (
    <div className="px-5 py-4 space-y-3">
      <div className="text-[16px] font-medium text-messenger-text">📡 LoRa (Meshtastic)</div>
      <div className="text-[13px] text-messenger-muted leading-snug">
        Связь без интернета и сотовой сети на километры: подключите свой узел Meshtastic. Когда сервер недоступен,
        сообщения чатов уходят в эфир, а пришедшее по эфиру появляется в чатах.
      </div>
      <div className="text-[12px] rounded-lg bg-orange-500/10 text-orange-300 px-3 py-2 leading-snug">
        Канал общий: без шифрования сообщения в эфире слышат все узлы в радиусе. Это аварийная связь — личное лучше не писать.
      </div>
      <div className="text-[14px]">Узел: <b>{label}</b></div>

      <div className="flex flex-wrap gap-2">
        {hasBle() && state !== 'ready' && (
          <button onClick={() => { setFound([]); setNote(''); setScanning(true); scanBle(); }}
                  className="px-3 py-2 rounded-xl bg-primary-500 text-white text-sm">{scanning ? 'Ищу…' : 'Найти узел по Bluetooth'}</button>
        )}
        {hasSerial() && state !== 'ready' && (
          <button onClick={() => connectSerial().catch(e => setNote(String(e?.message || e)))}
                  className="px-3 py-2 rounded-xl bg-primary-500 text-white text-sm">Подключить по USB</button>
        )}
        {state !== 'off' && (
          <button onClick={disconnectLora} className="px-3 py-2 rounded-xl bg-messenger-hover text-sm">Отключить</button>
        )}
        {!hasBle() && !hasSerial() && <div className="text-[13px] text-messenger-muted">Здесь подключить узел нельзя: нужен телефон с нашим приложением, Chrome или десктоп.</div>}
      </div>
      {note && <div className="text-[13px] text-orange-300">{note}</div>}

      {found.length > 0 && state !== 'ready' && (
        <div className="space-y-1">
          {found.map(d => (
            <button key={d.address} onClick={() => { connectBle(d.address, d.name); setFound([]); }}
                    className="w-full text-left px-3 py-2 rounded-lg bg-messenger-hover/60 text-sm flex justify-between">
              <span>{d.name}</span><span className="text-messenger-muted">{d.rssi} dBm</span>
            </button>
          ))}
        </div>
      )}

      {state === 'ready' && (
        <div className="space-y-2">
          <div className="text-[13px] text-messenger-muted">Эфир (общий канал Meshtastic):</div>
          <div className="max-h-48 overflow-y-auto space-y-1 text-[13px]">
            {air.length === 0 && <div className="text-messenger-muted">пока тихо</div>}
            {air.slice(-30).map((m, i) => (
              <div key={i}><span className="text-messenger-muted">{new Date(m.at).toLocaleTimeString('ru-RU')} </span><b>{m.name}:</b> {m.text}</div>
            ))}
          </div>
          <div className="flex gap-2">
            <input value={say} onChange={e => setSay(e.target.value)} maxLength={200} placeholder="Сказать в эфир"
                   className="flex-1 rounded-lg bg-messenger-hover/60 px-3 py-2 text-sm outline-none" />
            <button disabled={!say.trim()} onClick={async () => { if (await loraSendAir(say.trim())) setSay(''); }}
                    className="px-3 py-2 rounded-xl bg-primary-500 text-white text-sm disabled:opacity-40">Отправить</button>
          </div>
        </div>
      )}
    </div>
  );
}
