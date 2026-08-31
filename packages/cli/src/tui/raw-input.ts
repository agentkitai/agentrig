import { useEffect, useRef } from "react";
import { useInput, useStdin } from "ink";

export interface InputKey {
  return: boolean;
  escape: boolean;
  ctrl: boolean;
  meta: boolean;
  backspace: boolean;
  delete: boolean;
}

/**
 * Preserve Ink's key interpretation while also exposing the exact chunk it interpreted. Marker
 * decoding needs the raw leading ESC, which Ink intentionally removes before `useInput` callbacks.
 */
export function useRawInput(
  handler: (raw: string, input: string, key: InputKey) => void,
): void {
  const { internal_eventEmitter: emitter } = useStdin();
  const chunks = useRef<string[]>([]);

  useEffect(() => {
    const capture = (data: string | Buffer): void => {
      chunks.current.push(typeof data === "string" ? data : data.toString("utf8"));
    };
    // Ink's own useInput listener must observe the same event after this capture has queued it.
    emitter.prependListener("input", capture);
    return () => {
      emitter.removeListener("input", capture);
      chunks.current.length = 0;
    };
  }, [emitter]);

  useInput((input, key) => {
    // The fallback is only for a nonstandard StdinContext that emits directly to useInput without
    // the capturer. It deliberately preserves old key behavior; it cannot fabricate marker bytes.
    const raw = chunks.current.shift() ?? (key.return ? "\r" : key.escape ? "\u001b" : input);
    handler(raw, input, key);
  });
}
