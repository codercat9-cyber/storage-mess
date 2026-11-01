import { useEffect, useState } from 'react';
import {
  onHubStatus, onHubFeed, HubStatus, HubFeedItem, hubSupported, hubEnable, hubDisable, hubAllowServe, hubSay,
  hubSelfId, hubProtected,
} from '@/lib/hub';
import { useAuthStore } from '@/store/auth';

/** Одной строкой: кто сейчас сервер аварийной сети. Для плашки в списке чатов и здесь. */
export function hubLabel(st: HubStatus): string {
  if (st.state === 'serving') return `сервер — это устройство · участников: ${st.clients}`;
  if (st.state === 'joined') return `через «${st.hubName || 'аварийный узел'}» · участников: ${st.clients}`;
  if (st.state === 'searching') return 'ищу аварийный сервер рядом…';
  return 'выключена';
}

/** Лента «Эфир аварийной сети» и поле «Сказать всем» — в Настройках и в окне из списка чатов. */
export function HubFeedView({ tall = false }: { tall?: boolean }) {
  const [st, setSt] = useState<HubStatus | null>(null);
  const [feed, setFeed] = useState<HubFeedItem[]>([]);
  const [say, setSay] = useState('');
  const [err, setErr] = useState('');
  useEffect(() => {
    const u1 = onHubStatus(setSt);
    const u2 = onHubFeed(setFeed);
    return () => { u1(); u2(); };
  }, []);
  const state = st?.state || 'off';
  const me = useAuthStore.getState().user;
  const name = me?.display_name || me?.username || 'Я';
  const send = () => {
    const e = hubSay(name, say.trim());
    if (e) setErr(e); else { setSay(''); setErr(''); }
  };
  return (
    <div className="space-y-2">
      <div className={`${tall ? 'max-h-[55vh]' : 'max-h-48'} overflow-y-auto space-y-1 text-[13px]`}>
        {feed.length === 0 && <div className="text-messenger-muted">пока тихо</div>}
        {feed.slice(tall ? -200 : -30).map((m, i) => m.kind === 'note' ? (
          <div key={i} className="text-orange-300"><span className="text-messenger-muted">{new Date(m.at).toLocaleTimeString('ru-RU')} </span>⚠ {m.text}</div>
        ) : (
          <div key={i}><span className="text-messenger-muted">{new Date(m.at).toLocaleTimeString('ru-RU')} </span>
            <span title={m.trust === 'signed' ? 'подпись верна' : 'без подписи — автора подделать может кто угодно'}
                  className={m.trust === 'signed' ? 'text-emerald-300' : 'text-orange-300'}>{m.trust === 'signed' ? '✔' : '⚠'}</span>{' '}
            <b>{m.name}{m.own ? ' (вы)' : ''}:</b> {m.text}</div>
        ))}
      </div>
      <div className="flex gap-2">
        <input value={say} onChange={e => setSay(e.target.value)} maxLength={2000}
               placeholder={state === 'serving' || state === 'joined' ? 'Сказать всем' : 'Аварийная сеть не подключена'}
               onKeyDown={e => { if (e.key === 'Enter' && say.trim() && (state === 'serving' || state === 'joined')) send(); }}
               className="flex-1 min-w-0 rounded-lg bg-messenger-hover/60 px-3 py-2 text-sm outline-none" />
        <button disabled={!say.trim() || (state !== 'serving' && state !== 'joined')} onClick={send}
                className="px-3 py-2 rounded-xl bg-primary-500 text-white text-sm disabled:opacity-40">Отправить</button>
      </div>
      {err && <div className="text-[13px] text-orange-300">{err}</div>}
    </div>
  );
}

/** Настройки → Аварийный сервер: устройство само становится сервером, когда основной недоступен. */
export default function HubPanel() {
  const [st, setSt] = useState<HubStatus | null>(null);
  const [serve, setServe] = useState(hubAllowServe());

  useEffect(() => onHubStatus(setSt), []);

  // В браузере поднять узел негде и искать соседей нечем — раздел не показываем
  if (!hubSupported()) return null;

  const state = st?.state || 'off';

  return (
    <div className="px-5 py-4 space-y-3">
      <div className="text-[16px] font-medium text-messenger-text">🛟 Аварийный сервер</div>
      <div className="text-[13px] text-messenger-muted leading-snug">
        Если основной сервер недоступен, приложение само найдёт аварийный сервер в этой сети (Wi-Fi, раздача с телефона,
        офис без интернета) или станет им само. Чаты продолжают работать между теми, кто рядом; когда основной вернётся,
        всё накопленное уйдёт на него без повторов.
      </div>
      <div className="text-[12px] rounded-lg bg-orange-500/10 text-orange-300 px-3 py-2 leading-snug">
        Пока основной сервер недоступен, сообщения идут через аварийный сервер в этой сети.
        {hubProtected() ? ' Автор подтверждён подписью, но' : ' Подписи автора в этой сборке нет, и'} владелец аварийного сервера может видеть текст.
        {hubProtected() && hubSelfId() && <> Ваш ключ: <b>{hubSelfId()}</b></>}
      </div>
      <div className="text-[14px]">Аварийная сеть: <b>{st ? hubLabel(st) : 'выключена'}</b></div>
      {st?.error && <div className="text-[13px] text-orange-300">{st.error}</div>}

      <label className="flex items-center gap-2 text-[13px]">
        <input type="checkbox" checked={serve} onChange={e => { setServe(hubAllowServe(e.target.checked)); }} />
        Разрешить этому устройству становиться сервером
      </label>

      <div className="flex flex-wrap gap-2">
        {state === 'off' ? (
          <button onClick={hubEnable} className="px-3 py-2 rounded-xl bg-primary-500 text-white text-sm">Включить аварийную сеть</button>
        ) : (
          <button onClick={hubDisable} className="px-3 py-2 rounded-xl bg-messenger-hover text-sm">Выключить</button>
        )}
      </div>

      {state !== 'off' && (
        <div className="space-y-2">
          <div className="text-[13px] text-messenger-muted">Эфир аварийной сети:</div>
          <HubFeedView />
        </div>
      )}
    </div>
  );
}
