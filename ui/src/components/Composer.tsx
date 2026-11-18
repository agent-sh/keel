import { ArrowUp, Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { cn } from "../lib/utils.ts";
import { ModelPicker } from "./ModelPicker.tsx";

export function Composer({
  onSend, onStop, working, model, onModel, placeholder, autoFocus,
}: {
  onSend: (text: string) => Promise<unknown> | void;
  onStop?: () => void;
  working?: boolean;
  model: string;
  onModel: (id: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 320)}px`;
  }, [text]);

  const submit = async () => {
    const t = text.trim();
    if (!t || busy) return;
    setBusy(true);
    try {
      await onSend(t);
      setText("");
    } finally {
      setBusy(false);
      ref.current?.focus();
    }
  };

  return (
    <div className="rounded-2xl border border-line bg-raised shadow-soft transition-colors focus-within:border-line-strong">
      <textarea
        ref={ref}
        data-testid="composer"
        autoFocus={autoFocus}
        rows={1}
        value={text}
        placeholder={placeholder ?? (working ? "Steer the turn, or queue a message" : "Ask Keel")}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            submit();
          }
          if (e.key === "Escape" && working) onStop?.();
        }}
        className="block w-full resize-none bg-transparent px-4 pt-3.5 pb-1 leading-relaxed outline-none placeholder:text-faint"
      />
      <div className="flex items-center gap-1 px-2 pb-2">
        <ModelPicker value={model} onChange={onModel} />
        <div className="ml-auto flex items-center gap-1.5">
          {working && (
            <button
              type="button"
              data-testid="stop"
              onClick={onStop}
              title="Stop (Esc)"
              className="grid size-8 place-items-center rounded-full border border-line-strong text-fg hover:bg-panel"
            >
              <Square className="size-3 fill-current" />
            </button>
          )}
          <button
            type="button"
            data-testid="send"
            onClick={submit}
            disabled={!text.trim() || busy}
            title="Send (Enter)"
            className={cn(
              "grid size-8 place-items-center rounded-full bg-accent text-accent-fg transition-opacity",
              "disabled:opacity-30 hover:opacity-90",
            )}
          >
            <ArrowUp className="size-4" strokeWidth={2.5} />
          </button>
        </div>
      </div>
    </div>
  );
}
