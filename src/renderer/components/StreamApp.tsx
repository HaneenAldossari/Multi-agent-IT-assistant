import { useEffect, useRef, useState } from 'react';
import type { ChatEntry, TranscriptionResult, VoiceState } from '../../shared/types';

interface Turn {
  id: string;
  user: string;
  ai: string;
  /** Whether the AI portion is still being streamed in. */
  streaming: boolean;
}

function makeId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * The transparent floating window that mirrors the live Q/A stream.
 * It subscribes to the same IPC feed the panel uses (transcript updates,
 * response chunks, completed entries) and renders them in a scrollable
 * list. The window chrome itself (size / position / drag) is handled by
 * the main process; this component only draws what's inside.
 */
export function StreamApp() {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [voiceState, setVoiceState] = useState<VoiceState>('idle');
  const bodyRef = useRef<HTMLDivElement>(null);
  /** Tracks the in-progress turn so chunks can append to it. */
  const currentIdRef = useRef<string | null>(null);
  /** Buffer of characters waiting to be typed out, plus a pump timer.
   * Gives a real progressive feel even when chunks arrive in bursts —
   * so the user sees each line appear before the next one overtakes it,
   * instead of a wall of text dropping at once. */
  const typeBufferRef = useRef<string>('');
  const typeTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pendingFinalRef = useRef<string | null>(null);

  // Load existing history once so the stream window isn't empty on open.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const history = await window.flicky.getChatHistory();
        if (cancelled) return;
        setTurns(
          history.map((h: ChatEntry) => ({
            id: h.id,
            user: h.userText,
            ai: h.assistantText,
            streaming: false,
          })),
        );
      } catch {
        /* non-fatal */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const unsubState = window.flicky.onVoiceStateChanged(setVoiceState);

    const unsubTranscript = window.flicky.onTranscriptUpdate((result: TranscriptionResult) => {
      // A final transcript marks the start of a new turn — seed it with
      // the user text and an empty AI body the chunks will append to.
      if (!result.isFinal) return;
      const id = makeId();
      currentIdRef.current = id;
      setTurns((prev) => [
        ...prev,
        { id, user: result.text, ai: '', streaming: true },
      ]);
    });

    const startTypePump = () => {
      if (typeTimerRef.current) return;
      typeTimerRef.current = setInterval(() => {
        const id = currentIdRef.current;
        const buf = typeBufferRef.current;
        if (!id) {
          // Turn ended — flush any buffered chars then stop.
          stopTypePump();
          return;
        }
        if (buf.length === 0) {
          // Nothing buffered. If a final-text replacement is queued and
          // chars are drained, apply it now and stop.
          if (pendingFinalRef.current !== null) {
            const fullText = pendingFinalRef.current;
            pendingFinalRef.current = null;
            setTurns((prev) =>
              prev.map((t) =>
                t.id === id ? { ...t, ai: fullText, streaming: false } : t,
              ),
            );
            currentIdRef.current = null;
            stopTypePump();
          }
          return;
        }
        // Pop a small batch each tick. Tune CHARS_PER_TICK to taste —
        // higher = faster typing, lower = more obvious "streaming" feel.
        const CHARS_PER_TICK = 3;
        const toEmit = buf.slice(0, CHARS_PER_TICK);
        typeBufferRef.current = buf.slice(CHARS_PER_TICK);
        setTurns((prev) =>
          prev.map((t) => (t.id === id ? { ...t, ai: t.ai + toEmit } : t)),
        );
      }, 28); // ~28ms × 3 chars = ~107 chars/sec — fast but visibly streaming
    };
    const stopTypePump = () => {
      if (typeTimerRef.current) {
        clearInterval(typeTimerRef.current);
        typeTimerRef.current = null;
      }
    };

    const unsubChunk = window.flicky.onAiResponseChunk((chunk: string) => {
      if (!currentIdRef.current) return;
      typeBufferRef.current += chunk;
      startTypePump();
    });

    const unsubComplete = window.flicky.onAiResponseComplete((fullText: string) => {
      const id = currentIdRef.current;
      if (!id) return;
      // If chars are still being typed, queue the final replacement so
      // it lands AFTER the typewriter drains. If nothing's buffered,
      // apply immediately. Either way the bubble ends with the canonical
      // full text and `streaming: false`.
      if (typeBufferRef.current.length > 0) {
        pendingFinalRef.current = fullText;
      } else {
        setTurns((prev) =>
          prev.map((t) =>
            t.id === id ? { ...t, ai: fullText, streaming: false } : t,
          ),
        );
        currentIdRef.current = null;
        stopTypePump();
      }
    });

    const unsubClear = window.flicky.onClearStream(() => {
      setTurns([]);
      currentIdRef.current = null;
      typeBufferRef.current = '';
      pendingFinalRef.current = null;
      stopTypePump();
    });

    return () => {
      unsubState();
      unsubTranscript();
      unsubChunk();
      unsubComplete();
      unsubClear();
      stopTypePump();
    };
  }, []);

  // Auto-scroll to bottom on new content — but only if the user is
  // already near the bottom. If they've scrolled up to re-read an
  // earlier chunk, don't fight them.
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distanceFromBottom < 80) {
      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    }
  }, [turns]);

  const statusLabel =
    voiceState === 'listening'
      ? 'listening…'
      : voiceState === 'processing'
        ? 'thinking…'
        : voiceState === 'responding'
          ? 'responding'
          : 'idle';

  return (
    <div className="stream-root">
      <div className="stream-head">
        <span className="title">IT Assistant · {statusLabel}</span>
        <button
          className="btn"
          title="Clear the on-screen stream (chat history is untouched)"
          onClick={() => window.flicky.clearStream()}
        >
          clear
        </button>
      </div>
      <div className="stream-body" ref={bodyRef}>
        {turns.length === 0 ? (
          <div className="stream-empty">
            Hold the push-to-talk shortcut and start talking. The live Q/A will appear here.
          </div>
        ) : (
          turns.map((t) => (
            <div key={t.id} className="stream-turn">
              <div className="stream-label">You</div>
              <div className="stream-user">{t.user}</div>
              <div className="stream-label" style={{ marginTop: 6 }}>
                IT Assistant
              </div>
              <div className="stream-ai">
                {t.ai}
                {t.streaming && <span className="stream-caret" />}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
