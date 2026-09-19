import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { resolveLocale, t } from "@lucent/i18n";
import { applyLayout, applyRoutes, computeLayoutWithRoutes } from "@lucent/core";
import { Ico } from "../ui/icons.js";
import { AIPill } from "../ui/AIPill.js";
import { TopBar, LeftRail, ZoomBadge, StatusBadge } from "../ui/Chrome.js";
import { CanvasViewport, emitHaptic, type ViewportControls } from "../ui/atoms.js";
import { DiagramLayer } from "../ui/DiagramLayer.js";
import {
  ShapeToolbar,
  ShapeElement,
  ShapeLinkLayer,
  SHAPE_KINDS,
  type Tool,
  type DropKind,
} from "../ui/ShapeToolbar.js";
import { ToolIco } from "../ui/icons.js";
import { EmptyState } from "./EmptyState.js";
import { Tour } from "../ui/Tour.js";
import { ProposalPanel } from "./ProposalPanel.js";
import { AttentionPanel } from "./AttentionPanel.js";
import { WhyThis } from "./WhyThis.js";
import { BoardView } from "./BoardView.js";
import { DocumentView } from "./DocumentView.js";
import { WireframeView } from "./WireframeView.js";
import { SequenceView } from "./SequenceView.js";
import { ErView } from "./ErView.js";
import { Menu } from "../ui/primitives.js";
import { buildAttention } from "../attention.js";
import { VoiceOverlay } from "./VoiceOverlay.js";
import { PresentMode } from "./PresentMode.js";
import { PenLayer } from "./PenLayer.js";
import { MarqueeLayer } from "./MarqueeLayer.js";
import { cullRect, visibleShapes } from "../board/culling.js";
import { ShapeDrawLayer } from "./ShapeDrawLayer.js";
import { ShapeInspector } from "./ShapeInspector.js";
import { LinkInspector } from "./LinkInspector.js";
import { Minimap } from "./Minimap.js";
import { TemplatePicker } from "./TemplatePicker.js";
import { TimerWidget } from "./TimerWidget.js";
import {
  STATEMENT_KINDS,
  STATEMENT_STATUSES,
  statementEditOps,
  topicDuplicateHint,
  topicSuggestions,
} from "../statementUi.js";
import { ContextMenu, type MenuItem } from "./ContextMenu.js";
import { EngagementBadges, EngagementBar, VotePanel } from "./Engagement.js";
import { CommentInbox, CommentPanel, CommentPins, NotificationBell } from "./Comments.js";
import { PresenceBar, PresenceCursors } from "./Presence.js";
import { toggleVoteOps } from "../board/engagement.js";
import { openThreadCount } from "../board/comments.js";
import { useWorkspace } from "../workspace.js";
import { useSettings } from "../settings.js";
import { useToast } from "../ui/Toast.js";
import { generateImage } from "../api.js";
import { WireframeRenderer } from "../ui/WireframeRenderer.js";
import { speakAnswer, isTtsSpeaking } from "../tts.js";
import { getSttProvider, isAnyVoiceSupported, type VoiceSession } from "../stt/index.js";
import { VoiceAgentBar } from "../ui/VoiceAgentBar.js";
import {
  startVoiceAgentSession,
  type VoiceAgentController,
  type VoiceAgentState,
} from "../stt/voiceAgentSession.js";
import { nextZ, normalizeZ, shapeId } from "../shapes.js";
import { resolveEmbed } from "../embed.js";
import { boardToMarkdown, boardToCsv, csvToStickyOps } from "../board/serialize.js";
import { boardToMermaid, mermaidToOps } from "../board/mermaid.js";
import {
  classifyImport,
  collectAttachments,
  documentToOps,
  pdfIsCompressed,
  pdfToOps,
  svgToOps,
} from "../board/importers.js";
import { classifyCodeFile, codeToOps } from "../board/codeImport.js";
import { downscaleImage } from "../board/images.js";
import {
  snapPosition,
  alignGuides,
  contentBounds,
  buildBoardSvg,
  escapeAttr,
  shapesInFrame,
  nextSelectable,
  type AlignGuide,
} from "../board/geometry.js";
import { DIAGRAM_LABELS } from "../scene.js";

/**
 * The print document the PDF export hands to a sandboxed iframe's `srcdoc`.
 *
 * Module-level and pure so the escaping can be exercised without a DOM. `title`
 * is the project name — the user's own text on a solo board, but a
 * *collaborator's* on a shared one, since the board name arrives from the server
 * — and it lands in an HTML element body. Left raw, `</title><script>…` closes
 * the element and runs in the print document; that document is sandboxed, but
 * `allow-scripts` has to be on for the auto-print call, so the sandbox is not
 * the thing stopping it. `escapeAttr` is the same escaper the SVG export uses
 * (board/geometry.ts), so both sinks answer to one rule.
 */
export function buildPrintDocument(svg: string, title: string): string {
  return (
    `<!doctype html><html><head><title>${escapeAttr(title || "lucent-board")}</title>` +
    `<style>@media print{@page{margin:12mm;}} body{margin:0;display:flex;justify-content:center;}svg{max-width:100%;height:auto;}</style>` +
    `</head><body>${svg}<script>window.onload=()=>{window.print();}</script></body></html>`
  );
}

/**
 * Detect explicit user intent to generate a visual reference image, illustration,
 * or logo. Must NEVER intercept diagram, flowchart, mindmap, or architecture requests.
 */
export function parseExplicitImageIntent(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (
    /\b(diagram|flowchart|flow\s+chart|mindmap|mind\s+map|architecture|journey|wireframe|mockup|table|graph|sequence|decisiontree|process\s+map|orgchart)\b/i.test(
      trimmed,
    )
  ) {
    return null;
  }
  const patterns = [
    /^(?:please\s+)?(?:generate|create|make|draw)\s+(?:an?\s+)?(?:reference\s+)?(?:image|picture|photo|illustration|logo|icon|graphic)\s+(?:of|for)\s+(.+)$/i,
    /^(?:please\s+)?(?:generate|create|make|draw)\s+(?:an?\s+)?(?:reference\s+image|reference\s+picture|reference\s+photo)\s*[:-]?\s*(.+)$/i,
    /^(?:imagine|render\s+image)\s+(?:of\s+)?(.+)$/i,
    /^(?:create|generate|make)\s+a\s+logo\s+(?:for|of)\s+(.+)$/i,
    /^(?:can\s+you\s+)?(?:make|create|draw|generate)\s+(?:a\s+)?logo(?:\s+(?:for|of)\s+(.+))?$/i,
    /^(?:nope\s*[,.]?\s*)?(?:please\s+)?(?:use|switch\s+to|try)\s+(?:ai\s+)?image\s+generation(?:\s+(?:for|of|to\s+make)\s+(.+))?$/i,
    /^(?:nope\s*[,.]?\s*)?(?:generate|create|make)\s+(?:an?\s+)?(?:ai\s+)?image\s+instead(?:\s+(?:for|of)\s+(.+))?$/i,
    /^(?:please\s+)?(?:use|try)\s+(?:image\s+mode|the\s+image\s+model)(?:\s+(?:for|to\s+make)\s+(.+))?$/i,
  ];
  for (const p of patterns) {
    const m = trimmed.match(p);
    if (m) {
      return (m[1] && m[1].trim()) || "reference image or logo for the current board";
    }
  }
  return null;
}

/**
 * Synthesize rich context for image generation using board entities, project name,
 * and recent conversation turns when the user's prompt is conversational or relative
 * (e.g. "make a logo for the brand we discussed", "nope use image generation").
 */
export function enrichImagePromptWithContext(
  prompt: string,
  workspace?: { nodes?: Record<string, { label?: string }>; shapes?: Record<string, { label?: string; text?: string }> },
  chat?: Array<{ role: string; text: string }>,
  projectName?: string,
): string {
  const p = prompt.trim();
  const needsContext =
    p === "reference image or logo for the current board" ||
    /\b(the brand|the project|we discussed|discussed earlier|our logo|this logo|the app|the restaurant|instead|image generation)\b/i.test(p) ||
    p.length < 25;

  if (!needsContext) return p;

  const hints: string[] = [];
  if (projectName && projectName !== "Untitled" && projectName !== "Personal") {
    hints.push(projectName);
  }

  if (chat && chat.length > 0) {
    for (let i = chat.length - 1; i >= Math.max(0, chat.length - 6); i--) {
      const msg = chat[i]?.text ?? "";
      const matchBrand = msg.match(/\b(?:for|named|called|restaurant name|brand name)\s+([A-Z][a-zA-Z0-9_-]+)/i);
      if (matchBrand && matchBrand[1] && !hints.includes(matchBrand[1])) {
        hints.push(matchBrand[1]);
      }
      const matchDomain = msg.match(/\b([a-zA-Z\s]+platform|[a-zA-Z\s]+restaurant|[a-zA-Z\s]+service|[a-zA-Z\s]+app)\b/i);
      if (matchDomain && matchDomain[1]) {
        const cleaned = matchDomain[1].trim();
        if (cleaned.length < 40 && !hints.some((h) => h.toLowerCase().includes(cleaned.toLowerCase()))) {
          hints.push(cleaned);
        }
      }
    }
  }

  if (workspace?.nodes) {
    const nodeLabels = Object.values(workspace.nodes)
      .map((n) => n.label?.trim() || "")
      .filter((l) => l.length > 0 && l.length < 25);
    for (const l of nodeLabels.slice(0, 3)) {
      if (!hints.some((h) => h.toLowerCase().includes(l.toLowerCase()))) {
        hints.push(l);
      }
    }
  }

  const contextStr = hints.slice(0, 3).join(", ");
  if (!contextStr) return p;

  if (/\blogo\b/i.test(p) || p === "reference image or logo for the current board") {
    return `Professional, modern, clean logo for ${contextStr}. High resolution, vector aesthetic.`;
  }
  return `High-quality visual reference illustration of ${p} for ${contextStr}.`;
}

const ON_CANVAS_WF_SIZE: Record<string, { w: number; label: string }> = {
  desktop: { w: 820, label: "Desktop · 1440" },
  tablet: { w: 620, label: "Tablet · 834" },
  mobile: { w: 360, label: "Mobile · 390" },
};

/**
 * The canvas view. Its sub-state (empty / generating / main / proposing /
 * voice) is derived from real data in the workspace context, not stored
 * separately (docs/11). Coordinates come from computeLayout; the AI only
 * emits operations.
 */
export function CanvasView({ onOpenSettings }: { onOpenSettings: (section?: string) => void }) {
  const {
    workspace,
    chat,
    busy,
    streamChars,
    genPhase: aiPhase,
    cancelSend,
    canvasPhase,
    proposal,
    applyProposal,
    cancelProposal,
    listening,
    setListening,
    send,
    ask,
    pillMode,
    setPillMode,
    onCitation,
    selectDiagram,
    setRegionKind,
    layoutStatus,
    retryLayout,
    applyManual,
    projectName,
    undo,
    redo,
    peers,
    readOnly,
    setView,
    lens,
    syncStatus,
    boardId,
    startSharing,
  } = useWorkspace();
  const [settings] = useSettings();
  const { notify } = useToast();
  const locale = useMemo(() => resolveLocale(navigator.language), []);

  const [message, setMessage] = useState("");
  const [blankBoardStarted, setBlankBoardStarted] = useState(false);
  useEffect(() => {
    setBlankBoardStarted(false);
  }, [boardId]);
  const [selected, setSelected] = useState<string | null>(null);
  const [selectedShapes, setSelectedShapes] = useState<Set<string>>(new Set());
  // Multi-node selection, so a marquee or shift-click can grab several diagram
  // nodes and move them as one unit like FigJam/Miro. `selected` remains the
  // single "focused" node that drives the selection HUD and inspectors.
  const [selectedNodes, setSelectedNodes] = useState<Set<string>>(new Set());
  const [tool, setTool] = useState<Tool>("select");
  const changeTool = useCallback((next: Tool) => {
    setTool(next);
    if (next !== "select" && next !== "hand") {
      setSelected(null);
      setSelectedShapes(new Set());
      setSelectedNodes(new Set());
      setSelectedLink(null);
    }
  }, []);
  const [zoom, setZoom] = useState(85);
  const [mode, setMode] = useState<"edit" | "present" | "focus">("edit");
  const [presentStep, setPresentStep] = useState(0);
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [timerOpen, setTimerOpen] = useState(false);
  const [overviewOpen, setOverviewOpen] = useState(true);
  /** Object the keyboard asked to edit (Enter). Cleared once editing starts. */
  const [renameNodeId, setRenameNodeId] = useState<string | null>(null);
  // Region collapse (P1): render-local, keyed by group id, deliberately NOT
  // in the model — collapse is a view of the board, never a change to it.
  // Expanding restores the exact prior geometry because member positions
  // were never touched.
  const [collapsedRegions, setCollapsedRegions] = useState<Set<string>>(new Set());
  const toggleRegionCollapse = useCallback((groupId: string) => {
    setCollapsedRegions((prev) => {
      const next = new Set(prev);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  }, []);
  const [editShapeId, setEditShapeId] = useState<string | null>(null);
  /** Visible content region, pushed up by the viewport for the minimap. */
  const [viewportBox, setViewportBox] = useState<{
    x: number;
    y: number;
    width: number;
    height: number;
  } | null>(null);
  // Voting round: when armed, clicking an object casts/withdraws a vote instead
  // of only selecting it (docs/14 workshop features).
  const [votePanelOpen, setVotePanelOpen] = useState(false);
  const [voting, setVoting] = useState(false);
  /** Object whose comment thread is open, if any. */
  const [commentTarget, setCommentTarget] = useState<string | null>(null);
  const [inboxOpen, setInboxOpen] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number; regionId?: string } | null>(null);
  /** UX-1: single Board-tools menu replaces the 4-button right pileup. */
  const [toolsOpen, setToolsOpen] = useState(false);
  /** UX-3: attention drawer (proposal/skipped/blocked/at-risk/inbound/sync). */
  const [attentionOpen, setAttentionOpen] = useState(false);
  /** UX-2: WhyThis popover for the focused node. */
  const [whyNode, setWhyNode] = useState<string | null>(null);

  /**
   * The diagram region the current selection sits inside, if any: a region is a
   * kind-bearing group, so the selected node's groupId tells us which region a
   * right-click is about. Falls back through every selected node so a marquee
   * inside one region still finds it.
   */
  const regionForSelection = useCallback((): string | undefined => {
    const ids = selected ? [selected, ...selectedNodes] : [...selectedNodes];
    for (const id of ids) {
      const gid = workspace.nodes[id]?.groupId;
      if (gid && workspace.groups[gid]?.kind) return gid;
    }
    return undefined;
  }, [selected, selectedNodes, workspace.nodes, workspace.groups]);
  const controls = useRef<ViewportControls | null>(null);
  const voiceRef = useRef<VoiceSession | null>(null);
  const voiceSupported = isAnyVoiceSupported();
  const voiceInitiatedRef = useRef(false);
  const accumulatedVoiceTextRef = useRef("");
  const voiceSilenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const voiceSessionIdRef = useRef(0);
  const lastSpokenChatIndexRef = useRef(chat.length);

  const shapes = Object.values(workspace.shapes);
  const nodeCount = Object.keys(workspace.nodes).length;
  const openThreads = openThreadCount(workspace);

  // Surface AI/generation errors as a toast. On an empty board the AIPill (which
  // renders the chat, including error turns) isn't mounted, so a failed generate
  // would otherwise leave the user staring at the empty canvas with no feedback.
  const lastErrorRef = useRef<string | null>(null);
  useEffect(() => {
    const last = chat[chat.length - 1];
    if (last?.role === "error" && last.text !== lastErrorRef.current) {
      lastErrorRef.current = last.text;
      notify(last.text);
    }
  }, [chat, notify]);

  // Speak the AI's explanation aloud ONLY when AI sound is explicitly enabled in settings
  useEffect(() => {
    if (chat.length > lastSpokenChatIndexRef.current) {
      const latest = chat[chat.length - 1];
      lastSpokenChatIndexRef.current = chat.length;
      if (latest && latest.role === "ai" && latest.text) {
        const toSpeak = latest.text.replace(/— review \d+ proposed changes\./i, "").trim();
        if (toSpeak && settings.aiSound) {
          try {
            voiceRef.current?.stop();
          } catch {
            /* ignore */
          }
          setListening(false);
          void speakAnswer(toSpeak);
        }
        voiceInitiatedRef.current = false;
      }
    }
  }, [chat, settings.aiSound, setListening]);

  // Leaving a diagram or losing all nodes resets any active mode.
  useEffect(() => {
    if (nodeCount === 0 && mode !== "edit") setMode("edit");
  }, [nodeCount, mode]);

  const enterPresent = useCallback(() => {
    if (nodeCount === 0) {
      notify("Generate a diagram first, then present it.");
      return;
    }
    setSelected(null);
    setSelectedShapes(new Set());
    setPresentStep(0);
    setMode("present");
  }, [nodeCount, notify]);

  // The node spotlighted by present mode (in layout order) or focus mode.
  const orderedNodeIds = Object.keys(workspace.nodes);
  const presentSpotlightId =
    mode === "present"
      ? (orderedNodeIds[Math.min(presentStep, orderedNodeIds.length - 1)] ?? null)
      : null;
  const spotlightId = mode === "present" ? presentSpotlightId : mode === "focus" ? selected : null;

  // Clipboard for copy/paste of shapes (in-memory; docs/14 board parity).
  const clipboardRef = useRef<import("@lucent/core").Shape[]>([]);

  // Keyboard: Delete removes selection; Ctrl/Cmd+C/V/D copy/paste/duplicate;
  // single letters arm tools like FigJam/Miro (V/H/R/O/D/T/S/A/P/F, Esc).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") return;
      const mod = e.metaKey || e.ctrlKey;

      // A viewer may navigate the board but not change it. Undo/redo, delete,
      // cut/paste, grouping, nudging and tool arming are dropped here rather
      // than firing and being refused by the server. Zoom, fit, Tab traversal
      // and Escape stay, because reading a board needs them.
      if (readOnly) {
        const navigational =
          e.key === "Tab" ||
          e.key === "Escape" ||
          (mod && (e.key === "=" || e.key === "+" || e.key === "-" || e.key === "0")) ||
          (!mod && e.shiftKey && (e.key === "!" || e.key === "@"));
        if (!navigational) return;
      }

      // Undo/redo. The Settings shortcut panel has always advertised these, but
      // no binding existed — the only way to undo was the History view.
      if (mod && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
        return;
      }
      if (mod && e.key.toLowerCase() === "y") {
        e.preventDefault();
        redo();
        return;
      }

      if (
        (e.key === "Delete" || e.key === "Backspace") &&
        (selectedShapes.size > 0 || selectedNodes.size > 0)
      ) {
        e.preventDefault();
        const ops: import("@lucent/core").Operation[] = [
          ...[...selectedShapes]
            .filter((id) => !workspace.shapes[id]?.locked)
            .map((id) => ({ op: "DELETE_SHAPE" as const, id })),
          // Deleting nodes was previously impossible from the keyboard: the
          // handler only ever looked at shapes.
          ...[...selectedNodes]
            .filter((id) => workspace.nodes[id])
            .map((id) => ({ op: "DELETE_NODE" as const, id })),
        ];
        if (ops.length > 0) {
          applyManual(ops, `Delete ${ops.length} object${ops.length > 1 ? "s" : ""}`);
          setSelectedShapes(new Set());
          setSelectedNodes(new Set());
          setSelected(null);
        }
        return;
      }

      // Select all: shapes + nodes on the board.
      if (mod && e.key.toLowerCase() === "a") {
        e.preventDefault();
        setSelectedShapes(new Set(Object.keys(workspace.shapes)));
        setSelectedNodes(new Set(Object.keys(workspace.nodes)));
        setSelected(Object.keys(workspace.nodes)[0] ?? null);
        return;
      }

      // Cut = copy + delete, shapes only (nodes have no clipboard representation).
      if (mod && e.key.toLowerCase() === "x" && selectedShapes.size > 0) {
        e.preventDefault();
        clipboardRef.current = [...selectedShapes]
          .map((id) => workspace.shapes[id])
          .filter(Boolean) as import("@lucent/core").Shape[];
        const deletable = [...selectedShapes].filter((id) => !workspace.shapes[id]?.locked);
        if (deletable.length > 0) {
          applyManual(
            deletable.map((id) => ({ op: "DELETE_SHAPE" as const, id })),
            `Cut ${deletable.length} shape${deletable.length > 1 ? "s" : ""}`,
          );
          setSelectedShapes(new Set());
        }
        return;
      }

      if (mod && e.key.toLowerCase() === "c" && selectedShapes.size > 0) {
        clipboardRef.current = [...selectedShapes]
          .map((id) => workspace.shapes[id])
          .filter(Boolean) as import("@lucent/core").Shape[];
        return;
      }

      if (mod && e.key.toLowerCase() === "v" && clipboardRef.current.length > 0) {
        e.preventDefault();
        pasteShapes(clipboardRef.current, 24);
        return;
      }

      if (mod && e.key.toLowerCase() === "d" && selectedShapes.size > 0) {
        e.preventDefault();
        const src = [...selectedShapes]
          .map((id) => workspace.shapes[id])
          .filter(Boolean) as import("@lucent/core").Shape[];
        pasteShapes(src, 24);
        return;
      }

      // Group (Ctrl/Cmd+G) / ungroup (Ctrl/Cmd+Shift+G).
      if (mod && e.key.toLowerCase() === "g") {
        e.preventDefault();
        if (e.shiftKey) ungroupSelection();
        else groupSelection();
        return;
      }

      // Zoom from the keyboard: Ctrl/Cmd +, -, and 0 to reset.
      if (mod && (e.key === "=" || e.key === "+")) {
        e.preventDefault();
        controls.current?.zoomIn();
        return;
      }
      if (mod && e.key === "-") {
        e.preventDefault();
        controls.current?.zoomOut();
        return;
      }
      if (mod && e.key === "0") {
        e.preventDefault();
        controls.current?.reset();
        return;
      }
      // Shift+1 fits the whole board, Shift+2 the selection (Figma parity).
      if (!mod && e.shiftKey && e.key === "!") {
        e.preventDefault();
        fitRef.current();
        return;
      }
      if (!mod && e.shiftKey && e.key === "@") {
        e.preventDefault();
        fitSelectionRef.current();
        return;
      }

      // Arrow-key nudge for the current selection (Shift = 10px steps).
      if (e.key.startsWith("Arrow") && (selectedShapes.size > 0 || selectedNodes.size > 0)) {
        e.preventDefault();
        const step = e.shiftKey ? 10 : 1;
        const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
        const dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
        if (dx === 0 && dy === 0) return;
        const ops: import("@lucent/core").Operation[] = [
          ...[...selectedShapes].flatMap((id) => {
            const s = workspace.shapes[id];
            if (!s || s.locked) return [];
            return [
              {
                op: "UPDATE_SHAPE" as const,
                id,
                position: { x: s.position.x + dx, y: s.position.y + dy },
              },
            ];
          }),
          ...[...selectedNodes].flatMap((id) => {
            const p = workspace.nodes[id]?.position;
            if (!p) return [];
            return [{ op: "MOVE_NODE" as const, id, position: { x: p.x + dx, y: p.y + dy } }];
          }),
        ];
        if (ops.length > 0) applyManual(ops, "Nudge selection");
        return;
      }

      // Tab / Shift+Tab cycles focus through canvas objects so the whole board
      // is reachable without a pointer (WCAG 2.1.1). Enter then edits the
      // focused object; the existing arrow-nudge/Delete/duplicate shortcuts all
      // act on this selection, so they become keyboard-reachable too.
      //
      // Scoped to focus inside the canvas region: Tab is the browser's own
      // focus-traversal key, so hijacking it globally would trap someone tabbing
      // through the toolbars.
      const inCanvas =
        target?.closest?.('[role="application"]') != null ||
        target === document.body ||
        target === document.documentElement;
      if (e.key === "Tab" && inCanvas && mode === "edit" && canvasPhase === "main") {
        const current = selected ?? (selectedShapes.size === 1 ? [...selectedShapes][0]! : null);
        const ref = nextSelectable(workspace, current, e.shiftKey ? -1 : 1);
        if (ref) {
          e.preventDefault();
          if (ref.kind === "node") selectNode(ref.id, false);
          else selectShape(ref.id, false);
          controls.current?.focusOn(
            (workspace.nodes[ref.id]?.position?.x ?? workspace.shapes[ref.id]?.position.x ?? 0) +
              80,
            (workspace.nodes[ref.id]?.position?.y ?? workspace.shapes[ref.id]?.position.y ?? 0) +
              40,
          );
          return;
        }
      }

      // Enter edits the focused object: rename a node, edit a shape's text.
      if (e.key === "Enter" && mode === "edit" && !mod) {
        if (selected && workspace.nodes[selected]) {
          e.preventDefault();
          setRenameNodeId(selected);
          return;
        }
        if (selectedShapes.size === 1) {
          const sid = [...selectedShapes][0]!;
          if (workspace.shapes[sid]) {
            e.preventDefault();
            setEditShapeId(sid);
            return;
          }
        }
      }

      // Proposal review shortcut: Cmd/Ctrl + Enter applies the proposal immediately.
      if (mod && e.key === "Enter" && proposal) {
        e.preventDefault();
        applyProposal();
        return;
      }

      // Tool shortcuts — only when no modifier is held.
      if (mod || e.altKey) return;
      const map: Record<string, Tool> = {
        v: "select",
        h: "hand",
        r: "rect",
        o: "ellipse",
        d: "diamond",
        t: "text",
        s: "sticky",
        a: "arrow",
        p: "pen",
        e: "eraser",
        f: "frame",
        // The toolbar has always advertised "Comment · C" but the key was unbound.
        c: "comment",
      };
      const next = map[e.key.toLowerCase()];
      if (next) {
        changeTool(next);
      } else if (e.key === "Escape") {
        if (proposal) {
          cancelProposal();
          return;
        }
        setTool("select");
        setSelectedShapes(new Set());
        setSelectedNodes(new Set());
        setSelected(null);
        setSelectedLink(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    selectedShapes,
    selectedNodes,
    selected,
    applyManual,
    workspace,
    undo,
    redo,
    mode,
    canvasPhase,
    readOnly,
    proposal,
    applyProposal,
    cancelProposal,
  ]);

  // AI image generation (Phase E): prompt → server → image shape on the canvas.
  // Supports both manual toolbar prompt and conversational voice/chat prompts.
  const generateImageShape = useCallback(
    async (customPrompt?: string) => {
      const rawPrompt = customPrompt ?? window.prompt("Describe an image for Lucent to generate:");
      if (!rawPrompt) return;
      const prompt = enrichImagePromptWithContext(rawPrompt, workspace, chat, projectName);
      notify("Generating reference image with Lucent Imagine…");
      try {
        const { src, explanation } = await generateImage(prompt, "landscape");
        const posX = viewportBox
          ? Math.round(viewportBox.x + Math.max(0, (viewportBox.width - 400) / 2))
          : 320;
        const posY = viewportBox
          ? Math.round(viewportBox.y + Math.max(0, (viewportBox.height - 250) / 2))
          : 220;
        applyManual(
          [
            {
              op: "CREATE_SHAPE",
              id: shapeId(),
              kind: "image",
              position: { x: posX, y: posY },
              size: { width: 400, height: 250 },
              src,
              z: nextZ(shapes),
            },
          ],
          "Generate image",
        );
        if (explanation) {
          notify(explanation);
          if (settings.aiSound || voiceInitiatedRef.current) {
            void speakAnswer(explanation);
            voiceInitiatedRef.current = false;
          }
        }
      } catch (err) {
        notify((err as Error).message);
      }
    },
    [applyManual, notify, shapes, viewportBox, workspace, chat, projectName, settings.aiSound],
  );

  const submit = useCallback(() => {
    const text = message.trim();
    if (!text) return;
    setMessage("");
    if (proposal) {
      notify("Superseding uncommitted proposal with new request…");
    }
    // Ask mode (Stage C1): the read direction. No selection/attachments — a
    // question about the board's history carries no board edits, and the
    // server builds its own context from the visible window.
    if (pillMode === "ask") {
      void ask(text);
      return;
    }
    // Explicit image/reference/logo generation intent:
    const imgPrompt = parseExplicitImageIntent(text);
    if (imgPrompt) {
      void generateImageShape(imgPrompt);
      return;
    }
    // Pass current selection so the AI can resolve "this/these/that" (Phase C).
    const sel = [...selectedShapes, ...(selected ? [selected] : [])];
    // Selected images and file/text objects travel with the request, so
    // "turn this screenshot into a wireframe" has something to look at.
    const attachments = collectAttachments(workspace, sel);
    void send(text, sel, attachments);
  }, [
    message,
    send,
    ask,
    pillMode,
    selectedShapes,
    selected,
    workspace,
    generateImageShape,
    proposal,
    notify,
  ]);

  const stopVoiceSession = useCallback(() => {
    voiceSessionIdRef.current++;
    if (voiceSilenceTimerRef.current) {
      clearTimeout(voiceSilenceTimerRef.current);
      voiceSilenceTimerRef.current = null;
    }
    try {
      voiceRef.current?.stop();
    } catch {
      /* ignore */
    }
    voiceRef.current = null;
    setListening(false);
  }, [setListening]);

  const commitVoiceTurn = useCallback(() => {
    const text = (accumulatedVoiceTextRef.current || message).trim();
    stopVoiceSession();
    accumulatedVoiceTextRef.current = "";
    if (!text) return;
    setMessage("");
    voiceInitiatedRef.current = true;
    if (pillMode === "ask") {
      void ask(text);
    } else {
      const imgPrompt = parseExplicitImageIntent(text);
      if (imgPrompt) {
        void generateImageShape(imgPrompt);
      } else {
        void send(text);
      }
    }
  }, [stopVoiceSession, message, pillMode, ask, generateImageShape, send]);

  const toggleVoice = useCallback(() => {
    if (listening) {
      if ((accumulatedVoiceTextRef.current || message).trim()) {
        commitVoiceTurn();
      } else {
        stopVoiceSession();
      }
      return;
    }
    if (!voiceSupported) {
      notify(
        "Voice input isn't supported in this browser — try Chrome or Edge, or type your idea.",
      );
      return;
    }
    const sessionId = ++voiceSessionIdRef.current;
    accumulatedVoiceTextRef.current = "";
    if (voiceSilenceTimerRef.current) {
      clearTimeout(voiceSilenceTimerRef.current);
      voiceSilenceTimerRef.current = null;
    }
    const provider = getSttProvider(settings.sttProvider);
    // Hosted providers need their connection details before start(); settings is
    // the only place they live, and the browser never sees a LiveKit secret.
    provider.configure?.({
      url: settings.livekitUrl,
      tokenUrl: settings.livekitTokenUrl,
      room: settings.livekitRoom,
    });
    const session = provider.start({
      onStart: () => {
        if (voiceSessionIdRef.current !== sessionId) return;
        setListening(true);
      },
      onInterim: (t) => {
        if (voiceSessionIdRef.current !== sessionId || isTtsSpeaking()) return;
        const current = accumulatedVoiceTextRef.current;
        setMessage(current ? `${current} ${t}` : t);
        if (voiceSilenceTimerRef.current) {
          clearTimeout(voiceSilenceTimerRef.current);
          voiceSilenceTimerRef.current = null;
        }
      },
      onStatus: (s) => {
        if (voiceSessionIdRef.current !== sessionId) return;
        if (s === "transcribing") notify("Transcribing on device…");
        if (s === "connecting") notify("Connecting to LiveKit…");
      },
      onFinal: (t) => {
        if (voiceSessionIdRef.current !== sessionId || isTtsSpeaking()) return;
        const cleaned = t.trim();
        if (cleaned) {
          accumulatedVoiceTextRef.current = (
            accumulatedVoiceTextRef.current ? `${accumulatedVoiceTextRef.current} ${cleaned}` : cleaned
          ).trim();
          setMessage(accumulatedVoiceTextRef.current);
        }
        if (voiceSilenceTimerRef.current) {
          clearTimeout(voiceSilenceTimerRef.current);
        }
        // 4.0s natural pause window before committing turn, giving the user ample time to speak
        voiceSilenceTimerRef.current = setTimeout(() => {
          if (voiceSessionIdRef.current === sessionId && !isTtsSpeaking()) {
            commitVoiceTurn();
          }
        }, 4000);
      },
      onError: (msg) => {
        if (voiceSessionIdRef.current !== sessionId) return;
        stopVoiceSession();
        if (msg) notify(msg);
      },
    });
    if (session) {
      voiceRef.current = session;
      if (provider.id === "whisper") {
        notify("Listening — on-device Whisper. Speak your prompt…");
      }
      if (provider.id === "browser") {
        notify("Listening — speak naturally. Tap mic again or hit Enter when done.");
      }
    }
  }, [
    listening,
    message,
    commitVoiceTurn,
    stopVoiceSession,
    voiceSupported,
    notify,
    settings.sttProvider,
    settings.livekitUrl,
    settings.livekitTokenUrl,
    settings.livekitRoom,
    setListening,
  ]);

  // LiveKit Duplex Voice Agent State
  const [voiceAgentState, setVoiceAgentState] = useState<VoiceAgentState>("idle");
  const [voiceAgentMuted, setVoiceAgentMuted] = useState(false);
  const [voiceAgentTranscript, setVoiceAgentTranscript] = useState("");
  const voiceAgentCtrlRef = useRef<VoiceAgentController | null>(null);

  const toggleVoiceAgent = useCallback(async () => {
    if (
      voiceAgentState !== "idle" &&
      voiceAgentState !== "disconnected" &&
      voiceAgentState !== "error"
    ) {
      voiceAgentCtrlRef.current?.disconnect();
      voiceAgentCtrlRef.current = null;
      setVoiceAgentState("disconnected");
      notify("Voice agent call ended.");
      return;
    }

    let activeBoardId = boardId;
    if (!activeBoardId) {
      notify("Connecting board for voice session…");
      activeBoardId = await startSharing();
    }

    if (!activeBoardId) {
      notify("Voice agent call requires a board — please sign in or try again.");
      return;
    }

    try {
      notify("Connecting to LiveKit Voice Agent…");
      const ctrl = await startVoiceAgentSession({
        boardId: activeBoardId,
        onStateChange: (st) => {
          setVoiceAgentState(st);
        },
        onTranscript: (t) => {
          setVoiceAgentTranscript(`${t.isAgent ? "Lucent: " : "You: "}${t.text}`);
        },
        onError: (err) => {
          notify(`Voice Agent: ${err}`);
        },
      });
      voiceAgentCtrlRef.current = ctrl;
      setVoiceAgentMuted(false);
    } catch (err) {
      notify(`Voice Agent connection failed: ${(err as Error).message}`);
    }
  }, [boardId, voiceAgentState, notify, startSharing]);

  const toggleVoiceAgentMute = useCallback(async () => {
    if (!voiceAgentCtrlRef.current) return;
    const nextMuted = !voiceAgentMuted;
    await voiceAgentCtrlRef.current.setMuted(nextMuted);
    setVoiceAgentMuted(nextMuted);
  }, [voiceAgentMuted]);

  useEffect(() => {
    return () => {
      voiceAgentCtrlRef.current?.disconnect();
    };
  }, []);

  const addShape = useCallback(
    (op: import("@lucent/core").Operation & { op: "CREATE_SHAPE" }) => {
      // Stack a newly drawn shape above existing ones (frames stay behind).
      const placed = op.kind === "frame" ? op : { ...op, z: nextZ(shapes) };
      const ok = applyManual([placed], `Add ${op.kind}`);
      if (!ok) {
        notify("Couldn't add that shape.");
        return;
      }
      setSelectedShapes(new Set([op.id]));
      setSelected(null);
      setTool("select");
      if (op.kind === "sticky" || op.kind === "text") {
        setEditShapeId(op.id);
      }
    },
    [applyManual, shapes, notify],
  );

  // Embed flow: prompt for a URL, resolve it, and drop an embed shape.
  const addEmbed = useCallback(() => {
    const raw = window.prompt("Paste a GIF, YouTube/Vimeo, or web link to embed:");
    if (!raw) return;
    const info = resolveEmbed(raw);
    if (!info) {
      notify("That doesn't look like a valid http(s) URL.");
      return;
    }
    const isIframe = info.mode === "iframe";
    applyManual(
      [
        {
          op: "CREATE_SHAPE",
          id: shapeId(),
          kind: "embed",
          position: { x: 300, y: 220 },
          size: isIframe ? { width: 400, height: 260 } : { width: 260, height: 200 },
          src: info.src,
          // Reuse the style.fill flag to record iframe vs image at render time.
          style: { fill: info.mode },
          z: nextZ(shapes),
        },
      ],
      "Add embed",
    );
  }, [applyManual, notify, shapes]);

  // Paste/duplicate a set of shapes offset by (dx,dy); selects the new copies.
  // Returns the new ids so callers (alt-drag) can keep dragging the copy.
  const pasteShapes = useCallback(
    (src: import("@lucent/core").Shape[], offset: number): Set<string> => {
      if (src.length === 0) return new Set();
      const ops: import("@lucent/core").Operation[] = [];
      const newIds = new Set<string>();
      const baseZ = nextZ(shapes);
      src.forEach((s, i) => {
        const nid = shapeId();
        newIds.add(nid);
        ops.push({
          op: "CREATE_SHAPE",
          id: nid,
          kind: s.kind,
          position: { x: s.position.x + offset, y: s.position.y + offset },
          size: s.size,
          ...(s.rotation !== undefined ? { rotation: s.rotation } : {}),
          ...(s.text !== undefined ? { text: s.text } : {}),
          ...(s.path !== undefined ? { path: s.path } : {}),
          ...(s.src !== undefined ? { src: s.src } : {}),
          ...(s.style ? { style: s.style } : {}),
          z: normalizeZ(baseZ + i),
        });
      });
      const ok = applyManual(ops, `Paste ${src.length} shape${src.length > 1 ? "s" : ""}`);
      if (!ok) return new Set();
      setSelectedShapes(newIds);
      setSelected(null);
      return newIds;
    },
    [applyManual, shapes],
  );

  /**
   * Alt/Option-drag: duplicate the shape (or the whole selection it belongs to)
   * in place, then let the user drag the copy. Matches Figma/Miro, where the
   * original stays put and the copy follows the cursor.
   */
  const altDragDuplicate = useCallback(
    (id: string) => {
      const group = selectedShapes.has(id) ? [...selectedShapes] : [id];
      const src = group
        .map((sid) => workspace.shapes[sid])
        .filter(Boolean) as import("@lucent/core").Shape[];
      // Zero offset: the copy lands exactly on the original so the following
      // drag is the only thing that moves it.
      const created = pasteShapes(src, 0);
      if (created.size > 0) notify("Duplicated — drag to place the copy.");
    },
    [selectedShapes, workspace.shapes, pasteShapes, notify],
  );

  // Live drag updates local override for smoothness; commit writes to history.
  // While dragging, snap the moving shape's edges to nearby shapes / grid and
  // surface the matches as Figma-style guide lines.
  const [dragOverride, setDragOverride] = useState<{ id: string; x: number; y: number } | null>(
    null,
  );
  const [guides, setGuides] = useState<AlignGuide[]>([]);
  const moveShape = useCallback(
    (id: string, x: number, y: number, commit: boolean) => {
      const others = Object.values(workspace.shapes).filter((s) => s.id !== id);
      const size = workspace.shapes[id]?.size;
      const p = snapPosition(x, y, others, 6, 8, size);
      if (commit) {
        setDragOverride(null);
        // One haptic tick when the drop lands on an alignment guide: the
        // causal gesture's payoff moment (skill §13), never on remote/AI
        // moves. Reads current guides without subscribing to them.
        setGuides((g) => {
          if (g.length > 0) emitHaptic(8);
          return [];
        });
        const moving = workspace.shapes[id];
        const dx = p.x - (moving?.position.x ?? p.x);
        const dy = p.y - (moving?.position.y ?? p.y);
        const ops: import("@lucent/core").Operation[] = [{ op: "UPDATE_SHAPE", id, position: p }];
        // A frame carries the shapes inside it; a group carries its members.
        const carried = new Set<string>();
        if (moving?.kind === "frame") {
          for (const cid of shapesInFrame(moving, Object.values(workspace.shapes)))
            carried.add(cid);
        }
        if (moving?.groupId) {
          for (const s of Object.values(workspace.shapes)) {
            if (s.id !== id && s.groupId === moving.groupId) carried.add(s.id);
          }
        }
        for (const cid of carried) {
          const c = workspace.shapes[cid]!;
          ops.push({
            op: "UPDATE_SHAPE",
            id: cid,
            position: { x: c.position.x + dx, y: c.position.y + dy },
          });
        }
        applyManual(ops, "Move shape");
      } else {
        setDragOverride({ id, x: p.x, y: p.y });
        // Guides come from the snapped position, so a line appears exactly when
        // an edge or centre actually lines up.
        setGuides(
          size
            ? alignGuides({ x: p.x, y: p.y, width: size.width, height: size.height }, others)
            : [],
        );
      }
    },
    [applyManual, workspace.shapes],
  );

  const relabelShape = useCallback(
    (id: string, label: string) => {
      applyManual([{ op: "UPDATE_SHAPE", id, text: label }], "Edit shape text");
    },
    [applyManual],
  );

  // Dragging semantic nodes. Live position is local for smoothness; the commit
  // emits MOVE_NODE, which pins the node so the layout engine stops overriding
  // it (docs/03 — layout owns positions, an explicit human placement outranks it).
  // When several nodes are selected, the whole selection moves by the same delta
  // and commits as one history entry.
  const [nodeDrag, setNodeDrag] = useState<{ ids: Set<string>; dx: number; dy: number } | null>(
    null,
  );
  const dragRaf = useRef<number | null>(null);
  const pendingNodeDrag = useRef<{ ids: Set<string>; dx: number; dy: number } | null>(null);

  const moveNode = useCallback(
    (id: string, x: number, y: number, commit: boolean) => {
      const origin = workspace.nodes[id]?.position;
      // The group that travels together: the multi-selection when the dragged
      // node is part of it, otherwise just this node.
      const group = selectedNodes.has(id) && selectedNodes.size > 1 ? [...selectedNodes] : [id];
      const dx = origin ? x - origin.x : 0;
      const dy = origin ? y - origin.y : 0;

      if (!commit) {
        // UX-P1-003: Schedule drag updates with requestAnimationFrame so rapid mouse movements
        // update React state in lockstep with the frame render loop without frame lag.
        pendingNodeDrag.current = { ids: new Set(group), dx, dy };
        if (dragRaf.current == null) {
          dragRaf.current = requestAnimationFrame(() => {
            dragRaf.current = null;
            if (pendingNodeDrag.current) {
              setNodeDrag(pendingNodeDrag.current);
            }
          });
        }
        return;
      }
      if (dragRaf.current != null) {
        cancelAnimationFrame(dragRaf.current);
        dragRaf.current = null;
      }
      pendingNodeDrag.current = null;
      setNodeDrag(null);
      const ops = group.flatMap((nid) => {
        const p = workspace.nodes[nid]?.position;
        if (!p) return [];
        return [
          {
            op: "MOVE_NODE" as const,
            id: nid,
            position: { x: Math.round(p.x + dx), y: Math.round(p.y + dy) },
          },
        ];
      });
      if (ops.length === 0) return;
      applyManual(ops, ops.length > 1 ? `Move ${ops.length} nodes` : "Move node");
    },
    [applyManual, workspace.nodes, selectedNodes],
  );

  /** Click/shift-click a node. Additive keeps the existing multi-selection. */
  const selectNode = useCallback((id: string, additive: boolean) => {
    setSelectedShapes(new Set());
    setSelectedLink(null);
    setSelectedNodes((prev) => {
      if (!additive) return new Set([id]);
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setSelected(id);
  }, []);

  /** Rename a node in place. CHANGE_TEXT existed but had no UI path. */
  const renameNode = useCallback(
    (id: string, label: string) => {
      const ok = applyManual([{ op: "CHANGE_TEXT", id, text: label }], "Rename node");
      if (!ok) notify("Couldn't rename that node.");
    },
    [applyManual, notify],
  );

  const selectShape = useCallback(
    (id: string, additive: boolean) => {
      setSelected(null);
      setSelectedLink(null);
      // Clicking a grouped shape selects the whole group as one unit.
      const gid = workspace.shapes[id]?.groupId;
      const groupMembers = gid
        ? Object.values(workspace.shapes)
            .filter((s) => s.groupId === gid)
            .map((s) => s.id)
        : [id];
      setSelectedShapes((prev) => {
        if (additive) {
          const next = new Set(prev);
          const allIn = groupMembers.every((m) => next.has(m));
          for (const m of groupMembers) {
            if (allIn) {
              next.delete(m);
            } else {
              next.add(m);
            }
          }
          return next;
        }
        return new Set(groupMembers);
      });
    },
    [workspace.shapes],
  );

  // Arrow tool: click a first shape, then a second, to bind a connector.
  const [linkSource, setLinkSource] = useState<string | null>(null);
  const [selectedLink, setSelectedLink] = useState<string | null>(null);

  const groupSelection = useCallback(() => {
    const ids = [...selectedShapes].filter((id) => workspace.shapes[id]);
    if (ids.length < 2) return;
    applyManual(
      [{ op: "GROUP_SHAPES", groupId: `grp_${Date.now().toString(36)}`, ids }],
      "Group shapes",
    );
  }, [selectedShapes, workspace.shapes, applyManual]);

  const ungroupSelection = useCallback(() => {
    const gids = new Set(
      [...selectedShapes].map((id) => workspace.shapes[id]?.groupId).filter(Boolean) as string[],
    );
    if (gids.size === 0) return;
    applyManual(
      [...gids].map((groupId) => ({ op: "UNGROUP_SHAPES" as const, groupId })),
      "Ungroup shapes",
    );
  }, [selectedShapes, workspace.shapes, applyManual]);

  const orderSelection = useCallback(
    (dir: 1 | -1) => {
      const ids = [...selectedShapes].filter((id) => workspace.shapes[id]);
      if (ids.length === 0) return;
      const zs = Object.values(workspace.shapes).map((s) => s.z ?? 0);
      const edge = dir === 1 ? Math.max(0, ...zs) + 1 : Math.min(0, ...zs) - 1;
      applyManual(
        ids.map((id, i) => ({ op: "UPDATE_SHAPE" as const, id, z: edge + i * dir })),
        dir === 1 ? "Bring to front" : "Send to back",
      );
    },
    [selectedShapes, workspace.shapes, applyManual],
  );

  const toggleLockSelection = useCallback(() => {
    const ids = [...selectedShapes].filter((id) => workspace.shapes[id]);
    if (ids.length === 0) return;
    const anyLocked = ids.some((id) => workspace.shapes[id]?.locked);
    applyManual(
      ids.map((id) => ({ op: "UPDATE_SHAPE" as const, id, locked: !anyLocked })),
      anyLocked ? "Unlock" : "Lock",
    );
  }, [selectedShapes, workspace.shapes, applyManual]);

  const deleteSelection = useCallback(() => {
    const ids = [...selectedShapes].filter(
      (id) => workspace.shapes[id] && !workspace.shapes[id]?.locked,
    );
    if (ids.length === 0) return;
    applyManual(
      ids.map((id) => ({ op: "DELETE_SHAPE" as const, id })),
      `Delete ${ids.length} shape${ids.length > 1 ? "s" : ""}`,
    );
    setSelectedShapes(new Set());
  }, [selectedShapes, workspace.shapes, applyManual]);

  const hideSelection = useCallback(() => {
    const ids = [...selectedShapes].filter((id) => workspace.shapes[id]);
    if (ids.length === 0) return;
    applyManual(
      ids.map((id) => ({ op: "UPDATE_SHAPE" as const, id, hidden: true })),
      "Hide shapes",
    );
    setSelectedShapes(new Set());
    notify(
      `Hid ${ids.length} object${ids.length > 1 ? "s" : ""}. Use Show hidden to bring them back.`,
    );
  }, [selectedShapes, workspace.shapes, applyManual, notify]);

  // Hidden shapes were previously unrecoverable without undo: nothing in the UI
  // could reveal them again.
  const hiddenCount = shapes.filter((s) => s.hidden).length;
  const showHidden = useCallback(() => {
    const ids = shapes.filter((s) => s.hidden).map((s) => s.id);
    if (ids.length === 0) return;
    applyManual(
      ids.map((id) => ({ op: "UPDATE_SHAPE" as const, id, hidden: false })),
      "Show hidden shapes",
    );
    setSelectedShapes(new Set(ids));
    notify(`Restored ${ids.length} hidden object${ids.length > 1 ? "s" : ""}.`);
  }, [shapes, applyManual, notify]);

  const buildMenuItems = useCallback((): MenuItem[] => {
    const ids = [...selectedShapes].filter((id) => workspace.shapes[id]);
    const canGroup = ids.length >= 2;
    const canUngroup = ids.some((id) => workspace.shapes[id]?.groupId);
    const anyLocked = ids.some((id) => workspace.shapes[id]?.locked);
    const src = ids
      .map((id) => workspace.shapes[id])
      .filter(Boolean) as import("@lucent/core").Shape[];
    const items: MenuItem[] = [
      { label: "Duplicate", onClick: () => pasteShapes(src, 24), disabled: ids.length === 0 },
      { label: "Bring to front", onClick: () => orderSelection(1), disabled: ids.length === 0 },
      { label: "Send to back", onClick: () => orderSelection(-1), disabled: ids.length === 0 },
      { label: "", onClick: () => {}, sep: true },
      { label: "Group", onClick: groupSelection, disabled: !canGroup },
      { label: "Ungroup", onClick: ungroupSelection, disabled: !canUngroup },
      {
        label: anyLocked ? "Unlock" : "Lock",
        onClick: toggleLockSelection,
        disabled: ids.length === 0,
      },
      { label: "Hide", onClick: hideSelection, disabled: ids.length === 0 },
      {
        label: hiddenCount ? `Show hidden (${hiddenCount})` : "Show hidden",
        onClick: showHidden,
        disabled: hiddenCount === 0,
      },
      { label: "", onClick: () => {}, sep: true },
      { label: "Delete", onClick: deleteSelection, danger: true, disabled: ids.length === 0 },
    ];
    // Diagram regions: when the current selection (or the canvas click) points
    // inside a kind-bearing group, offer that region's kind picker — the manual
    // counterpart of the AI's SET_GROUP_KIND.
    const regionId = menu?.regionId ?? regionForSelection();
    const region = regionId ? workspace.groups[regionId] : undefined;
    if (region) {
      const kindItems: MenuItem[] = [
        { label: "", onClick: () => {}, sep: true },
        {
          label: `Region "${region.label}" — diagram kind`,
          onClick: () => {},
          disabled: true,
        },
      ];
      for (const k of REGION_KIND_ORDER) {
        const active = region.kind === k;
        kindItems.push({
          label: `${active ? "● " : ""}${DIAGRAM_LABELS[k]}`,
          onClick: () => setRegionKind(region.id, k),
          disabled: active,
        });
      }
      if (region.kind) {
        kindItems.push({
          label: "Back to board layout",
          onClick: () => setRegionKind(region.id, null),
        });
      }
      items.unshift(...kindItems);
    }
    return items;
  }, [
    selectedShapes,
    workspace.shapes,
    workspace.groups,
    menu,
    regionForSelection,
    pasteShapes,
    orderSelection,
    groupSelection,
    ungroupSelection,
    toggleLockSelection,
    hideSelection,
    showHidden,
    hiddenCount,
    deleteSelection,
    setRegionKind,
  ]);

  const onShapePrimary = useCallback(
    (id: string, additive: boolean) => {
      // A live voting round turns a plain click into a vote, the way FigJam's
      // voting session does.
      if (voting) {
        applyManual(toggleVoteOps(workspace, id), "Vote");
        return;
      }
      // The comment tool opens a thread on whatever is clicked.
      if (tool === "comment") {
        setCommentTarget(id);
        setTool("select");
        return;
      }
      if (tool === "eraser") {
        // Eraser deletes the clicked shape (unless locked).
        if (!workspace.shapes[id]?.locked) {
          applyManual([{ op: "DELETE_SHAPE", id }], "Erase shape");
        }
        return;
      }
      if (tool === "arrow") {
        if (!linkSource) {
          setLinkSource(id);
        } else if (linkSource !== id) {
          applyManual(
            [
              {
                op: "CONNECT_SHAPES",
                id: `slink_${Date.now().toString(36)}`,
                source: linkSource,
                target: id,
                variant: "curved",
              },
            ],
            "Connect shapes",
          );
          setLinkSource(null);
          setTool("select");
        }
        return;
      }
      setSelectedLink(null);
      selectShape(id, additive);
    },
    [voting, tool, linkSource, applyManual, selectShape, workspace],
  );

  /** Node click: vote during a round, otherwise select (shift = add to selection). */
  const onNodeSelect = useCallback(
    (id: string, additive = false) => {
      if (voting) {
        applyManual(toggleVoteOps(workspace, id), "Vote");
        return;
      }
      selectNode(id, additive);
    },
    [voting, applyManual, workspace, selectNode],
  );

  const addDrawing = useCallback(
    (op: import("@lucent/core").Operation) => {
      applyManual([op], "Draw");
    },
    [applyManual],
  );

  // Paste an image from the clipboard as a manual image shape.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const item = [...(e.clipboardData?.items ?? [])].find((i) => i.type.startsWith("image/"));
      const file = item?.getAsFile();
      if (!file) return;
      // Downscale before it becomes a data URL (M0.5). A 12 MP screenshot is
      // several megabytes; localStorage has a 5–10 MB budget for the whole
      // origin, so pasting a few would silently break autosave.
      void downscaleImage(file).then((scaled) => {
        if (!scaled) {
          notify("That image could not be read.");
          return;
        }
        const displayScale = Math.min(1, 320 / scaled.width);
        applyManual(
          [
            {
              op: "CREATE_SHAPE",
              id: shapeId(),
              kind: "image",
              position: { x: 300, y: 240 },
              size: {
                width: Math.round(scaled.width * displayScale),
                height: Math.round(scaled.height * displayScale),
              },
              src: scaled.dataUrl,
              z: nextZ(Object.values(workspace.shapes)),
            },
          ],
          "Paste image",
        );
      });
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [applyManual, workspace.shapes, notify]);

  // Citation jump (Stage C1): a clicked citation chip with kind "node" sets
  // ?reveal=<id> and switches to the canvas (workspace.tsx onCitation). This
  // effect consumes the param — select the node and center on it, the exact
  // recipe Tab traversal uses — then clears it so a reload doesn't re-jump.
  // A node the board no longer carries (deleted since the answer) degrades to
  // nothing rather than an error: the citation was honest when made.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const reveal = params.get("reveal");
    if (!reveal) return;
    params.delete("reveal");
    window.history.replaceState(null, "", `?${params.toString()}`);
    const node = workspace.nodes[reveal];
    if (node) {
      selectNode(reveal, false);
      controls.current?.focusOn((node.position?.x ?? 0) + 80, (node.position?.y ?? 0) + 40);
    }
  }, [workspace.nodes, selectNode]);

  // Drag & drop files onto the canvas: images become image shapes, other files
  // become file chips (Phase A file objects + Phase E media, docs/15).
  useEffect(() => {
    const onDragOver = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
    };
    const onDrop = (e: DragEvent) => {
      const files = [...(e.dataTransfer?.files ?? [])];
      if (files.length === 0) return;
      e.preventDefault();
      const baseZ = nextZ(Object.values(workspace.shapes));
      files.forEach((file, i) => {
        const dropX = 260 + i * 30;
        const dropY = 200 + i * 30;
        if (file.type.startsWith("image/")) {
          // Same downscale as the paste path (M0.5): the shape carries a data
          // URL until M3 moves assets to object storage, so it has to fit in
          // the localStorage budget.
          void downscaleImage(file).then((scaled) => {
            if (!scaled) {
              notify(`${file.name} could not be read as an image.`);
              return;
            }
            const displayScale = Math.min(1, 320 / scaled.width);
            applyManual(
              [
                {
                  op: "CREATE_SHAPE",
                  id: shapeId(),
                  kind: "image",
                  position: { x: dropX, y: dropY },
                  size: {
                    width: Math.round(scaled.width * displayScale),
                    height: Math.round(scaled.height * displayScale),
                  },
                  src: scaled.dataUrl,
                  z: normalizeZ(baseZ + i),
                },
              ],
              "Drop image",
            );
          });
          return;
        }

        // Source-of-truth files (docker-compose, package.json) become a real
        // architecture diagram rather than an illustration — the diagram is
        // generated from the artifact, so it reflects what actually exists.
        const codeKind = classifyCodeFile(file.name);
        if (codeKind) {
          const reader = new FileReader();
          reader.onload = () => {
            const content = String(reader.result);
            const ops = codeToOps(file.name, content);
            if (ops.length === 0) {
              notify(`Couldn't read a diagram from ${file.name}.`);
              return;
            }
            if (applyManual(ops, `Import ${file.name}`)) {
              const nodes = ops.filter((o) => o.op === "CREATE_NODE").length;
              notify(`Built a diagram from ${file.name} — ${nodes} nodes.`);
            }
          };
          reader.readAsText(file);
          return;
        }

        // SVG, PDF, and text documents import as real objects onto the current
        // board rather than becoming an opaque file chip.
        const kind = classifyImport(file.name, file.type);
        if (kind === "svg" || kind === "pdf" || kind === "document" || kind === "csv") {
          const reader = new FileReader();
          reader.onload = () => {
            const content = String(reader.result);
            const existing = Object.values(workspace.shapes);
            const ops =
              kind === "svg"
                ? svgToOps(content, existing)
                : kind === "pdf"
                  ? pdfToOps(content, existing)
                  : kind === "csv"
                    ? csvToStickyOps(content)
                    : documentToOps(content, existing);
            if (ops.length === 0) {
              notify(
                kind === "pdf" && pdfIsCompressed(content)
                  ? "That PDF's text is compressed, so it can't be read."
                  : `Nothing importable found in ${file.name}.`,
              );
              return;
            }
            if (applyManual(ops, `Import ${file.name}`)) {
              notify(
                `Imported ${ops.length} object${ops.length > 1 ? "s" : ""} from ${file.name}.`,
              );
            }
          };
          reader.readAsText(file);
          return;
        }

        applyManual(
          [
            {
              op: "CREATE_SHAPE",
              id: shapeId(),
              kind: "file",
              position: { x: dropX, y: dropY },
              size: { width: 200, height: 44 },
              text: file.name,
              z: normalizeZ(baseZ + i),
            },
          ],
          "Drop file",
        );
      });
    };
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("drop", onDrop);
    };
  }, [applyManual, workspace.shapes, notify]);

  const resizeShape = useCallback(
    (id: string, width: number, height: number, commit: boolean) => {
      if (commit)
        applyManual([{ op: "UPDATE_SHAPE", id, size: { width, height } }], "Resize shape");
    },
    [applyManual],
  );

  // Zoom-to-fit: frame all content, honoring chrome insets so nothing hides
  // behind the toolbars or the AI pill.
  const fitToContent = useCallback(() => {
    const b = contentBounds(workspace);
    if (!b) {
      controls.current?.reset();
      return;
    }
    controls.current?.fitBounds(b);
  }, [workspace]);

  /** Frame just the current selection (Figma's ⇧2 / Miro's zoom-to-selection). */
  const fitToSelection = useCallback(() => {
    const boxes: Array<{ x: number; y: number; width: number; height: number }> = [];
    for (const id of selectedShapes) {
      const s = workspace.shapes[id];
      if (s)
        boxes.push({
          x: s.position.x,
          y: s.position.y,
          width: s.size.width,
          height: s.size.height,
        });
    }
    for (const id of selectedNodes) {
      const n = workspace.nodes[id];
      if (n?.position) {
        boxes.push({
          x: n.position.x,
          y: n.position.y,
          width: n.size?.width ?? 160,
          height: n.size?.height ?? 64,
        });
      }
    }
    if (boxes.length === 0) {
      fitToContent();
      return;
    }
    const minX = Math.min(...boxes.map((b) => b.x));
    const minY = Math.min(...boxes.map((b) => b.y));
    const maxX = Math.max(...boxes.map((b) => b.x + b.width));
    const maxY = Math.max(...boxes.map((b) => b.y + b.height));
    controls.current?.fitBounds({ x: minX, y: minY, width: maxX - minX, height: maxY - minY });
  }, [workspace, selectedShapes, selectedNodes, fitToContent]);

  // Frame existing content on mount, and again whenever a board goes from empty
  // to populated. Without the mount pass a restored board rendered at pan 0,0 —
  // its top-left corner sat under the left toolbar and the mode bar, which reads
  // as the board overlapping the chrome.
  const fitRef = useRef(fitToContent);
  fitRef.current = fitToContent;
  const fitSelectionRef = useRef(fitToSelection);
  fitSelectionRef.current = fitToSelection;
  const objectCount = nodeCount + shapes.length;
  const prevCountRef = useRef(-1);
  useEffect(() => {
    const had = prevCountRef.current;
    prevCountRef.current = objectCount;
    // -1 is the mount pass: fit whatever was restored.
    if ((had === -1 || had === 0) && objectCount > 0) {
      const t = setTimeout(() => fitRef.current(), 260);
      return () => clearTimeout(t);
    }
  }, [objectCount]);

  // Export the current board (nodes + shapes) as a downloadable SVG snapshot.
  const exportSvg = useCallback(() => {
    const svg = buildBoardSvg(workspace);
    const blob = new Blob([svg], { type: "image/svg+xml" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${projectName || "lucent-board"}.svg`;
    a.click();
    URL.revokeObjectURL(url);
    notify("Exported board as SVG.");
  }, [workspace, projectName, notify]);

  // Rasterize the SVG snapshot to a PNG via an offscreen canvas.
  const exportPng = useCallback(() => {
    const svg = buildBoardSvg(workspace);
    const svgBlob = new Blob([svg], { type: "image/svg+xml" });
    const url = URL.createObjectURL(svgBlob);
    const img = new Image();
    img.onload = () => {
      const scale = 2; // retina-quality export
      const canvas = document.createElement("canvas");
      canvas.width = img.width * scale;
      canvas.height = img.height * scale;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        URL.revokeObjectURL(url);
        notify("Couldn't render PNG in this browser.");
        return;
      }
      ctx.scale(scale, scale);
      ctx.drawImage(img, 0, 0);
      URL.revokeObjectURL(url);
      canvas.toBlob((png) => {
        if (!png) return;
        const purl = URL.createObjectURL(png);
        const a = document.createElement("a");
        a.href = purl;
        a.download = `${projectName || "lucent-board"}.png`;
        a.click();
        URL.revokeObjectURL(purl);
        notify("Exported board as PNG.");
      }, "image/png");
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      notify("Couldn't rasterize the board to PNG.");
    };
    img.src = url;
  }, [workspace, projectName, notify]);

  // Export the semantic workspace as JSON (round-trippable board data).
  const exportJson = useCallback(() => {
    const blob = new Blob([JSON.stringify(workspace, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${projectName || "lucent-board"}.json`;
    a.click();
    URL.revokeObjectURL(url);
    notify("Exported board as JSON.");
  }, [workspace, projectName, notify]);

  const downloadText = useCallback(
    (text: string, ext: string, mime: string, label: string) => {
      const blob = new Blob([text], { type: mime });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${projectName || "lucent-board"}.${ext}`;
      a.click();
      URL.revokeObjectURL(url);
      notify(label);
    },
    [projectName, notify],
  );

  const exportMarkdown = useCallback(
    () =>
      downloadText(
        boardToMarkdown(workspace),
        "md",
        "text/markdown",
        "Exported board as Markdown.",
      ),
    [workspace, downloadText],
  );
  const exportCsv = useCallback(
    () => downloadText(boardToCsv(workspace), "csv", "text/csv", "Exported board as CSV."),
    [workspace, downloadText],
  );
  // Mermaid is the interchange format GitHub, GitLab, and Notion render inline,
  // so this is the practical "integration" path: paste the board into a README.
  const exportMermaid = useCallback(
    () =>
      downloadText(boardToMermaid(workspace), "mmd", "text/plain", "Exported board as Mermaid."),
    [workspace, downloadText],
  );
  const copyMermaid = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(boardToMermaid(workspace));
      notify("Copied Mermaid to the clipboard — paste it into a README or ticket.");
    } catch {
      notify("Clipboard access was blocked. Use Export → Mermaid instead.");
    }
  }, [workspace, notify]);

  /** Import a Mermaid diagram pasted from a repo or doc. */
  const importMermaid = useCallback(() => {
    const text = window.prompt("Paste a Mermaid flowchart (flowchart TD / graph LR):");
    if (!text) return;
    const ops = mermaidToOps(text);
    if (ops.length === 0) {
      notify("Couldn't find a Mermaid flowchart in that text.");
      return;
    }
    if (applyManual(ops, "Import Mermaid")) {
      const nodes = ops.filter((o) => o.op === "CREATE_NODE").length;
      notify(`Imported ${nodes} node${nodes === 1 ? "" : "s"} from Mermaid.`);
    } else {
      // Most often an id already on the board; say so rather than failing quietly.
      notify("That Mermaid diagram conflicts with ids already on this board.");
    }
  }, [applyManual, notify]);

  // Export to PDF by opening the board SVG in a print window (user picks
  // "Save as PDF"). No dependency; works in every browser's print dialog.
  //
  // M0.5: the previous implementation opened a fresh same-origin window and
  // called `win.document.write(...)`, which inherits *this* origin's
  // localStorage and any cookies. A `srcdoc` iframe rendered into a hidden
  // host element avoids the cross-origin script path entirely: the SVG lives in
  // a sandboxed document that the parent can't talk to, and the print dialog is
  // triggered programmatically on its `contentWindow`.
  const exportPdf = useCallback(() => {
    const svg = buildBoardSvg(workspace);
    const host = document.createElement("div");
    host.style.position = "fixed";
    host.style.left = "-10000px";
    host.style.top = "0";
    host.setAttribute("aria-hidden", "true");
    const frame = document.createElement("iframe");
    // sandbox without allow-same-origin: the iframe document is opaque to us,
    // so it can't reach our localStorage, cookies, or postMessage handlers.
    frame.setAttribute("sandbox", "allow-scripts");
    frame.setAttribute("title", "print");
    host.appendChild(frame);
    document.body.appendChild(host);

    // srcdoc builds a document from a literal — safer than `document.write`
    // because no script in the parent's origin ever runs in this document.
    frame.srcdoc = buildPrintDocument(svg, projectName);
    frame.addEventListener("load", () => {
      try {
        frame.contentWindow?.focus();
        frame.contentWindow?.print();
      } catch {
        // Browsers without programmatic print (e.g. mobile Safari) leave the
        // iframe on screen; the user can still use the browser's own print
        // menu. Better than failing silently.
      }
      // Tear the host down after the print dialog closes. 30s gives a slow
      // dialog time to land before we yank the iframe.
      setTimeout(() => host.remove(), 30_000);
    });
    notify("Opening print dialog — choose “Save as PDF”.");
  }, [workspace, projectName, notify]);

  // Exactly one selected object gets the vote/react bar; a multi-selection has
  // no single target to attach a count to.
  const engagementTarget = selected ?? (selectedShapes.size === 1 ? [...selectedShapes][0]! : null);

  const proposedIds = proposal
    ? new Set(
        proposal.operations.flatMap((op) =>
          op.op === "CREATE_NODE"
            ? [op.id]
            : op.op === "CONNECT_NODES"
              ? [`${op.source}->${op.target}:${op.relationship}`]
              : [],
        ),
      )
    : undefined;

  // Preview workspace shows proposed nodes/edges alongside current state.
  // Memoised because applyPreview re-runs the layout engine: while a proposal is
  // open this used to recompute the whole layout on every pan frame and hover.
  const previewWorkspace = useMemo(
    () => (proposal ? applyPreview(workspace, proposal.operations) : workspace),
    [workspace, proposal],
  );

  // Viewport culling for the manual layer (M3). `cullRect` returns null below its
  // object threshold, so an ordinary board still mounts every shape and pays
  // nothing for the check. Culling is deliberately confined to this render list:
  // `shapes` stays whole for marquee hit-testing, z-order, the minimap,
  // zoom-to-fit and export, none of which may see a truncated board.
  const shapeCull = cullRect(viewportBox, objectCount);
  let shapeKeep: Set<string> | undefined;
  if (shapeCull) {
    // Anything mid-gesture stays mounted wherever it sits: unmounting the shape
    // under the pointer would abandon the drag, resize, rename or link.
    shapeKeep = new Set(selectedShapes);
    if (dragOverride) shapeKeep.add(dragOverride.id);
    if (editShapeId) shapeKeep.add(editShapeId);
    if (linkSource) shapeKeep.add(linkSource);
  }
  const drawShapes = visibleShapes(shapes, shapeCull, shapeKeep);

  const crumbs = [
    { label: "Personal" },
    // The board's real name — a previous fix pinned the fallback to a
    // placeholder ("E-commerce platform") for every named board, which is
    // the same bug class the identical-project-names fix (02afaa5) covered.
    {
      label: projectName || (nodeCount ? "Untitled workspace" : "Untitled workspace"),
      current: true,
    },
  ];

  // Title-block stamp: kind on the left, scale + node count on the right. The
  // mono, all-caps treatment matches an engineering sheet's bottom corner.
  const meta = (
    <div className="meta-stamp" aria-label="Board metadata">
      <span>
        Sheet <strong>A-01</strong>
      </span>
      <span style={{ color: "var(--stroke-2)" }}>|</span>
      <span>{DIAGRAM_LABELS[workspace.diagramKind]}</span>
      <span style={{ color: "var(--stroke-2)" }}>|</span>
      <span>
        Scale <strong>{zoom}%</strong>
      </span>
    </div>
  );

  // UX-2: named phases replace the char counter as the status model.
  // The workspace owns the phase; the char count rides along as detail.
  const PHASE_LABEL: Record<string, string> = {
    understanding: "Parsing intent…",
    constructing: "Designing architecture…",
    validating: "Optimizing layout…",
    applying: "Rendering nodes…",
  };
  const status =
    canvasPhase === "generating"
      ? {
          text:
            (aiPhase ? PHASE_LABEL[aiPhase] : "Constructing your diagram…") +
            (streamChars > 0 ? ` · ${streamChars} characters received` : ""),
        }
      : canvasPhase === "proposing"
        ? { text: `Proposing ${proposal?.operations.length ?? 0} changes` }
        : null;
  const genPhase = aiPhase;
  const genProgress =
    canvasPhase === "generating" && streamChars > 0 ? `${streamChars} characters received` : null;

  // P1-RF-001: a failed first generation returns to this hero, and the error
  // + retry used to live only in the collapsed conversation — invisible, the
  // request looked lost. When the hero is up and the conversation's last
  // entry is that failure, surface it here; Try again puts the prompt back
  // in the box (retrying is one deliberate send, not an auto-fire, so the
  // user can fix the request first).
  const heroFailure =
    canvasPhase === "empty" && chat.length > 0
      ? (() => {
          const last = chat[chat.length - 1]!;
          if (last.role !== "error") return null;
          // Only the immediately-preceding failed attempt: the user entry for
          // it sits right before the error.
          const userText =
            chat[chat.length - 2]?.role === "user" ? chat[chat.length - 2]!.text : undefined;
          return { text: last.text, retryPrompt: last.retryPrompt ?? userText };
        })()
      : null;

  // UX-3: one attention count across proposal/skipped/blocked/at-risk/sync.
  // Inbound + sync errors arrive via props where known; here proposal +
  // skipped ops from chat + offline state. Blocked/at-risk derive inside.
  const skippedCount =
    [...chat].reverse().find((e) => (e.skippedOps?.length ?? 0) > 0)?.skippedOps?.length ?? 0;
  const attentionItems = buildAttention(workspace, {
    proposal: proposal ? { operations: proposal.operations, request: proposal.request } : null,
    skippedCount,
    disconnected: boardId !== null && syncStatus !== "online",
  });
  // UX-6: names of peers currently selecting something (contest awareness).
  const peerEditors = peers.filter((p) => (p.selection?.length ?? 0) > 0);

  // The proposal panel occupies the right rail; hide the top-right tool cluster
  // and the minimap while it is open so nothing overlaps the review panel.
  // A viewer on someone else's shared board gets no authoring cluster at all.
  const rightClusterVisible = mode === "edit" && canvasPhase !== "proposing" && !readOnly;

  // Editing chrome is hidden outright for viewers rather than shown and then
  // failing: the server rejects their operations, so an enabled tool would be a
  // lie. Read-only affordances (pan/zoom, export, present, comments) stay.
  const canEdit = mode === "edit" && !readOnly;

  // The first-run hero replaces the whole canvas, including the draw layer. If a
  // drawing tool is armed we must show the board instead, or picking a shape on a
  // fresh board silently does nothing — the drag lands on the hero.
  const drawingArmed = tool !== "select" && tool !== "hand";
  const showHero = canvasPhase === "empty" && !drawingArmed && !blankBoardStarted;

  // UX-1: lenses render here, inside the Canvas entry — one board URL
  // (?view=canvas&lens=kanban) covers them. Each lens view is a full
  // surface (own TopBar/LeftRail/composer); the rail's Canvas button
  // returns to the visual lens. No separate destinations, no bouncing.
  if (lens !== "visual") {
    if (lens === "kanban") return <BoardView onOpenSettings={onOpenSettings} />;
    if (lens === "document") return <DocumentView onOpenSettings={onOpenSettings} />;
    if (lens === "wireframe") return <WireframeView onOpenSettings={onOpenSettings} />;
    if (lens === "sequence") return <SequenceView onOpenSettings={onOpenSettings} />;
    if (lens === "er") return <ErView onOpenSettings={onOpenSettings} />;
  }

  return (
    <div style={{ position: "absolute", inset: 0 }}>
      {showHero ? (
        <>
          <div style={{ position: "absolute", inset: 0 }}>
            <div className="canvas-grid" />
            <div className="canvas-vignette" />
          </div>
          <TopBar crumbs={crumbs} meta={meta} onOpenSettings={onOpenSettings} />
          <LeftRail onOpenSettings={onOpenSettings} />
          {/* The shape toolbar is NOT on the hero. It is `position: fixed`, so
              on the first-run page it floated over the prompt and the mode
              cluster, reading as UI that belongs to no board — a fresh user
              sees tools for a canvas they haven't made yet. Drawing is still
              one click away: "start with a blank board" below arms the sticky
              tool and swaps the hero for the real canvas. */}
          <EmptyState
            value={message}
            onChange={setMessage}
            onSubmit={submit}
            onSpeak={toggleVoice}
            onStartVoiceCall={toggleVoiceAgent}
            voiceAgentActive={
              voiceAgentState !== "idle" &&
              voiceAgentState !== "disconnected" &&
              voiceAgentState !== "error"
            }
            listening={listening}
            onGenImage={() => generateImageShape()}
            onBlankBoard={() => setBlankBoardStarted(true)}
            failedAttempt={heroFailure}
          />
          {/* The tour overlays the hero: it is the first-minute surface, and
              it unmounts itself once seen (or dismissed) — no flag threading
              through the workspace state for something read once per browser. */}
          <Tour />
        </>
      ) : (
        <>
          <CanvasViewport
            initialZoom={85}
            tool={tool === "hand" ? "hand" : "select"}
            className={drawingArmed ? "drawing-active" : undefined}
            onZoom={setZoom}
            setControls={(c) => (controls.current = c)}
            onViewport={setViewportBox}
          >
            {tool === "select" && canEdit && canvasPhase === "main" && (
              <MarqueeLayer
                scale={zoom / 100}
                shapes={shapes}
                nodes={Object.values(workspace.nodes)}
                onSelect={({ shapes: sIds, nodes: nIds }) => {
                  setSelectedShapes(sIds);
                  setSelectedNodes(nIds);
                  // Keep a focused node so the HUD has something to act on.
                  setSelected(nIds.size > 0 ? [...nIds][0]! : null);
                }}
              />
            )}
            <DiagramLayer
              workspace={previewWorkspace}
              useElkRoutes={settings.elkLayout}
              selected={selected}
              selectedNodes={selectedNodes}
              proposedIds={proposedIds}
              onSelect={onNodeSelect}
              frameLabel={`${projectName || "Untitled"} · ${DIAGRAM_LABELS[workspace.diagramKind]}`}
              spotlightId={spotlightId}
              scale={zoom / 100}
              dragOverride={nodeDrag}
              viewport={viewportBox}
              renameNodeId={renameNodeId}
              onRenameConsumed={() => setRenameNodeId(null)}
              collapsedRegions={collapsedRegions}
              onToggleCollapse={toggleRegionCollapse}
              {...(tool === "select" && canEdit
                ? { onMoveNode: moveNode, onRenameNode: renameNode }
                : {})}
            />
            <ShapeLinkLayer
              workspace={workspace}
              dragOverride={dragOverride}
              selectedLink={selectedLink}
              onSelectLink={(id) => {
                setSelectedLink(id);
                setSelectedShapes(new Set());
                setSelected(null);
              }}
            />
            {drawShapes.map((sh) => {
              const withDrag =
                dragOverride && dragOverride.id === sh.id
                  ? { ...sh, position: { x: dragOverride.x, y: dragOverride.y } }
                  : sh;
              return (
                <ShapeElement
                  key={sh.id}
                  shape={withDrag}
                  selected={selectedShapes.has(sh.id)}
                  linkSource={linkSource === sh.id}
                  scale={zoom / 100}
                  onSelect={onShapePrimary}
                  onMove={moveShape}
                  onResize={resizeShape}
                  onChangeLabel={relabelShape}
                  onAltDragDuplicate={altDragDuplicate}
                  editRequested={editShapeId === sh.id}
                  onEditConsumed={() => setEditShapeId(null)}
                  onContextMenu={(id, cx, cy) => {
                    if (!selectedShapes.has(id)) onShapePrimary(id, false);
                    setMenu({ x: cx, y: cy, regionId: regionForSelection() });
                  }}
                />
              );
            })}
            {Object.values(workspace.wireframes).map((wf, idx) => {
              const size = ON_CANVAS_WF_SIZE[wf.viewport] ?? ON_CANVAS_WF_SIZE.desktop!;
              const wfX = 1150 + idx * (size.w + 60);
              const wfY = 100;
              return (
                <div
                  key={wf.id}
                  className="frame"
                  style={{
                    position: "absolute",
                    left: wfX,
                    top: wfY,
                    width: size.w,
                    zIndex: 2,
                    background: "var(--canvas-2)",
                    borderRadius: 14,
                    boxShadow: "0 12px 36px rgba(0,0,0,0.35)",
                    border: "1px solid var(--stroke-2)",
                    padding: "32px 16px 16px",
                  }}
                >
                  <div className="frame-label" style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
                    <Ico.Grid /> {wf.title} · Wireframe · {size.label}
                  </div>
                  <div className="wf-browser">
                    <div className="wf-browser-bar">
                      <span className="wf-dot" />
                      <span className="wf-dot" />
                      <span className="wf-dot" />
                      <div className="wf-url">app.local/{wf.id}</div>
                    </div>
                    <div className="wf-canvas" style={{ maxHeight: 600, overflowY: "auto" }}>
                      <WireframeRenderer wireframe={wf} />
                    </div>
                  </div>
                </div>
              );
            })}
            {tool === "pen" && canEdit && (
              <PenLayer
                scale={zoom / 100}
                stroke="var(--ink-0)"
                onCommit={addDrawing}
                onDone={() => setTool("select")}
              />
            )}
            {guides.map((g, i) => (
              <div
                key={i}
                className={`align-guide ${g.axis}`}
                style={
                  g.axis === "v"
                    ? { left: g.at, top: g.from, height: Math.max(1, g.to - g.from) }
                    : { top: g.at, left: g.from, width: Math.max(1, g.to - g.from) }
                }
              />
            ))}
            {SHAPE_KINDS.has(tool) && canEdit && (
              <ShapeDrawLayer
                kind={tool as DropKind}
                scale={zoom / 100}
                onCreate={addShape}
                onDone={() => setTool("select")}
              />
            )}
            {/* Vote counts and reaction chips live in content space so they
                track their objects through pan and zoom. */}
            {mode !== "present" && <EngagementBadges workspace={workspace} />}
            {mode !== "present" && <CommentPins workspace={workspace} onOpen={setCommentTarget} />}
            {engagementTarget && canEdit && !voting && !drawingArmed && (
              <EngagementAnchor
                workspace={workspace}
                targetId={engagementTarget}
                onApply={applyManual}
              />
            )}
            {selected && canvasPhase === "main" && canEdit && !drawingArmed && (
              <SelectionHud
                id={selected}
                workspace={workspace}
                onExplain={(label) => void send(`Explain the "${label}" node and its role.`)}
                onExpand={(label) => void send(`Expand the "${label}" node into its sub-steps.`)}
                onTransform={() => selectDiagram(nextDiagramKind(workspace.diagramKind))}
                onComment={() => setCommentTarget(selected)}
                onWhy={(id) => setWhyNode(id)}
                onOpenMeeting={(meetingId, turnRange) => {
                  // The ✦ trust loop: jump to the meeting that created this
                  // node. The meeting id rides in the URL (?meeting=<id>) —
                  // MeetingView reads it on mount and selects that transcript,
                  // so the canvas needs no meeting state of its own. The turn
                  // range (Stage C3) lands the jump on the exact turns that
                  // produced the node — the same contract an Ask meeting
                  // citation follows.
                  const url = new URL(window.location.href);
                  if (meetingId) {
                    url.searchParams.set("meeting", meetingId);
                    if (turnRange) url.searchParams.set("turn", String(turnRange[0]));
                    else url.searchParams.delete("turn");
                  } else {
                    url.searchParams.delete("meeting");
                    url.searchParams.delete("turn");
                  }
                  window.history.replaceState({}, "", url.toString());
                  setView("meeting");
                }}
                // The statement editor commits through applyManual — the same
                // validateOperations the AI path runs, so a bad manual edit
                // is rejected exactly like a bad model op.
                onApply={canEdit ? applyManual : undefined}
              />
            )}
            {/* UX-2: one-tap provenance. The HUD answers "why is this here?"
                with the meeting quote + source jump + undo, not a tooltip. */}
            {(() => {
              if (whyNode === null) return null;
              const pos = workspace.nodes[whyNode]?.position;
              if (!pos) return null;
              return (
                <div
                  style={{
                    position: "absolute",
                    left: pos.x,
                    top: (pos.y ?? 0) + 60,
                    zIndex: 45,
                  }}
                >
                  <WhyThis nodeId={whyNode} onClose={() => setWhyNode(null)} />
                </div>
              );
            })()}
            {/* Live collaborators' cursors and selections track content space. */}
            {peers.length > 0 && <PresenceCursors peers={peers} />}
          </CanvasViewport>

          {menu && (
            <ContextMenu
              x={menu.x}
              y={menu.y}
              onClose={() => setMenu(null)}
              items={buildMenuItems()}
            />
          )}

          {peers.length > 0 && (
            <div className="presence-bar-slot">
              <PresenceBar peers={peers} />
            </div>
          )}

          {canvasPhase === "voice" && <VoiceOverlay transcript={message} />}

          {mode === "present" && canvasPhase === "main" && (
            <PresentMode
              workspace={workspace}
              controls={controls}
              step={presentStep}
              setStep={setPresentStep}
              onExit={() => {
                setMode("edit");
                controls.current?.reset();
              }}
              frameLabel={DIAGRAM_LABELS[workspace.diagramKind]}
            />
          )}

          {/* Polish lives in the Board-tools menu (UX-1): one entry point,
              not a permanent button competing with the canvas. */}

          <TopBar crumbs={crumbs} meta={meta} onOpenSettings={onOpenSettings} />
          {/* Screen-reader mirror of board structure: counts plus selection,
              announced politely on change. Visual focus-dimming (focusSet) has
              no DOM-focus meaning, so without this structural edits are silent
              for assistive tech. */}
          <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
            {t("canvas.status.summary", locale, {
              name: workspace.name || "untitled",
              nodes: Object.keys(workspace.nodes).length,
              shapes: Object.keys(workspace.shapes).length,
            })}{" "}
            {selected !== null || selectedShapes.size > 0 || selectedNodes.size > 0
              ? t("canvas.status.selected", locale, {
                  n:
                    selectedNodes.size +
                    selectedShapes.size +
                    (selected !== null && !selectedNodes.has(selected) ? 1 : 0),
                })
              : t("canvas.status.nothing", locale)}
          </div>
          {readOnly && (
            <div className="readonly-banner" role="status" aria-live="polite">
              <Ico.Eye />
              <span>You're viewing this board. Ask the owner for edit access to change it.</span>
            </div>
          )}
          {/* UX-6: realtime awareness. The protocol is sequenced + correct;
              the surface was toast-only. A persistent bar names the state. */}
          {boardId !== null && syncStatus !== "online" && (
            <div
              className="sync-banner"
              role="status"
              aria-live="polite"
              style={{
                position: "absolute",
                top: 60,
                left: "50%",
                transform: "translateX(-50%)",
                zIndex: 30,
                fontSize: 12,
                padding: "6px 14px",
                borderRadius: 999,
                border: "1px solid var(--stroke-2)",
                background: "oklch(from var(--canvas-2) l c h / 0.92)",
                color: "var(--ink-1)",
              }}
            >
              {syncStatus === "connecting"
                ? "Reconnecting… edits are queued."
                : "Offline — edits save locally and sync when the server is reachable."}
            </div>
          )}
          {/* UX-6: contest awareness — a peer acting on a selection you can see. */}
          {peerEditors.length > 0 && (
            <div
              className="peer-banner"
              role="status"
              style={{
                position: "absolute",
                top: 92,
                left: "50%",
                transform: "translateX(-50%)",
                zIndex: 30,
                fontSize: 11.5,
                padding: "5px 12px",
                borderRadius: 999,
                border: "1px solid var(--stroke-1)",
                background: "oklch(from var(--canvas-2) l c h / 0.85)",
                color: "var(--ink-2)",
              }}
            >
              {peerEditors.length === 1
                ? "A collaborator is editing a selection."
                : `${peerEditors.length} collaborators are editing selections.`}
            </div>
          )}
          {canEdit && (
            <ShapeToolbar
              activeTool={tool}
              onSelectTool={changeTool}
              onEmbed={addEmbed}
              onGenImage={generateImageShape}
              orientation="left"
            />
          )}
          <LeftRail onOpenSettings={onOpenSettings} />

          {/* UX-1 L1/L2/L3: one Board-tools menu (L2) replaces the four-button
              right pileup (Polish/Templates/Timer/Vote). The comment bell
              stays separate — comments are attention, not tools. */}
          {/* Top-right consolidated Activity & Utilities Bar */}
          {rightClusterVisible && (
            <div className="canvas-utility-bar">
              <div className="utility-bar-item">
                <button
                  className="templates-btn"
                  style={{ position: "static" }}
                  onClick={() => {
                    setToolsOpen((v) => !v);
                    setAttentionOpen(false);
                    setInboxOpen(false);
                  }}
                  aria-haspopup="menu"
                  aria-expanded={toolsOpen}
                  aria-label="Board tools"
                  title="Board tools"
                >
                  <Ico.Book /> Tools
                </button>
                {toolsOpen && (
                  <Menu onClose={() => setToolsOpen(false)} label="Board tools">
                    <button
                      role="menuitem"
                      disabled={busy || (nodeCount === 0 && shapes.length === 0)}
                      onClick={() => {
                        setToolsOpen(false);
                        void send(
                          "Review this board and improve it: fix unclear or inconsistent labels, " +
                            "add any obviously missing steps or connections, remove duplicates, and " +
                            "group related nodes. Change only what genuinely improves it, and explain " +
                            "each change.",
                        );
                      }}
                    >
                      <Ico.Sparkle /> Polish board
                    </button>
                    <button
                      role="menuitem"
                      onClick={() => {
                        setToolsOpen(false);
                        setTemplatesOpen(true);
                      }}
                    >
                      <Ico.Book /> Insert a template
                    </button>
                    <button
                      role="menuitem"
                      onClick={() => {
                        setToolsOpen(false);
                        setTimerOpen((v) => !v);
                      }}
                    >
                      <Ico.History /> Workshop timer
                    </button>
                    <button
                      role="menuitem"
                      onClick={() => {
                        setToolsOpen(false);
                        setVotePanelOpen((v) => !v);
                      }}
                    >
                      ▲ {voting ? "Stop voting" : "Voting and reactions"}
                    </button>
                  </Menu>
                )}
              </div>

              {attentionItems.length > 0 && (
                <div className="utility-bar-item">
                  <button
                    className="timer-btn"
                    style={{ position: "static", borderColor: "var(--amber-3)" }}
                    onClick={() => {
                      setAttentionOpen((v) => !v);
                      setToolsOpen(false);
                      setInboxOpen(false);
                    }}
                    aria-expanded={attentionOpen}
                    aria-label={`Needs attention, ${attentionItems.length} items`}
                    title={`${attentionItems.length} thing${attentionItems.length > 1 ? "s need" : " needs"} review`}
                  >
                    ⚠ {attentionItems.length} to review
                  </button>
                  {attentionOpen && (
                    <div role="dialog" aria-label="Needs attention" className="utility-popover">
                      <AttentionPanel items={attentionItems} />
                    </div>
                  )}
                </div>
              )}

              <div className="utility-bar-item utility-comments-cluster">
                <NotificationBell workspace={workspace} onOpenTarget={setCommentTarget} />
                <button
                  className={`inbox-btn ${openThreads ? "has" : ""}`}
                  onClick={() => {
                    setInboxOpen((v) => !v);
                    setAttentionOpen(false);
                    setToolsOpen(false);
                  }}
                  title={openThreads ? `${openThreads} open thread(s)` : "All comments"}
                  aria-label={openThreads ? `${openThreads} open comment threads` : "All comments"}
                >
                  All
                </button>
              </div>
            </div>
          )}
          {inboxOpen && canEdit && (
            <CommentInbox
              workspace={workspace}
              onApply={applyManual}
              onOpenTarget={(id) => {
                setCommentTarget(id);
                setInboxOpen(false);
              }}
              onClose={() => setInboxOpen(false)}
            />
          )}
          {commentTarget && canEdit && (
            <CommentPanel
              workspace={workspace}
              targetId={commentTarget}
              onApply={applyManual}
              onClose={() => setCommentTarget(null)}
            />
          )}
          {votePanelOpen && canEdit && (
            <VotePanel
              workspace={workspace}
              active={voting}
              onToggleActive={() => {
                const next = !voting;
                setVoting(next);
                if (next) {
                  // Arming voting turns clicks into votes, so clear any pending
                  // selection to avoid a click doing two things at once.
                  setSelected(null);
                  setSelectedShapes(new Set());
                  setTool("select");
                  notify("Voting on — click objects to vote.");
                }
              }}
              onApply={applyManual}
              onClose={() => {
                setVotePanelOpen(false);
                setVoting(false);
              }}
            />
          )}
          {timerOpen && <TimerWidget onClose={() => setTimerOpen(false)} />}
          {templatesOpen && <TemplatePicker onClose={() => setTemplatesOpen(false)} />}

          {canvasPhase === "main" && (
            <ModeBar
              mode={mode}
              onEdit={() => setMode("edit")}
              onPresent={enterPresent}
              onFocus={() => {
                if (!selected) {
                  notify("Select a node, then Focus to spotlight it.");
                  return;
                }
                setMode((m) => (m === "focus" ? "edit" : "focus"));
              }}
            />
          )}

          {canvasPhase === "proposing" && <ProposalPanel />}

          {canEdit && canvasPhase !== "proposing" && selectedShapes.size > 0 && (
            <ShapeInspector
              shapes={workspace.shapes}
              selectedIds={selectedShapes}
              onApply={applyManual}
              onSelect={setSelectedShapes}
            />
          )}

          {canEdit && canvasPhase !== "proposing" && selectedLink && (
            <LinkInspector
              workspace={workspace}
              linkId={selectedLink}
              onApply={applyManual}
              onClear={() => setSelectedLink(null)}
            />
          )}

          <VoiceAgentBar
            state={voiceAgentState}
            muted={voiceAgentMuted}
            transcript={voiceAgentTranscript}
            onToggleMute={toggleVoiceAgentMute}
            onDisconnect={() => {
              voiceAgentCtrlRef.current?.disconnect();
              voiceAgentCtrlRef.current = null;
              setVoiceAgentState("disconnected");
              notify("Voice agent call ended.");
            }}
          />

          {mode !== "present" && (
            <AIPill
              status={status}
              phase={genPhase}
              progressNote={genProgress}
              onCancel={busy ? () => cancelSend() : undefined}
              placeholder={
                canvasPhase === "proposing"
                  ? "Review proposal on right (⌘↵ to apply, Esc to cancel), or describe edits…"
                  : "Refine, add, or transform — just describe it"
              }
              value={message}
              onChange={setMessage}
              onSubmit={submit}
              mode={pillMode}
              onModeChange={setPillMode}
              onCitation={onCitation}
              listening={listening}
              onToggleMic={toggleVoice}
              voiceSupported={voiceSupported}
              onToggleVoiceAgent={toggleVoiceAgent}
              voiceAgentActive={
                voiceAgentState !== "idle" &&
                voiceAgentState !== "disconnected" &&
                voiceAgentState !== "error"
              }
              history={chat}
              busy={busy}
              shifted={canvasPhase === "proposing"}
              readOnly={readOnly}
            />
          )}
          <ZoomBadge
            zoom={zoom}
            onZoomIn={() => controls.current?.zoomIn()}
            onZoomOut={() => controls.current?.zoomOut()}
            onReset={() => controls.current?.reset()}
            onFit={fitToContent}
            overviewOn={overviewOpen}
            onToggleOverview={() => setOverviewOpen((v) => !v)}
          />
          <div className="export-btn export-menu">
            <button title="Export board">
              <Ico.Share /> Export
            </button>
            <div className="export-pop">
              <button onClick={exportSvg}>SVG</button>
              <button onClick={exportPng}>PNG</button>
              <button onClick={exportPdf}>PDF</button>
              <button onClick={exportJson}>JSON</button>
              <button onClick={exportMarkdown}>Markdown</button>
              <button onClick={exportCsv}>CSV</button>
              <button onClick={exportMermaid}>Mermaid</button>
              <div className="export-sep" />
              <button onClick={() => void copyMermaid()}>Copy Mermaid</button>
              <button onClick={importMermaid}>Paste Mermaid…</button>
            </div>
          </div>
          {mode === "edit" && overviewOpen && canvasPhase !== "proposing" && (
            <Minimap
              workspace={workspace}
              onClose={() => setOverviewOpen(false)}
              viewport={viewportBox}
              onNavigate={(cx, cy) => controls.current?.focusOn(cx, cy)}
            />
          )}
          <StatusBadge>
            {canvasPhase === "generating" || canvasPhase === "voice" ? (
              <span
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: 999,
                  background: "var(--amber-1)",
                  boxShadow: "0 0 8px var(--amber-glow)",
                }}
              />
            ) : (
              <span
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: 999,
                  background: "var(--sig-green)",
                  boxShadow: "0 0 6px oklch(0.78 0.11 155 / 0.6)",
                }}
              />
            )}
            <span className="mono">
              {shapes.length > 0 ? `${shapes.length} shape${shapes.length > 1 ? "s" : ""} · ` : ""}
              {nodeCount} nodes
              {openThreads > 0 ? ` · ${openThreads} open comment${openThreads > 1 ? "s" : ""}` : ""}
              {selected ? " · 1 selected" : settings.autosave ? " · Autosaved" : ""}
              {/* Semantic-zoom note (UX-4): edge labels hide below 70% (see
                  DiagramLayer), so say why the board looks quieter. */}
              {zoom < 70 && nodeCount > 0 ? " · overview — zoom in for labels" : ""}
              {/* Doc 18 Phase 4: the async ELK refinement is in flight over
                  the committed phase-1 geometry — the board is valid, this
                  only explains the one beat where it settles. */}
              {layoutStatus.phase === "refining" ? " · refining layout" : ""}
              {/* Degraded: every engine failed on a commit-path re-flow;
                  phase-1 geometry stands and the retry re-attempts. Quiet
                  status, never a modal (doc 18 Phase 4 item 3). */}
              {layoutStatus.phase === "degraded" ? " · layout couldn't update" : ""}
            </span>
          </StatusBadge>
          {layoutStatus.phase === "degraded" && (
            <button className="icon-btn" onClick={retryLayout} title="Re-run the layout refinement">
              Retry layout
            </button>
          )}
        </>
      )}
    </div>
  );
}

function applyPreview(
  workspace: import("@lucent/core").Workspace,
  operations: import("@lucent/core").Operation[],
) {
  // Lightweight non-committing preview: layer proposed nodes/edges/groups on top.
  const nodes = { ...workspace.nodes };
  const edges = { ...workspace.edges };
  const groups = { ...workspace.groups };
  for (const op of operations) {
    if (op.op === "CREATE_NODE" && !nodes[op.id]) {
      nodes[op.id] = {
        id: op.id,
        nodeType: op.nodeType,
        label: op.label,
        ...(op.groupId ? { groupId: op.groupId } : {}),
      };
    }
    if (op.op === "CONNECT_NODES") {
      const id = `${op.source}->${op.target}:${op.relationship}`;
      edges[id] = { id, source: op.source, target: op.target, relationship: op.relationship };
    }
    // Groups matter to the preview: without them a proposed swimlane/tier
    // diagram previewed as an ungrouped wall of boxes, then rearranged on apply.
    // The kind matters too: a proposed region previews under its own strategy.
    if (op.op === "CREATE_GROUP" && !groups[op.id]) {
      groups[op.id] = {
        id: op.id,
        label: op.label,
        children: [...op.children],
        ...(op.kind ? { kind: op.kind } : {}),
      };
    }
    if (op.op === "SET_GROUP_KIND" && groups[op.id]) {
      groups[op.id] =
        op.kind === null
          ? { ...groups[op.id]!, children: [...groups[op.id]!.children] }
          : { ...groups[op.id]!, kind: op.kind };
    }
  }
  // Attach proposed nodes to their proposed groups so the region has members.
  for (const n of Object.values(nodes)) {
    if (n.groupId && groups[n.groupId] && !groups[n.groupId]!.children.includes(n.id)) {
      groups[n.groupId] = {
        ...groups[n.groupId]!,
        children: [...groups[n.groupId]!.children, n.id],
      };
    }
  }
  const merged = { ...workspace, nodes, edges, groups };
  // Run the layout engine over the preview. Proposed nodes carry no position, so
  // without this every one of them rendered at the origin, stacked on top of each
  // other and on top of the existing board — the preview looked broken and then
  // "fixed itself" on Apply. Routes ride along (V5): the preview draws the same
  // corridors the applied board will. No direction passed (Phase 5): the
  // board's layout intent resolves, so the preview previews the intent too.
  const { layout, routes } = computeLayoutWithRoutes(merged);
  return applyRoutes(applyLayout(merged, layout), routes);
}

function SelectionHud({
  id,
  workspace,
  onExplain,
  onExpand,
  onTransform,
  onComment,
  onWhy,
  onOpenMeeting,
  onApply,
}: {
  id: string;
  workspace: import("@lucent/core").Workspace;
  onExplain: (label: string) => void;
  onExpand: (label: string) => void;
  onTransform: () => void;
  onComment: () => void;
  /** UX-2: open the WhyThis provenance popover for this node. */
  onWhy?: (id: string) => void;
  /** Open the meeting a provenance stamp points at (null = the view itself). */
  onOpenMeeting?: (meetingId: string | null, turnRange?: [number, number]) => void;
  /** Commit manual ops through the same validator the AI path uses. */
  onApply?: (ops: import("@lucent/core").Operation[], label: string) => boolean;
}) {
  const [statementOpen, setStatementOpen] = useState(false);
  const node = workspace.nodes[id];
  if (!node?.position) return null;
  const w = node.size?.width ?? 160;
  return (
    <div
      className="selection-hud"
      style={{ left: node.position.x + w / 2, top: node.position.y - 42 }}
    >
      <button onClick={() => onExplain(node.label)}>Explain</button>
      <button onClick={onTransform}>Transform</button>
      <button onClick={() => onExpand(node.label)}>Expand</button>
      <button onClick={onComment}>Comment</button>
      <button
        onClick={() => onWhy?.(id)}
        title="Why is this here? Show the evidence behind this node."
        aria-label={`Why is this here: ${node.label}`}
      >
        Why?
      </button>
      {/* Meeting provenance (M2/P0-3/Stage A → Stage C2): a node created from
          a meeting extract can always answer "why is this here?" — the quoted
          words that produced it plus the statement KINDS the turns carried,
          and a click that JUMPS to the source meeting, closing the trust loop:
          AI creates → user questions → evidence. Stage C2 reads the op-level
          provenance FIRST (it is what converges to peers/server/history,
          ADR 0022); the old metadata stamp stays as the pre-C2 fallback.
          Stage D2: the ✦ MEETING jump requires meeting evidence — a
          createdFrom-only node (plan evidence) has no transcript to open. */}
      {Boolean(
        (node.provenance?.meetingId ?? node.metadata?.meeting) ||
          node.statement?.provenance?.meetingId,
      ) && (
        <ProvenanceButton
          provenance={node.provenance}
          legacy={node.metadata?.meeting as Record<string, unknown> | undefined}
          onOpenMeeting={onOpenMeeting}
        />
      )}
      {/* The statement editor (Stage C2): kind/status/topic/supersedes, all
          committed through onApply → validateOperations — a manual edit is
          rejected exactly like a bad model op (the review's guardrail: no
          accidental cycles, no superseding a node with no statement). */}
      {onApply && (
        <StatementEditor
          node={node}
          workspace={workspace}
          open={statementOpen}
          setOpen={setStatementOpen}
          onApply={onApply}
        />
      )}
      <div className="sep" />
      <button style={{ padding: "5px 8px" }}>
        <Ico.Down />
      </button>
    </div>
  );
}

/** The ✦ provenance jump, reading the op-level field with the legacy fallback. */
function ProvenanceButton({
  provenance,
  legacy,
  onOpenMeeting,
}: {
  provenance?: {
    meetingId?: string;
    turnRange?: [number, number];
    turnKinds?: string[];
    quote?: string;
  };
  legacy?: Record<string, unknown>;
  /**
   * Stage C3: the jump now carries the turn RANGE when the provenance has
   * one — the board→evidence link lands on the exact turns instead of the
   * transcript's top, closing the same contract the Ask citation path has
   * had since C1 (citationTarget: meeting → ?meeting= + ?turn=).
   */
  onOpenMeeting?: (meetingId: string | null, turnRange?: [number, number]) => void;
}) {
  const source = provenance ?? {
    meetingId: typeof legacy?.meetingId === "string" ? legacy.meetingId : undefined,
    turnRange: legacy?.turnRange as [number, number] | undefined,
    turnKinds: legacy?.turnKinds as string[] | undefined,
    quote: typeof legacy?.quote === "string" ? legacy.quote : undefined,
  };
  const quote = source.quote ?? "";
  const kinds = source.turnKinds ?? [];
  const range = source.turnRange;
  return (
    <button
      className="mono"
      onClick={() => {
        const meetingId = source.meetingId;
        if (meetingId && meetingId !== "live-session") {
          onOpenMeeting?.(meetingId, range);
        } else {
          // A live-session stamp (capture without a stored transcript)
          // has no meeting to open — go to the view itself.
          onOpenMeeting?.(null);
        }
      }}
      title={`Created from meeting discussion: “${quote}”${
        kinds.length ? `\nStatement kinds: ${kinds.join(", ")}` : ""
      }${range ? `\nTurns: ${range[0]}–${range[1]}` : ""}\nClick to open the source meeting${range ? " at those turns" : ""}`}
      style={{
        color: "var(--amber-2)",
        padding: "0 6px",
        fontSize: 11,
        background: "transparent",
        border: "none",
        cursor: "pointer",
      }}
    >
      ✦{kinds.length > 0 ? ` ${kinds.join("·")}` : ""}
    </button>
  );
}

/**
 * The per-node statement editor: one popover, three constrained fields. The
 * supersedes list offers ONLY nodes that carry statements (the validator
 * would refuse anything else, and the picker should not propose a refusal),
 * and the commit is a validated op batch — statementEditOps builds the exact
 * op the model would emit, so manual and AI edits share one contract.
 */
function StatementEditor({
  node,
  workspace,
  open,
  setOpen,
  onApply,
}: {
  node: import("@lucent/core").Node;
  workspace: import("@lucent/core").Workspace;
  open: boolean;
  setOpen: (v: boolean) => void;
  onApply: (ops: import("@lucent/core").Operation[], label: string) => boolean;
}) {
  const prior = node.statement;
  const [kind, setKind] = useState(prior?.kind ?? "decision");
  const [status, setStatus] = useState(prior?.status ?? "open");
  const [topic, setTopic] = useState(prior?.topic ?? "");
  // Stage C5: the dismissed duplicate hint for the CURRENT typed value —
  // "Keep" means keep, not nag again on the next render. Any edit to the
  // field re-arms the hint (a new value is a new question).
  const [dismissedHint, setDismissedHint] = useState<string | null>(null);
  const activeHint =
    dismissedHint !== null && dismissedHint === topic.trim()
      ? undefined
      : topicDuplicateHint(topic, workspace);
  const [supersedes, setSupersedes] = useState<ReadonlySet<string>>(
    new Set(prior?.supersedes ?? []),
  );

  // Candidates: statement-carrying nodes other than this one. The validator
  // refuses everything else (no statement, self, cycles) — the picker offers
  // only what can succeed.
  const candidates = useMemo(
    () => Object.values(workspace.nodes).filter((n) => n.statement && n.id !== node.id),
    [workspace.nodes, node.id],
  );

  if (!open) {
    return (
      <button
        className="mono"
        title={prior ? "Edit statement" : "Make this node a statement"}
        onClick={() => setOpen(true)}
        style={{
          color: prior ? "var(--amber-2)" : "var(--ink-3)",
          padding: "0 6px",
          fontSize: 11,
          background: "transparent",
          border: "none",
          cursor: "pointer",
        }}
      >
        ✎{prior ? ` ${prior.kind}` : ""}
      </button>
    );
  }

  const commit = () => {
    // statementEditOps builds the op; applyManual runs the SAME validator
    // the model's ops run through. A refused edit (cycle, bad topic) returns
    // false here and the popover stays open — rejected visibly, not silently.
    const ops = statementEditOps(node.id, prior, {
      kind,
      status,
      topic: topic.trim().length > 0 ? topic.trim() : undefined,
      supersedes: [...supersedes],
    });
    const label = prior ? `Update ${prior.kind} statement` : "Set statement";
    if (!onApply(ops, label)) return;
    setOpen(false);
  };

  return (
    <div
      className="statement-editor"
      style={{
        position: "absolute",
        top: 40,
        left: "50%",
        transform: "translateX(-50%)",
        width: 280,
        padding: 14,
        borderRadius: 12,
        border: "1px solid var(--stroke-2)",
        background: "var(--canvas-0)",
        boxShadow: "var(--elev-3)",
        display: "flex",
        flexDirection: "column",
        gap: 10,
        zIndex: 40,
      }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span
          className="mono"
          style={{ fontSize: 10, color: "var(--ink-3)", textTransform: "uppercase" }}
        >
          Statement
        </span>
        <span style={{ flex: 1 }} />
        <button
          className="icon-btn"
          style={{ height: 22, width: 22 }}
          title="Close"
          onClick={() => setOpen(false)}
        >
          <Ico.Down style={{ transform: "rotate(180deg)" }} />
        </button>
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <label style={{ flex: 1, fontSize: 11, color: "var(--ink-2)" }}>
          Kind
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as typeof kind)}
            style={{ width: "100%", marginTop: 4 }}
          >
            {STATEMENT_KINDS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </label>
        <label style={{ flex: 1, fontSize: 11, color: "var(--ink-2)" }}>
          Status
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value as typeof status)}
            style={{ width: "100%", marginTop: 4 }}
          >
            {STATEMENT_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label style={{ fontSize: 11, color: "var(--ink-2)" }}>
        Topic (kebab-case)
        <input
          value={topic}
          placeholder="e.g. pricing"
          onChange={(e) => setTopic(e.target.value)}
          list="statement-topic-suggestions"
          style={{ width: "100%", marginTop: 4 }}
        />
        {/* Stage C5: the board's existing authored topics — offered, never
            forced. Adopting one is one click; typing a new key stays free. */}
        <datalist id="statement-topic-suggestions">
          {topicSuggestions(workspace).map((t) => (
            <option key={t} value={t} />
          ))}
        </datalist>
      </label>
      {/* Stage C5 (ADR 0025, rule 3): the challenge layer. When the typed
          topic variant-matches exactly one existing authored key, surface
          the possible duplicate WITH EVIDENCE — statement count — and let
          the human decide. Accept sets the field (the commit then runs
          through the same statementEditOps → applyManual → validator path
          as any edit: an explicit user action, satisfying the invariant);
          Keep commits exactly as typed. Nothing auto-applies, no LLM is
          called, and the authored text is never rewritten by anything but
          the user's own click. */}
      {(() => {
        const hint = activeHint;
        if (!hint) return null;
        return (
          <div
            className="mono"
            style={{
              fontSize: 10.5,
              lineHeight: 1.5,
              padding: "6px 8px",
              borderRadius: 8,
              border: "1px solid var(--amber-2)",
              color: "var(--ink-1)",
              background: "var(--canvas-1)",
            }}
          >
            <div>
              Possible duplicate — &quot;{topic.trim()}&quot; may refer to existing &quot;
              {hint.existing}&quot; ({hint.statements}{" "}
              {hint.statements === 1 ? "statement" : "statements"} carry it).
            </div>
            <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
              <button
                className="btn amber"
                style={{ height: 22, fontSize: 10.5 }}
                onClick={() => setTopic(hint.existing)}
              >
                Use &quot;{hint.existing}&quot;
              </button>
              <button
                className="btn"
                style={{ height: 22, fontSize: 10.5 }}
                onClick={() => setDismissedHint(topic.trim())}
              >
                Keep &quot;{topic.trim()}&quot;
              </button>
            </div>
          </div>
        );
      })()}
      <label style={{ fontSize: 11, color: "var(--ink-2)" }}>
        Supersedes
        <select
          multiple
          value={[...supersedes]}
          onChange={(e) =>
            setSupersedes(new Set([...e.target.selectedOptions].map((o) => o.value)))
          }
          style={{ width: "100%", marginTop: 4, minHeight: candidates.length ? undefined : 28 }}
          size={Math.min(4, Math.max(2, candidates.length))}
        >
          {candidates.map((n) => (
            <option key={n.id} value={n.id}>
              {n.label.slice(0, 32)} ({n.statement!.kind})
            </option>
          ))}
        </select>
      </label>
      <button className="btn amber" style={{ height: 28, fontSize: 12 }} onClick={commit}>
        {prior ? "Update statement" : "Set statement"}
      </button>
    </div>
  );
}

/**
 * Positions the vote/react bar under whichever object is selected, whether that
 * is a semantic node or a manual shape.
 */
function EngagementAnchor({
  workspace,
  targetId,
  onApply,
}: {
  workspace: import("@lucent/core").Workspace;
  targetId: string;
  onApply: (ops: import("@lucent/core").Operation[], label: string) => boolean;
}) {
  const node = workspace.nodes[targetId];
  const shape = workspace.shapes[targetId];
  const box =
    node?.position && node.size
      ? { x: node.position.x, y: node.position.y, width: node.size.width, height: node.size.height }
      : shape
        ? {
            x: shape.position.x,
            y: shape.position.y,
            width: shape.size.width,
            height: shape.size.height,
          }
        : null;
  if (!box || shape?.hidden) return null;

  return (
    <div
      className="engagement-anchor"
      style={{ left: box.x + box.width / 2, top: box.y + box.height + 12 }}
    >
      <EngagementBar workspace={workspace} targetId={targetId} onApply={onApply} />
    </div>
  );
}

/** Cycle to the next representation for the Transform HUD action. */
function nextDiagramKind(
  current: import("@lucent/core").DiagramKind,
): import("@lucent/core").DiagramKind {
  const order: import("@lucent/core").DiagramKind[] = [
    "flowchart",
    "architecture",
    "mindmap",
    "journey",
    "decisiontree",
    "process",
    "orgchart",
  ];
  const i = order.indexOf(current);
  return order[(i + 1) % order.length]!;
}

/** The kinds a region may be set to, in the same order as the board picker. */
const REGION_KIND_ORDER: import("@lucent/core").DiagramKind[] = [
  "flowchart",
  "architecture",
  "mindmap",
  "journey",
  "decisiontree",
  "process",
  "orgchart",
];

/** Mode switcher: edit / present / focus. The extension point where remote
 * collaboration modes (Follow, Spotlight) register later (docs/12). */
function ModeBar({
  mode,
  onEdit,
  onPresent,
  onFocus,
}: {
  mode: "edit" | "present" | "focus";
  onEdit: () => void;
  onPresent: () => void;
  onFocus: () => void;
}) {
  return (
    <div className="mode-bar">
      <button
        className={`mode-btn ${mode === "edit" ? "active" : ""}`}
        onClick={onEdit}
        title="Edit"
      >
        <ToolIco.Select /> Edit
      </button>
      <button
        className={`mode-btn ${mode === "focus" ? "active" : ""}`}
        onClick={onFocus}
        title="Focus selected node"
      >
        <Ico.Layers /> Focus
      </button>
      <button
        className={`mode-btn ${mode === "present" ? "active" : ""}`}
        onClick={onPresent}
        title="Present walkthrough"
      >
        <Ico.Play /> Present
      </button>
    </div>
  );
}
