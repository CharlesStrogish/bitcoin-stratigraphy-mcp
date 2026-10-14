// Copyright (c) 2026 Charles R. Strogish. Licensed under AGPLv3 (Commercial Licenses Available).
import { useEffect, useRef, useState } from "react";
import { Check, Copy, FileJson } from "lucide-react";
import {
  CISO_INTAKE_COPY_TEXT,
  DUE_DILIGENCE_BRIEF_PATH,
} from "@/lib/ciso-intake";
import { LICENSING_EMAIL } from "@/lib/site";
import "./ciso-intake-actions.css";

type CopyStatus = "idle" | "copied" | "manual";

/** Intake helpers shown beside each licensing mailto call to action. */
export function CisoIntakeActions({ testIdPrefix }: { testIdPrefix: string }) {
  const [status, setStatus] = useState<CopyStatus>("idle");
  const timer = useRef<number | undefined>(undefined);
  const fallback = useRef<HTMLTextAreaElement>(null);

  useEffect(() => () => window.clearTimeout(timer.current), []);
  useEffect(() => {
    if (status === "manual") fallback.current?.select();
  }, [status]);

  const copy = async () => {
    window.clearTimeout(timer.current);
    try {
      await navigator.clipboard.writeText(CISO_INTAKE_COPY_TEXT);
      setStatus("copied");
      timer.current = window.setTimeout(() => setStatus("idle"), 2500);
    } catch {
      // Clipboard access can be blocked in embedded or insecure contexts.
      setStatus("manual");
    }
  };

  return (
    <div className="ciso-actions" data-testid={`ciso-actions-${testIdPrefix}`}>
      <div className="ciso-actions-row">
        <button
          type="button"
          className="control-button ciso-action"
          onClick={copy}
          data-copied={status === "copied"}
          data-testid={`button-copy-ciso-template-${testIdPrefix}`}
        >
          {status === "copied" ? (
            <Check size={14} aria-hidden="true" />
          ) : (
            <Copy size={14} aria-hidden="true" />
          )}
          {status === "copied"
            ? "CISO Intake Template Copied"
            : "Copy CISO Intake Template"}
        </button>
        <a
          className="control-button ciso-action"
          href={`${import.meta.env.BASE_URL}${DUE_DILIGENCE_BRIEF_PATH}`}
          target="_blank"
          rel="noopener"
          data-testid={`link-ciso-brief-${testIdPrefix}`}
        >
          <FileJson size={14} aria-hidden="true" />
          Download / View CISO Due-Diligence Brief (JSON)
        </a>
      </div>
      <p className="ciso-status" role="status" aria-live="polite">
        {status === "copied"
          ? `Template copied. Paste it into an email to ${LICENSING_EMAIL}.`
          : status === "manual"
            ? "Clipboard access was blocked. The template is selected below; press Ctrl+C or ⌘C to copy it."
            : ""}
      </p>
      {status === "manual" && (
        <textarea
          ref={fallback}
          className="ciso-fallback"
          readOnly
          rows={12}
          value={CISO_INTAKE_COPY_TEXT}
          aria-label="CISO intake template"
          onFocus={(event) => event.currentTarget.select()}
          data-testid={`textarea-ciso-template-${testIdPrefix}`}
        />
      )}
    </div>
  );
}
