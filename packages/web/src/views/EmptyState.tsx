import { useRef, useState } from "react";
import { Ico, ToolIco } from "../ui/icons.js";
import { useToast } from "../ui/Toast.js";
import { downscaleImage } from "../board/images.js";

/** What the hero hands the model alongside the words. */
export interface HeroAttachments {
  images?: Array<{ data: string; mediaType: string }>;
  documents?: Array<{ name: string; text: string }>;
}

interface Picked {
  id: string;
  name: string;
  kind: "image" | "document";
  image?: { data: string; mediaType: string };
  document?: { name: string; text: string };
}

const TEXT_TYPES = /\.(txt|md|markdown|csv|json|ya?ml|log)$/i;
const MAX_FILES = 4;
const MAX_DOC_CHARS = 20_000;

/**
 * The first screen of a new board — the "magic moment" (docs/01). It offers
 * the two ways into Lucent as equals: describe it (typed, dictated, or with a
 * screenshot / document attached), or start a meeting and let Lucent listen.
 * Everything here does something real; the old Attach button only said
 * "coming soon".
 */
export function EmptyState({
  value,
  onChange,
  onSubmit,
  onSubmitWithAttachments,
  onSpeak,
  onBlankBoard,
  onStartMeeting,
  failedAttempt,
  onStartVoiceCall,
  voiceAgentActive,
  listening,
  onGenImage,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  /** Send the words with attached files (images → vision, text → documents). */
  onSubmitWithAttachments?: (attachments: HeroAttachments) => void;
  onSpeak: () => void;
  onBlankBoard?: () => void;
  onStartMeeting?: () => void;
  onStartVoiceCall?: () => void;
  voiceAgentActive?: boolean;
  listening?: boolean;
  onGenImage?: () => void;
  failedAttempt?: { text: string; retryPrompt?: string } | null;
}) {
  const { notify } = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [picked, setPicked] = useState<Picked[]>([]);
  const [reading, setReading] = useState(false);

  // Suggestions that show what Lucent is for: not just a diagram topic, but
  // the decisions, questions and owners a conversation carries.
  const suggestions = [
    "Checkout redesign — we chose guest checkout; open question: Apple Pay at launch?",
    "An e-commerce platform with Stripe payments",
    "Onboarding journey for a B2B SaaS — where do users drop off?",
    "Architecture for a real-time chat app; risk: message ordering at scale",
  ];

  const addFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setReading(true);
    const next: Picked[] = [];
    for (const file of [...files].slice(0, MAX_FILES - picked.length)) {
      const id = `${file.name}-${file.size}-${file.lastModified}`;
      if (file.type.startsWith("image/")) {
        // Same downscale as pasting onto the board: a 12 MP screenshot must
        // not become a multi-megabyte request.
        const scaled = await downscaleImage(file);
        const match = scaled && /^data:([^;,]+);base64,(.+)$/s.exec(scaled.dataUrl);
        if (!match) {
          notify(`Couldn't read ${file.name} as an image.`);
          continue;
        }
        next.push({ id, name: file.name, kind: "image", image: { mediaType: match[1]!, data: match[2]! } });
      } else if (file.type.startsWith("text/") || TEXT_TYPES.test(file.name)) {
        const text = (await file.text()).slice(0, MAX_DOC_CHARS);
        if (!text.trim()) continue;
        next.push({ id, name: file.name, kind: "document", document: { name: file.name, text } });
      } else {
        notify(`${file.name}: attach an image or a text file (.txt, .md, .csv, .json). For a PDF, paste its text.`);
      }
    }
    setReading(false);
    setPicked((p) => [...p, ...next.filter((n) => !p.some((x) => x.id === n.id))].slice(0, MAX_FILES));
    if (fileRef.current) fileRef.current.value = "";
  };

  const begin = () => {
    if (picked.length > 0 && onSubmitWithAttachments) {
      const images = picked.flatMap((p) => (p.image ? [p.image] : []));
      const documents = picked.flatMap((p) => (p.document ? [p.document] : []));
      onSubmitWithAttachments({
        ...(images.length ? { images } : {}),
        ...(documents.length ? { documents } : {}),
      });
      setPicked([]);
      return;
    }
    onSubmit();
  };

  return (
    <div className="empty-hero">
      <div className="empty-ambient-glow" />

      <div className="empty-badge">
        <span className="empty-badge-dot" />
        Think out loud · Build visually
      </div>

      <h1 className="empty-title hero-title">
        What are you <em>thinking</em> about?
      </h1>

      <p className="empty-sub">
        Describe an idea, a system, a decision in the making — or start a meeting and let Lucent
        listen. Every object it draws remembers the words that made it.
      </p>

      {failedAttempt && (
        <div className="hero-failure" role="alert">
          <span className="hero-failure-mark" aria-hidden>
            !
          </span>
          <div className="hero-failure-text">
            <div>That didn't work — the board is still empty, and your request wasn't lost.</div>
            <div className="mono hero-failure-detail">{failedAttempt.text}</div>
          </div>
          {failedAttempt.retryPrompt && (
            <button
              className="btn-atelier ghost sm"
              onClick={() => {
                if (failedAttempt.retryPrompt) onChange(failedAttempt.retryPrompt);
              }}
              title="Put the request back in the box, ready to send again"
            >
              Try again
            </button>
          )}
        </div>
      )}

      <div className="empty-omnibar">
        <label className="sr-only" htmlFor="empty-state-prompt">
          Describe what you want to build
        </label>
        <input
          id="empty-state-prompt"
          className="empty-input"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") begin();
          }}
          placeholder="e.g. Customers browse restaurants, pay with Stripe, and track the driver. We decided on…"
        />
        {picked.length > 0 && (
          <div className="hero-files" aria-label="Attached files">
            {picked.map((p) => (
              <span key={p.id} className="hero-file">
                {p.kind === "image" ? <ToolIco.Media /> : <Ico.Book />}
                <span className="hero-file-name">{p.name}</span>
                <button
                  onClick={() => setPicked((all) => all.filter((x) => x.id !== p.id))}
                  aria-label={`Remove ${p.name}`}
                  title="Remove"
                >
                  <Ico.X />
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="hero-actions">
          <button
            className={`hero-chip ${listening ? "on danger" : ""}`}
            onClick={onSpeak}
            title={listening ? "Listening… click to stop" : "Dictate your description"}
          >
            <Ico.Mic2 /> {listening ? "Listening…" : "Speak"}
          </button>
          {onStartVoiceCall && (
            <button
              className={`hero-chip ${voiceAgentActive ? "on" : ""}`}
              onClick={onStartVoiceCall}
              title="Talk it through with Lucent in a live voice call"
            >
              <Ico.Phone /> {voiceAgentActive ? "In call…" : "Live call"}
            </button>
          )}
          {onSubmitWithAttachments && (
            <>
              <button
                className="hero-chip"
                onClick={() => fileRef.current?.click()}
                disabled={reading || picked.length >= MAX_FILES}
                title="Attach a screenshot, whiteboard photo, or a text document for Lucent to read"
              >
                <Ico.Attach /> {reading ? "Reading…" : "Attach"}
              </button>
              <input
                ref={fileRef}
                type="file"
                multiple
                accept="image/*,.txt,.md,.markdown,.csv,.json,.yaml,.yml"
                className="sr-only"
                tabIndex={-1}
                aria-hidden
                onChange={(e) => void addFiles(e.target.files)}
              />
            </>
          )}
          {onGenImage && (
            <button className="hero-chip" onClick={onGenImage} title="Generate a reference image or logo">
              <Ico.Sparkle /> Image
            </button>
          )}
          <div style={{ flex: 1 }} />
          <span className="hero-hint">Enter to send</span>
          <button
            className="btn-atelier primary hero-begin"
            onClick={begin}
            disabled={!value.trim() && picked.length === 0}
          >
            Begin <Ico.Arrow />
          </button>
        </div>
      </div>

      <div className="hero-suggestions">
        {suggestions.map((s, i) => (
          <button key={i} className="empty-chip" onClick={() => onChange(s)}>
            {s}
          </button>
        ))}
      </div>

      <div className="hero-alt">
        {onStartMeeting && (
          <button className="hero-alt-btn" onClick={onStartMeeting}>
            <Ico.Present /> Start a meeting instead
          </button>
        )}
        {onBlankBoard && (
          <button className="hero-alt-btn quiet" onClick={onBlankBoard}>
            or start with a blank board <Ico.Arrow />
          </button>
        )}
      </div>
    </div>
  );
}
