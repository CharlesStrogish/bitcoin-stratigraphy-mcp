import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import "./copy-json-button.css";

export function CopyJsonButton({
  text,
  testId,
  label = "Copy JSON",
  copiedLabel = "Copied!",
}: {
  text: string | null;
  testId: string;
  label?: string;
  copiedLabel?: string;
}) {
  const [status, setStatus] = useState<"idle" | "copying" | "copied" | "error">(
    "idle",
  );
  const timer = useRef<number | undefined>(undefined);
  const request = useRef(0);

  useEffect(() => {
    setStatus("idle");
    return () => {
      request.current += 1;
      window.clearTimeout(timer.current);
    };
  }, [text]);

  const copy = async () => {
    if (text === null || status === "copying") return;
    const current = ++request.current;
    window.clearTimeout(timer.current);
    setStatus("copying");
    try {
      await navigator.clipboard.writeText(text);
      if (request.current !== current) return;
      setStatus("copied");
      timer.current = window.setTimeout(() => {
        if (request.current === current) setStatus("idle");
      }, 2000);
    } catch {
      if (request.current === current) setStatus("error");
    }
  };

  return (
    <button
      type="button"
      className="control-button sim-copy-json"
      onClick={copy}
      disabled={text === null || status === "copying"}
      data-testid={testId}
      data-copied={status === "copied"}
      aria-live="polite"
      title={
        status === "error"
          ? "Clipboard access failed. Try again or select and copy the JSON manually."
          : "Copy the exact displayed JSON"
      }
    >
      {status === "copied" ? (
        <Check size={14} aria-hidden="true" />
      ) : (
        <Copy size={14} aria-hidden="true" />
      )}
      {status === "copied"
        ? copiedLabel
        : status === "error"
          ? "Copy failed"
          : label}
    </button>
  );
}
