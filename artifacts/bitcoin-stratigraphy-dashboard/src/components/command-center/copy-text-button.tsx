// Copyright (c) 2026 Charles R. Strogish. Licensed under AGPLv3 (Commercial Licenses Available).
import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";

type CopyStatus = "idle" | "copying" | "copied" | "error";

export function CopyTextButton({
  text,
  label,
  copiedLabel = "Copied",
  context,
  description,
  testId,
  variant = "secondary",
}: {
  text: string;
  label: string;
  copiedLabel?: string;
  /** Screen-reader-only suffix naming what is copied, e.g. "escrow root". */
  context?: string;
  description: string;
  testId: string;
  variant?: "primary" | "secondary" | "compact";
}) {
  const [status, setStatus] = useState<CopyStatus>("idle");
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
    if (status === "copying") return;
    const current = ++request.current;
    window.clearTimeout(timer.current);
    setStatus("copying");
    try {
      if (!navigator.clipboard) throw new Error("Clipboard API unavailable");
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
      className={`cc-copy cc-copy-${variant}`}
      onClick={copy}
      disabled={status === "copying"}
      data-status={status}
      data-testid={testId}
      title={
        status === "error"
          ? "Clipboard access failed. Select the text and copy it manually."
          : description
      }
    >
      {status === "copied" ? (
        <Check size={14} aria-hidden="true" />
      ) : (
        <Copy size={14} aria-hidden="true" />
      )}
      <span aria-live="polite">
        {status === "copied"
          ? copiedLabel
          : status === "error"
            ? "Copy failed"
            : label}
      </span>
      {context && <span className="sr-only"> {context}</span>}
    </button>
  );
}
