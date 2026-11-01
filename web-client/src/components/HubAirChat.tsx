import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Send } from 'lucide-react';
import { onHubStatus, onHubFeed, HubStatus, HubFeedItem, hubSay, hubEnable, hubProtected } from '@/lib/hub';
import { hubLabel } from '@/components/HubPanel';
import { useAuthStore } from '@/store/auth';

/**
 * «Эфир аварийной сети» как обычный чат (/chat/hub-air): общий для всех,
 * кто сейчас в аварийной сети рядом. Свои сообщения справа, чужие слева
 * с именем и отметкой подписи; служебные заметки — по центру.
 */
export default function HubAirChat() {
  const navigate = useNavigate();
  const [st, setSt] = useState<HubStatus | null>(null);
  const [feed, setFeed] = useState<HubFeedItem[]>([]);
  const [text, setText] = useState('');
  const [err, setErr] = useState('');
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const u1 = onHubStatus(setSt);
    const u2 = onHubFeed(setFeed);
    return () => { u1(); u2(); };
  }, []);
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [feed.length]);

  const state = st?.state || 'off';
  const online = state === 'serving' || state === 'joined';
  const me = useAuthStore.getState().user;
  const myName = me?.display_name || me?.username || 'Я';
  const send = () => {
    const t = text.trim();
    if (!t) return;
    const e = hubSay(myName, t);
    if (e) setErr(e); else { setText(''); setErr(''); }
  };
  const time = (at: number) => new Date(at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Шапка — как у чата */}
      <div className="h-14 px-3 flex items-center gap-3 bg-messenger-sidebar border-b border-messenger-border shrink-0 z-20 shadow-sm">
        <button onClick={() => navigate('/')} className="md:hidden p-1.5 -ml-1.5 rounded-full hover:bg-messenger-hover text-messenger-muted transition-colors"><ArrowLeft className="w-5 h-5" /></button>
        <div className="w-10 h-10 rounded-full shrink-0 flex items-center justify-center text-xl bg-gradient-to-br from-orange-400 to-red-500 shadow-sm">🛟</div>
        <div className="min-w-0">
          <h2 className="font-semibold text-messenger-text text-[15px] truncate leading-tight">Эфир аварийной сети</h2>
          <p className={`text-[13px] leading-tight mt-0.5 truncate ${online ? 'text-messenger-accent' : 'text-messenger-muted'}`}>{st ? hubLabel(st) : 'выключена'}</p>
        </div>
      </div>

      <div className="px-3 py-1.5 text-[12px] leading-snug bg-orange-500/10 text-orange-300 shrink-0">
        Сообщения видят все в этой сети.{hubProtected() ? ' Автор подтверждён подписью, но' : ''} владелец аварийного сервера может видеть текст.
      </div>

      {/* Сообщения */}
      <div ref={listRef} className="messages-container flex-1 overflow-y-auto overflow-x-hidden px-2 sm:px-4 py-4 space-y-1.5 min-h-0">
        {feed.length === 0 && (
          <div className="h-full flex items-center justify-center text-center text-messenger-muted text-sm px-6">
            Пока тихо. Когда основной сервер недоступен, здесь можно говорить со всеми, кто рядом в этой сети.
          </div>
        )}
        {feed.map((m, i) => m.kind === 'note' ? (
          <div key={i} className="flex justify-center">
            <span className="text-[12px] text-orange-200 bg-black/25 rounded-full px-3 py-1 max-w-[90%] text-center">{m.text}</span>
          </div>
        ) : (
          <div key={i} className={`flex ${m.own ? 'justify-end' : 'justify-start'}`}>
            <div className={`relative px-3 pt-2 pb-1.5 shadow-telegram text-[15px] leading-[1.3] break-words max-w-[80%] rounded-2xl ${m.own ? 'msg-bubble-own' : 'msg-bubble-other'}`}>
              {!m.own && <div className="text-[13px] font-medium text-messenger-accent mb-0.5">{m.name}</div>}
              <p className="whitespace-pre-wrap">{m.text}</p>
              <div className="text-[11px] opacity-60 text-right mt-0.5 select-none">
                <span title={m.trust === 'signed' ? 'подпись верна' : 'без подписи — автора подделать может кто угодно'}
                      className={m.trust === 'signed' ? '' : 'text-orange-300 opacity-100'}>{m.trust === 'signed' ? '✔' : '⚠'}</span>{' '}{time(m.at)}
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Ввод */}
      <div className="px-2 py-2 bg-messenger-sidebar border-t border-messenger-border shrink-0">
        {err && <div className="px-2 pb-1 text-[12px] text-orange-300">{err}</div>}
        {state === 'off' ? (
          <div className="flex justify-center">
            <button onClick={hubEnable} className="px-4 py-2 rounded-full bg-messenger-accent text-white text-sm">Включить аварийную сеть</button>
          </div>
        ) : (
          <div className="flex items-end gap-2">
            <input value={text} onChange={e => setText(e.target.value)} maxLength={2000} disabled={!online}
                   onKeyDown={e => { if (e.key === 'Enter') send(); }}
                   placeholder={online ? 'Сказать всем' : 'Ищу аварийный сервер…'}
                   className="flex-1 min-w-0 h-[44px] bg-messenger-input rounded-full px-4 text-[16px] text-messenger-text placeholder-messenger-muted outline-none disabled:opacity-60" />
            <button onClick={send} disabled={!online || !text.trim()}
                    className="w-[44px] h-[44px] rounded-full bg-messenger-accent/10 text-messenger-accent hover:bg-messenger-accent/20 transition-colors shrink-0 flex items-center justify-center disabled:opacity-40">
              <Send size={20} />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
