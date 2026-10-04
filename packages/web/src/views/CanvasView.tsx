import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { resolveLocale, t } from "@lucent/i18n";
import { applyLayout, applyRoutes, computeLayoutWithRoutes } from "@lucent/core";
import { Ico } from "../ui/icons.js";
import { AIPill } from "../ui/AIPill.js";
import { TopBar, LeftRail, ZoomBadge, StatusBadge, type Crumb } from "../ui/Chrome.js";
import { CanvasViewport, emitHaptic, type Camera, type ViewportControls } from "../ui/atoms.js";
import { DiagramLayer } from "../ui/DiagramLayer.js";
import {
  ShapeToolbar,
  ShapeElement,
  ShapeLinkLayer,
  SHAPE_KINDS,
  type Tool,
  type DropKind,
} from "../ui/ShapeToolbar.js";
import { BoardPromptPopover } from "../ui/BoardPromptPopover.js";
import { ToolIco } from "../ui/icons.js";
import { EmptyState } from "./EmptyState.js";
import { Tour } from "../ui/Tour.js";
import { ProposalPanel } from "./ProposalPanel.js";
import { AttentionPanel } from "./AttentionPanel.js";
import { NodeInspector } from "./NodeInspector.js";
import type { HeroAttachments } from "./EmptyState.js";
import { BoardView } from "./BoardView.js";
import { DocumentView } from "./DocumentView.js";
import { WireframeView } from "./WireframeView.js";
import { SequenceView } from "./SequenceView.js";
import { ErView } from "./ErView.js";
import { Menu } from "../ui/primitives.js";
import { buildAttention } from "../attention.js";
import { VoiceOverlay } from "./VoiceOverlay.js";
import { StatementGlyph } from "../ui/StatementGlyph.js";
import { PresentMode } from "./PresentMode.js";
import { buildSlidesDocument, slidesOf } from "../board/slides.js";
import { PenLayer } from "./PenLayer.js";
import { onCanvasCommand, sendCanvasCommand, type CanvasCommand } from "../canvasCommands.js";
import { preloadExportData } from "../board/exportData.js";
import { placeImage, uploadGeneratedImage } from "../assets.js";
import {
  fitSize,
  replaceWithVectorOps,
  sketchToVectorOps,
  svgToVectorOp,
  vectorFromGlyph,
  vectorShapeOp,
} from "../vector/ops.js";
import { VECTORS_OPEN_EVENT, VectorsPanel } from "../vector/VectorsPanel.js";
import { traceImage } from "../vector/trace.js";
import { assetUrl } from "../assets.js";
import { loadIcon } from "../icons/registry.js";
import { MarqueeLayer } from "./MarqueeLayer.js";
import { cullRect, diagramScene, visibleShapes } from "../board/culling.js";
import { ShapeDrawLayer } from "./ShapeDrawLayer.js";
import { ShapeInspector, Z_MOVE_LABEL, type StructureAction } from "./ShapeInspector.js";
import { planThemeLayout, sortableStickies } from "../board/themeLayout.js";
import { sortIntoThemes, sortedBy } from "../themes.js";
import { LinkInspector } from "./LinkInspector.js";
import { Minimap } from "./Minimap.js";
import { TemplatePicker } from "./TemplatePicker.js";
import { TimerWidget } from "./TimerWidget.js";
import { ContextMenu, type MenuItem } from "./ContextMenu.js";
import {
  canvasTargetAt,
  clientToContent,
  familyMenuItems,
  type CanvasHitHint,
} from "./familyMenu.js";
import { EngagementBadges, EngagementBar, VotePanel } from "./Engagement.js";
import { CommentInbox, CommentPanel, CommentPins, NotificationBell } from "./Comments.js";
import { FollowBar, PresenceBar, PresenceCursors } from "./Presence.js";
import { useFollow } from "./useFollow.js";
import { getSessionUser } from "../session.js";
import { toggleVoteOps } from "../board/engagement.js";
import { openThreadCount } from "../board/comments.js";
import { boardIsBlank, useWorkspace } from "../workspace.js";
import { useSettings } from "../settings.js";
import { useToast } from "../ui/Toast.js";
import { generateImage } from "../api.js";
import { WireframeRenderer } from "../ui/WireframeRenderer.js";
import { speakAnswer, isTtsSpeaking, type TtsPlayback } from "../tts.js";
import {
  END_OF_TURN_MS,
  IDLE_END_MS,
  INTERIM_GRACE_MS,
  isEndOfConversation,
  spokenReply,
  type VoicePhase,
} from "../voiceConversation.js";
import { getSttProvider, isAnyVoiceSupported, type VoiceSession } from "../stt/index.js";
import { VoiceAgentBar } from "../ui/VoiceAgentBar.js";
import {
  startVoiceAgentSession,
  withTranscriptSegment,
  type TranscriptLine,
  type VoiceAgentController,
  type VoiceAgentState,
} from "../stt/voiceAgentSession.js";
import { cloneShapeOp, nextZ, normalizeZ, shapeId, zOrderOps, type ZMove } from "../shapes.js";
import { resolveEmbed } from "../embed.js";
import { boardToMarkdown, boardToCsv } from "../board/serialize.js";
import { boardToMermaid, detectMermaid } from "@lucent/core";
import type { Shape } from "@lucent/core";
import { planMermaidImport } from "../board/mermaidImport.js";
import {
  classifyImport,
  collectAttachments,
  delimitedToTableOp,
  documentToOps,
  pastedTableOp,
  pdfIsCompressed,
  pdfToOps,
  TABLE_TRIM_NOTE,
} from "../board/importers.js";
import { classifyCodeFile, codeToOps } from "../board/codeImport.js";
import {
  LUCENT_CLIP_MIME,
  clipFromSelection,
  clipText,
  parseClip,
  planPaste,
  svgSize,
  svgTextToDataUrl,
  textPasteOp,
} from "../board/clipboard.js";
import {
  snapPosition,
  alignGuides,
  contentBounds,
  buildBoardSvg,
  escapeAttr,
  shapesInFrame,
  nextSelectable,
  alignPositions,
  distributePositions,
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
  workspace?: {
    nodes?: Record<string, { label?: string }>;
    shapes?: Record<string, { label?: string; text?: string }>;
  },
  chat?: Array<{ role: string; text: string }>,
  projectName?: string,
): string {
  const p = prompt.trim();
  const needsContext =
    p === "reference image or logo for the current board" ||
    /\b(the brand|the project|we discussed|discussed earlier|our logo|this logo|the app|the restaurant|instead|image generation)\b/i.test(
      p,
    ) ||
    p.length < 25;

  if (!needsContext) return p;

  const hints: string[] = [];
  if (projectName && projectName !== "Untitled" && projectName !== "Personal") {
    hints.push(projectName);
  }

  if (chat && chat.length > 0) {
    for (let i = chat.length - 1; i >= Math.max(0, chat.length - 6); i--) {
      const msg = chat[i]?.text ?? "";
      const matchBrand = msg.match(
        /\b(?:for|named|called|restaurant name|brand name)\s+([A-Z][a-zA-Z0-9_-]+)/i,
      );
      if (matchBrand && matchBrand[1] && !hints.includes(matchBrand[1])) {
        hints.push(matchBrand[1]);
      }
      const matchDomain = msg.match(
        /\b([a-zA-Z\s]+platform|[a-zA-Z\s]+restaurant|[a-zA-Z\s]+service|[a-zA-Z\s]+app)\b/i,
      );
      if (matchDomain && matchDomain[1]) {
        const cleaned = matchDomain[1].trim();
        if (
          cleaned.length < 40 &&
          !hints.some((h) => h.toLowerCase().includes(cleaned.toLowerCase()))
        ) {
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
 * docs/27 D2: the diagram verbs for a selection of stickies. The notes'
 * wording is the person's, so it is kept; the result lands beside the
 * stickies as its own region, and the stickies stay put.
 */
const STRUCTURE_PROMPTS: Record<Exclude<StructureAction, "themes">, string> = {
  flowchart:
    "Turn the selected sticky notes into a flowchart: each note becomes one step or decision, labelled with the note's own wording, connected in the order the process runs. Build it as its own diagram region beside the notes, and leave the sticky notes where they are.",
  mindmap:
    "Turn the selected sticky notes into a mind map: choose the central topic they share, and make each note a branch or sub-branch labelled with its own wording. Build it as its own diagram region beside the notes, and leave the sticky notes where they are.",
  matrix:
    "Place the selected sticky notes on a 2×2 matrix — impact × effort, unless the notes clearly suggest better axes: one group per quadrant, each note a node in the quadrant it belongs to, labelled with its own wording. Build it as its own matrix region beside the notes, and leave the sticky notes where they are.",
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
    streamNodes,
    sketchOrder,
    cancelSketch,
    genPhase: aiPhase,
    cancelSend,
    canvasPhase,
    proposal,
    applyProposal,
    cancelProposal,
    listening,
    setListening,
    send,
    proposeOps,
    ask,
    pillMode,
    setPillMode,
    onCitation,
    setRegionKind,
    convertBoard,
    layoutStatus,
    retryLayout,
    applyManual,
    projectName,
    undo,
    redo,
    peers,
    readOnly,
    canComment,
    setView,
    lens,
    syncStatus,
    boardId,
    startSharing,
    startSharingDetailed,
    setPresence,
    spotlight,
    setSpotlight,
    summon,
    lastSummon,
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
  const canEdit = mode === "edit" && !readOnly;
  // docs/26 F8: a commenter may open threads, reply and resolve, though not
  // edit — everything comment-shaped keys off this, not canEdit.
  const canTalk = mode === "edit" && canComment;
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
  // V5 semantic zoom (docs/26 §6.5): at the summary-cards rung every region is
  // a card by default; these are the ones the reader opened back up. Separate
  // from collapsedRegions so the auto and manual modes never share meaning.
  const [expandedRegions, setExpandedRegions] = useState<Set<string>>(new Set());
  const toggleRegionExpand = useCallback((groupId: string) => {
    setExpandedRegions((prev) => {
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
  /**
   * The open context menu. `regionId` is the semantic group it is about (a
   * region, or a plain group that could become one); `canvas` marks a menu
   * opened on the board itself — background, a node, a region — which carries
   * only the diagram-family rows, not the shape-selection actions.
   */
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    regionId?: string | undefined;
    canvas?: boolean;
  } | null>(null);
  /** UX-1: single Board-tools menu replaces the 4-button right pileup. */
  const [toolsOpen, setToolsOpen] = useState(false);
  /** UX-3: attention drawer (proposal/skipped/blocked/at-risk/inbound/sync). */
  const [attentionOpen, setAttentionOpen] = useState(false);

  /**
   * The semantic group the current selection sits inside, if any, so a
   * right-click knows which region it is about. A kind-bearing group (a
   * region) wins; failing that, a plain group — which the menu offers to make
   * a region. Falls back through every selected node so a marquee inside one
   * region still finds it.
   */
  const regionForSelection = useCallback((): string | undefined => {
    const ids = selected ? [selected, ...selectedNodes] : [...selectedNodes];
    let plain: string | undefined;
    for (const id of ids) {
      const gid = workspace.nodes[id]?.groupId;
      const group = gid ? workspace.groups[gid] : undefined;
      if (!gid || !group) continue;
      if (group.kind) return gid;
      plain ??= gid;
    }
    return plain;
  }, [selected, selectedNodes, workspace.nodes, workspace.groups]);
  const controls = useRef<ViewportControls | null>(null);

  // docs/28 S5: follow someone's view, the spotlight, "bring everyone here" —
  // and what the others need for it: where I look, point and select.
  const meId = getSessionUser()?.id ?? null;
  const followModes = useFollow({
    controls,
    viewportBox,
    zoom,
    peers,
    spotlight,
    lastSummon,
    setPresence,
    meId,
  });
  const selectionKey = [...selectedNodes, ...selectedShapes].sort().join(",");
  useEffect(() => {
    setPresence({ selection: selectionKey ? selectionKey.split(",") : [] });
  }, [selectionKey, setPresence]);
  /** The pointer, in board coordinates, for the others' live cursors. */
  const publishCursor = (e: React.PointerEvent<HTMLDivElement>) => {
    const at = controls.current?.clientToContent(e.clientX, e.clientY);
    if (at) setPresence({ cursor: { x: Math.round(at.x), y: Math.round(at.y) } });
  };
  const voiceRef = useRef<VoiceSession | null>(null);
  const voiceSupported = isAnyVoiceSupported();
  const voiceInitiatedRef = useRef(false);
  const accumulatedVoiceTextRef = useRef("");
  const voiceSilenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const voiceSessionIdRef = useRef(0);
  const lastSpokenChatIndexRef = useRef(chat.length);
  // A voice conversation is on (voiceConversation.ts): Lucent answers aloud,
  // then listens again, until the person is done.
  const conversingRef = useRef(false);
  const [voicePhase, setVoicePhase] = useState<VoicePhase>("idle");
  const voicePlaybackRef = useRef<TtsPlayback | null>(null);
  const voiceIdleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  // Typed turns: speak Lucent's reply aloud only when "AI sound" is on. A
  // voice conversation speaks its own replies (and listens again after).
  useEffect(() => {
    if (chat.length > lastSpokenChatIndexRef.current) {
      const latest = chat[chat.length - 1];
      lastSpokenChatIndexRef.current = chat.length;
      if (conversingRef.current) {
        voiceInitiatedRef.current = false;
        return;
      }
      if (latest && latest.role === "ai" && latest.text) {
        const toSpeak = (latest.reply ?? latest.text)
          .replace(/— review \d+ proposed changes\./i, "")
          .trim();
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

  // The board's frames, in slide order (docs/26 §6.1): what Present steps
  // through and what "Slides PDF" prints, when there are any.
  const slides = useMemo(() => slidesOf(workspace), [workspace]);

  // Leaving a diagram or losing all nodes resets any active mode — unless
  // it's a presentation of frames, which needs no nodes.
  useEffect(() => {
    if (nodeCount === 0 && mode !== "edit" && !(mode === "present" && slides.length > 0))
      setMode("edit");
  }, [nodeCount, mode, slides.length]);

  const enterPresent = useCallback(() => {
    if (nodeCount === 0 && slides.length === 0) {
      notify("Generate a diagram or add frames first, then present.");
      return;
    }
    setSelected(null);
    setSelectedShapes(new Set());
    setPresentStep(0);
    setMode("present");
  }, [nodeCount, slides.length, notify]);

  // The node spotlighted by present mode (in layout order) or focus mode. A
  // presentation of frames spotlights no node: the slide is the focus.
  const orderedNodeIds = Object.keys(workspace.nodes);
  const presentSpotlightId =
    mode === "present" && slides.length === 0
      ? (orderedNodeIds[Math.min(presentStep, orderedNodeIds.length - 1)] ?? null)
      : null;
  const spotlightId = mode === "present" ? presentSpotlightId : mode === "focus" ? selected : null;

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

      // Stacking order: ⌘] / ⌘[ one step, with Shift all the way. By code,
      // not key, so it works on layouts where Shift turns ] into }.
      if (
        mod &&
        (e.code === "BracketRight" || e.code === "BracketLeft") &&
        selectedShapes.size > 0
      ) {
        e.preventDefault();
        const up = e.code === "BracketRight";
        orderSelection(e.shiftKey ? (up ? "front" : "back") : up ? "forward" : "backward");
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

      // ⌘C / ⌘X / ⌘V are deliberately not handled here: the browser's copy,
      // cut and paste events carry the system clipboard (see the clipboard
      // effect below), and a keydown preventDefault would suppress them.

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
        sendCanvasCommand({ kind: "fit" });
        return;
      }
      if (!mod && e.shiftKey && e.key === "@") {
        e.preventDefault();
        sendCanvasCommand({ kind: "fitSelection" });
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
        i: "highlighter",
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
    async (customPrompt?: string): Promise<string | null> => {
      // The input is collected by the board-anchored BoardPromptPopover (or a
      // voice/chat prompt), never a native window.prompt — so a bare call with
      // no prompt is a no-op rather than a browser dialog.
      const rawPrompt = customPrompt;
      if (!rawPrompt) return null;
      const prompt = enrichImagePromptWithContext(rawPrompt, workspace, chat, projectName);
      notify("Generating reference image with Lucent Imagine…");
      try {
        const { src: generatedSrc, explanation } = await generateImage(
          prompt,
          "landscape",
          boardId,
        );
        // Move the bytes into the asset store on a shared board, so a ~2.6 MB
        // generated PNG rides a 20-byte `asset:` reference instead of the op
        // log. Falls back to the data URL on a local board or an upload failure.
        const src = await uploadGeneratedImage(generatedSrc, boardId);
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
          // A voice conversation says it itself, then listens again.
          if ((settings.aiSound || voiceInitiatedRef.current) && !conversingRef.current) {
            void speakAnswer(explanation);
            voiceInitiatedRef.current = false;
          }
        }
        return explanation ?? "I've added the image to the board.";
      } catch (err) {
        notify((err as Error).message);
        return `I couldn't make that image: ${(err as Error).message}`;
      }
    },
    [
      applyManual,
      notify,
      shapes,
      viewportBox,
      workspace,
      chat,
      projectName,
      settings.aiSound,
      boardId,
    ],
  );

  // The hero's attach path: a screenshot or document chosen before there is
  // anything on the board to select. Same send, same validator; the files
  // ride as the request's images/documents. Words are optional — a lone
  // screenshot is a request too ("build this").
  const submitWithAttachments = useCallback(
    (attachments: HeroAttachments) => {
      const text = message.trim() || "Build the board this attachment describes.";
      setMessage("");
      void send(text, [], attachments);
    },
    [message, send],
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

  const clearVoiceTimers = () => {
    if (voiceSilenceTimerRef.current) {
      clearTimeout(voiceSilenceTimerRef.current);
      voiceSilenceTimerRef.current = null;
    }
    if (voiceIdleTimerRef.current) {
      clearTimeout(voiceIdleTimerRef.current);
      voiceIdleTimerRef.current = null;
    }
  };

  /** Stop the recognizer (one turn's listening); the conversation may go on. */
  const stopVoiceSession = useCallback(() => {
    voiceSessionIdRef.current++;
    clearVoiceTimers();
    try {
      voiceRef.current?.stop();
    } catch {
      /* ignore */
    }
    voiceRef.current = null;
    setListening(false);
  }, [setListening]);

  /** End the conversation: stop listening, stop talking. */
  const endConversation = useCallback(
    (note?: string) => {
      conversingRef.current = false;
      stopVoiceSession();
      voicePlaybackRef.current?.stop();
      voicePlaybackRef.current = null;
      accumulatedVoiceTextRef.current = "";
      setVoicePhase("idle");
      if (note) notify(note);
    },
    [stopVoiceSession, notify],
  );

  // The conversation's steps call each other (listen → take the turn → answer
  // → listen); refs keep each one current without a dependency cycle.
  const listenRef = useRef<() => void>(() => {});
  const takeTurnRef = useRef<() => void>(() => {});

  /** The person finished speaking: send it, answer out loud, listen again. */
  const commitVoiceTurn = useCallback(async () => {
    const text = (accumulatedVoiceTextRef.current || message).trim();
    stopVoiceSession();
    accumulatedVoiceTextRef.current = "";
    if (!text) {
      if (conversingRef.current) listenRef.current();
      return;
    }
    setMessage("");
    if (conversingRef.current && isEndOfConversation(text)) {
      endConversation();
      void speakAnswer("Okay. I'm here when you need me.");
      return;
    }
    voiceInitiatedRef.current = true;
    if (conversingRef.current) setVoicePhase("thinking");
    let say: string | null;
    if (pillMode === "ask") {
      say = await ask(text);
    } else {
      const imgPrompt = parseExplicitImageIntent(text);
      say = imgPrompt
        ? await generateImageShape(imgPrompt)
        : spokenReply(await send(text, undefined, { surface: "voice" }));
    }
    if (!conversingRef.current) return;
    if (say) {
      setVoicePhase("speaking");
      const spoken = await speakAnswer(say);
      if (spoken.reason && spoken.reason !== "nothing to speak") notify(`Voice: ${spoken.reason}`);
      voicePlaybackRef.current = spoken.playback;
      await spoken.playback?.done.catch(() => {});
      voicePlaybackRef.current = null;
    }
    if (conversingRef.current) listenRef.current();
  }, [stopVoiceSession, endConversation, message, pillMode, ask, generateImageShape, send, notify]);
  takeTurnRef.current = () => void commitVoiceTurn();

  /** Listen for the person's next turn. */
  const startListening = useCallback(() => {
    const sessionId = ++voiceSessionIdRef.current;
    accumulatedVoiceTextRef.current = "";
    clearVoiceTimers();
    const provider = getSttProvider(settings.sttProvider);
    // Hosted providers need their connection details before start(); settings is
    // the only place they live, and the browser never sees a LiveKit secret.
    provider.configure?.({
      url: settings.livekitUrl,
      tokenUrl: settings.livekitTokenUrl,
      room: settings.livekitRoom,
    });
    const current = () => voiceSessionIdRef.current === sessionId;
    // The turn ends after a pause; a long silence ends the conversation.
    const endTurnIn = (ms: number) => {
      if (voiceSilenceTimerRef.current) clearTimeout(voiceSilenceTimerRef.current);
      voiceSilenceTimerRef.current = setTimeout(() => {
        if (current() && !isTtsSpeaking()) takeTurnRef.current();
      }, ms);
    };
    const heard = () => {
      if (voiceIdleTimerRef.current) clearTimeout(voiceIdleTimerRef.current);
      voiceIdleTimerRef.current = setTimeout(() => {
        if (current() && !accumulatedVoiceTextRef.current.trim()) {
          endConversation("Voice conversation ended — tap the mic to talk again.");
        }
      }, IDLE_END_MS);
    };
    heard();
    setVoicePhase("listening");
    const session = provider.start({
      onStart: () => {
        if (!current()) return;
        setListening(true);
      },
      onInterim: (t) => {
        if (!current() || isTtsSpeaking()) return;
        heard();
        const said = accumulatedVoiceTextRef.current;
        setMessage(said ? `${said} ${t}` : t);
        // Words still coming: wait for them, but not forever.
        endTurnIn(INTERIM_GRACE_MS);
      },
      onStatus: (s) => {
        if (!current()) return;
        if (s === "transcribing") notify("Transcribing on device…");
        if (s === "connecting") notify("Connecting to LiveKit…");
      },
      onFinal: (t) => {
        if (!current() || isTtsSpeaking()) return;
        heard();
        const cleaned = t.trim();
        if (cleaned) {
          accumulatedVoiceTextRef.current = (
            accumulatedVoiceTextRef.current
              ? `${accumulatedVoiceTextRef.current} ${cleaned}`
              : cleaned
          ).trim();
          setMessage(accumulatedVoiceTextRef.current);
        }
        endTurnIn(END_OF_TURN_MS);
      },
      onError: (msg) => {
        if (!current()) return;
        // The provider reports only what won't fix itself (a blocked mic).
        endConversation(msg || undefined);
      },
    });
    if (session) voiceRef.current = session;
    else endConversation();
  }, [
    endConversation,
    notify,
    settings.sttProvider,
    settings.livekitUrl,
    settings.livekitTokenUrl,
    settings.livekitRoom,
    setListening,
  ]);
  listenRef.current = startListening;

  /**
   * The mic button. Off: start a conversation. While listening with words
   * heard: take them now. Otherwise (listening in silence, thinking,
   * speaking): end the conversation.
   */
  const toggleVoice = useCallback(() => {
    if (conversingRef.current) {
      if (listening && (accumulatedVoiceTextRef.current || message).trim()) {
        void commitVoiceTurn();
        return;
      }
      endConversation();
      return;
    }
    if (!voiceSupported) {
      notify(
        "Voice input isn't supported in this browser — try Chrome or Edge, or type your idea.",
      );
      return;
    }
    conversingRef.current = true;
    startListening();
  }, [
    listening,
    message,
    commitVoiceTurn,
    endConversation,
    startListening,
    voiceSupported,
    notify,
  ]);

  // Leaving the canvas ends the conversation (and stops Lucent mid-sentence).
  useEffect(
    () => () => {
      conversingRef.current = false;
      voicePlaybackRef.current?.stop();
      clearVoiceTimers();
      try {
        voiceRef.current?.stop();
      } catch {
        /* ignore */
      }
    },
    [],
  );

  // LiveKit Duplex Voice Agent State
  const [voiceAgentState, setVoiceAgentState] = useState<VoiceAgentState>("idle");
  const [voiceAgentMuted, setVoiceAgentMuted] = useState(false);
  const [voiceAgentLines, setVoiceAgentLines] = useState<TranscriptLine[]>([]);
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
      const shareResult = await startSharingDetailed();
      if (!shareResult.ok) {
        notify(`Voice session requires a board: ${shareResult.error}`);
        return;
      }
      activeBoardId = shareResult.boardId;
    }

    if (!activeBoardId) {
      return;
    }

    try {
      setVoiceAgentLines([]);
      notify("Connecting to LiveKit Voice Agent…");
      const ctrl = await startVoiceAgentSession({
        boardId: activeBoardId,
        onStateChange: (st) => {
          setVoiceAgentState(st);
        },
        onTranscript: (t) => {
          setVoiceAgentLines((prev) => withTranscriptSegment(prev, t));
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
  }, [boardId, voiceAgentState, notify, startSharingDetailed]);

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

  // Embed flow: given a URL (from the board-anchored popover), resolve it and
  // drop an embed shape. The URL arrives as an argument now — the native
  // window.prompt that used to collect it rendered detached from the board.
  const addEmbed = useCallback(
    (raw: string) => {
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
            z: nextZ(shapes),
          },
        ],
        "Add embed",
      );
    },
    [applyManual, notify, shapes],
  );

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
        ops.push(cloneShapeOp(s, nid, offset, baseZ + i));
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
      // Grabbing a node ends the sketch reveal at once, so a drag never fights
      // a node or connector that the choreography still has hidden.
      cancelSketch();
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
    [applyManual, workspace.nodes, selectedNodes, cancelSketch],
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
  /**
   * The Connect tool: the first click picks one end, the second binds the
   * connector. Either end may be a shape or a diagram node (docs/26 §6.4) —
   * a sticky pointing at the step it's about.
   */
  const bindLink = useCallback(
    (id: string) => {
      if (!linkSource) {
        setLinkSource(id);
        return;
      }
      if (linkSource === id) return;
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
        "Connect",
      );
      setLinkSource(null);
      setTool("select");
    },
    [linkSource, applyManual],
  );
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
    (move: ZMove) => {
      const ops = zOrderOps(workspace.shapes, selectedShapes, move);
      if (ops.length === 0) return;
      applyManual(ops, Z_MOVE_LABEL[move]);
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

  const traceShape = useCallback(
    async (image: import("@lucent/core").Shape, preset: "logo" | "illustration") => {
      const url = image.src ? (assetUrl(image.src) ?? image.src) : null;
      if (!url) return;
      notify("Tracing on this device…");
      const r = await traceImage(url, preset);
      if (!r.ok) {
        notify(r.error);
        return;
      }
      if (applyManual(replaceWithVectorOps(image, r.vector), "Trace to vector")) {
        notify(`Traced into an editable vector (${r.vector.paths.length} parts).`);
      }
    },
    [applyManual, notify],
  );

  const sketchSelectionToVector = useCallback(
    (strokes: import("@lucent/core").Shape[]) => {
      const ops = sketchToVectorOps(strokes, nextZ(Object.values(workspace.shapes)));
      if (!ops) {
        notify("Those strokes couldn't be turned into a vector.");
        return;
      }
      const created = ops.find((o) => o.op === "CREATE_SHAPE");
      if (applyManual(ops, "Smooth into vector") && created && "id" in created) {
        setSelectedShapes(new Set([created.id]));
      }
    },
    [applyManual, notify, workspace.shapes],
  );

  const buildMenuItems = useCallback((): MenuItem[] => {
    // The diagram-family rows (familyMenu.ts, generated from the registry):
    // the region's kind picker or "Make … a region" for the group the menu is
    // about, then "Convert board to…" — the manual counterparts of the AI's
    // SET_GROUP_KIND and TRANSFORM_DIAGRAM. A menu opened on the board names
    // its group at open time; a shape's menu falls back to the selection's.
    const family: MenuItem[] = canEdit
      ? familyMenuItems({
          workspace,
          groupId: menu?.canvas ? menu.regionId : (menu?.regionId ?? regionForSelection()),
          blank: boardIsBlank(workspace),
          onConvert: convertBoard,
          onRegionKind: setRegionKind,
        })
      : [];
    if (menu?.canvas) return family;
    const ids = [...selectedShapes].filter((id) => workspace.shapes[id]);
    const canGroup = ids.length >= 2;
    const canUngroup = ids.some((id) => workspace.shapes[id]?.groupId);
    const anyLocked = ids.some((id) => workspace.shapes[id]?.locked);
    const src = ids
      .map((id) => workspace.shapes[id])
      .filter(Boolean) as import("@lucent/core").Shape[];
    const onlyFrame =
      ids.length === 1 && workspace.shapes[ids[0]!]?.kind === "frame" ? ids[0]! : null;
    // Vector Studio (docs/26 §6.3): an image traces into an editable vector
    // (locally, in a worker); pen strokes smooth into one.
    const onlyImage =
      ids.length === 1 && workspace.shapes[ids[0]!]?.kind === "image"
        ? workspace.shapes[ids[0]!]!
        : null;
    const sketches = src.filter((s) => s.kind === "draw" && s.path);
    const vectorItems: MenuItem[] = [
      ...(onlyImage && canEdit
        ? [
            {
              label: "Trace to vector — flat art",
              onClick: () => void traceShape(onlyImage, "logo"),
            },
            {
              label: "Trace to vector — detailed",
              onClick: () => void traceShape(onlyImage, "illustration"),
            },
          ]
        : []),
      ...(sketches.length > 0 && canEdit
        ? [
            {
              label:
                sketches.length > 1
                  ? "Smooth strokes into a vector"
                  : "Smooth stroke into a vector",
              onClick: () => sketchSelectionToVector(sketches),
            },
          ]
        : []),
    ];
    const items: MenuItem[] = [
      ...(vectorItems.length ? [...vectorItems, { label: "", onClick: () => {}, sep: true }] : []),
      ...(onlyFrame
        ? [
            {
              label: "Zoom to frame",
              onClick: () => sendCanvasCommand({ kind: "frame", id: onlyFrame }),
            },
            { label: "", onClick: () => {}, sep: true },
          ]
        : []),
      { label: "Duplicate", onClick: () => pasteShapes(src, 24), disabled: ids.length === 0 },
      {
        label: "Bring to front",
        onClick: () => orderSelection("front"),
        disabled: ids.length === 0,
      },
      {
        label: "Bring forward",
        onClick: () => orderSelection("forward"),
        disabled: ids.length === 0,
      },
      {
        label: "Send backward",
        onClick: () => orderSelection("backward"),
        disabled: ids.length === 0,
      },
      { label: "Send to back", onClick: () => orderSelection("back"), disabled: ids.length === 0 },
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
    // The lens follows the kind on its own (workspace.tsx lensForKindChange),
    // so converting to a sequence or ER board needs no lens switch here.
    return family.length > 0
      ? [...family, { label: "", onClick: () => {}, sep: true }, ...items]
      : items;
  }, [
    canEdit,
    traceShape,
    sketchSelectionToVector,
    selectedShapes,
    workspace,
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
    convertBoard,
  ]);

  /**
   * Right-click on the board itself — the empty canvas, a node, a region's
   * box or label — opens the family menu (shapes open their own, and stop the
   * event before it gets here). The DOM says WHAT was clicked (a `.node`, a
   * `.group-region`, neither) but carries no ids, so the laid-out scene says
   * WHICH (familyMenu.ts canvasTargetAt). A keyboard-opened menu (Shift+F10 /
   * the Menu key on a focused card) reports no pointer position; the focused
   * element's centre stands in for it. Text fields keep the browser's menu.
   */
  const onCanvasContextMenu = useCallback(
    (e: React.MouseEvent) => {
      if (e.defaultPrevented || !canEdit) return;
      const el = e.target instanceof Element ? e.target : null;
      if (!el || el.closest("input, textarea, [contenteditable='true']")) return;
      const viewportEl = el.closest(".canvas-viewport");
      if (!viewportEl) return;
      const hit = el.closest(".node, .group-region");
      const hint: CanvasHitHint = !hit
        ? "background"
        : hit.classList.contains("node")
          ? "node"
          : "region";
      // A pointer right-click lands inside its own target; one that doesn't
      // came from the keyboard, so the focused element anchors it. (Tested on
      // the target itself, not the card or region box: a region's label pill
      // pokes above its box, and a click there is still a pointer click.)
      let client = { x: e.clientX, y: e.clientY };
      const r = el.getBoundingClientRect();
      if (client.x < r.left || client.x > r.right || client.y < r.top || client.y > r.bottom) {
        client = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      }
      const camera = controls.current?.getCamera();
      let groupId: string | undefined;
      if (camera && hint !== "background") {
        const point = clientToContent(client, viewportEl.getBoundingClientRect(), camera);
        const target = canvasTargetAt(diagramScene(workspace), point, hint);
        groupId =
          target.kind === "node"
            ? workspace.nodes[target.id]?.groupId
            : target.kind === "region"
              ? target.id
              : undefined;
      }
      e.preventDefault();
      setMenu({ x: client.x, y: client.y, regionId: groupId, canvas: true });
    },
    [canEdit, workspace],
  );

  /**
   * A touch on the empty board clears the selection, the way Figma and Miro do.
   * Nodes and shapes stop their own pointerdown (atoms NodeCard, ShapeElement),
   * so this bubble-phase handler only ever sees true background — or a region,
   * edge label or control, which the `closest` check also leaves alone. That
   * stop is why selecting a node or a sticky note no longer clears it on the
   * same gesture, and why moving one keeps it selected. We never preventDefault
   * or stop the event, so a marquee or pan still begins normally. Select tool
   * only: the draw / comment / eraser tools own their background taps.
   */
  const onCanvasBackgroundPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (e.defaultPrevented || tool !== "select") return;
      const el = e.target instanceof Element ? e.target : null;
      if (!el || !el.closest(".canvas-viewport")) return;
      if (
        el.closest(
          ".node, .shape, .group-region, .edge-label, button, input, textarea, select, [role='dialog'], [role='menu'], [contenteditable='true']",
        )
      )
        return;
      if (!selected && !selectedLink && selectedNodes.size === 0 && selectedShapes.size === 0)
        return;
      setSelected(null);
      setSelectedLink(null);
      setSelectedNodes(new Set());
      setSelectedShapes(new Set());
    },
    [tool, selected, selectedLink, selectedNodes, selectedShapes],
  );

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
        bindLink(id);
        return;
      }
      setSelectedLink(null);
      selectShape(id, additive);
    },
    [voting, tool, bindLink, applyManual, selectShape, workspace],
  );

  /** Node click: vote during a round, otherwise select (shift = add to selection). */
  // Camera history (docs/26 §6.4): every jump the user asks for — fit, fit
  // selection, go to a frame, follow a citation to a node — remembers where
  // the camera was, and Back returns there exactly. Manual pans and zooms are
  // not jumps and aren't recorded. Twenty steps is plenty.
  const camBack = useRef<Camera[]>([]);
  const camFwd = useRef<Camera[]>([]);
  const [camDepth, setCamDepth] = useState({ back: 0, fwd: 0 });
  const syncCamDepth = () =>
    setCamDepth({ back: camBack.current.length, fwd: camFwd.current.length });
  const rememberCamera = useCallback(() => {
    const cam = controls.current?.getCamera();
    if (!cam) return;
    camBack.current = [...camBack.current.slice(-19), cam];
    camFwd.current = [];
    syncCamDepth();
  }, []);
  const cameraBack = useCallback(() => {
    const prev = camBack.current.pop();
    const now = controls.current?.getCamera();
    if (!prev || !now) return;
    camFwd.current.push(now);
    controls.current?.setCamera(prev);
    syncCamDepth();
  }, []);
  const cameraForward = useCallback(() => {
    const next = camFwd.current.pop();
    const now = controls.current?.getCamera();
    if (!next || !now) return;
    camBack.current.push(now);
    controls.current?.setCamera(next);
    syncCamDepth();
  }, []);

  // Select a node and bring it into view — the inspector's links (a
  // connection, the decision behind an action) move the camera with them.
  const revealNode = useCallback(
    (id: string) => {
      selectNode(id, false);
      const n = workspace.nodes[id];
      if (n?.position) {
        rememberCamera();
        controls.current?.focusOn(
          n.position.x + (n.size?.width ?? 160) / 2,
          n.position.y + (n.size?.height ?? 64) / 2,
        );
      }
    },
    [selectNode, workspace.nodes, rememberCamera],
  );

  // The ✦ trust loop: jump to the meeting that created a node. The meeting id
  // rides in the URL (?meeting=<id>) — MeetingView reads it on mount and
  // selects that transcript — and the turn range (Stage C3) lands the jump on
  // the exact turns, the same contract an Ask meeting citation follows.
  const openMeetingAt = useCallback(
    (meetingId: string | null, turnRange?: [number, number]) => {
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
    },
    [setView],
  );

  const onNodeSelect = useCallback(
    (id: string, additive = false) => {
      if (voting) {
        applyManual(toggleVoteOps(workspace, id), "Vote");
        return;
      }
      if (tool === "arrow") {
        bindLink(id);
        return;
      }
      selectNode(id, additive);
    },
    [voting, applyManual, workspace, selectNode, tool, bindLink],
  );

  const addDrawing = useCallback(
    (op: import("@lucent/core").Operation) => {
      // A stroke goes on top of what it's drawn over — a highlight used to
      // land under the note it marked.
      const placed =
        op.op === "CREATE_SHAPE" ? { ...op, z: nextZ(Object.values(workspace.shapes)) } : op;
      applyManual([placed], "Draw");
    },
    [applyManual, workspace.shapes],
  );

  // The system clipboard (docs/26 §6.4). Copy and cut write a Lucent
  // payload plus plain text; paste takes a Lucent payload, then an image, an
  // SVG, a link or text — so selections move between boards and tabs, and
  // anything copied from another app lands as the object it is. Text fields
  // and a real text selection keep the browser's own behaviour.
  useEffect(() => {
    const inField = (t: EventTarget | null) => {
      const el = t as HTMLElement | null;
      return Boolean(
        el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable),
      );
    };
    const selectingText = () => {
      const s = window.getSelection();
      return Boolean(s && !s.isCollapsed && s.toString().trim());
    };
    const pasteAt = () =>
      viewportBox
        ? { x: viewportBox.x + viewportBox.width / 2, y: viewportBox.y + viewportBox.height / 2 }
        : { x: 400, y: 300 };
    const topZ = () => nextZ(Object.values(workspace.shapes));

    const copy = (e: ClipboardEvent, cut: boolean) => {
      if (inField(e.target) || selectingText() || !e.clipboardData) return;
      const payload = clipFromSelection(workspace, selectedShapes, selectedNodes);
      if (!payload) return;
      e.preventDefault();
      e.clipboardData.setData(LUCENT_CLIP_MIME, JSON.stringify(payload));
      e.clipboardData.setData("text/plain", clipText(payload));
      if (!cut || readOnly) return;
      const ops: import("@lucent/core").Operation[] = [
        ...payload.shapes
          .filter((s) => !s.locked)
          .map((s) => ({ op: "DELETE_SHAPE" as const, id: s.id })),
        ...payload.nodes.map((n) => ({ op: "DELETE_NODE" as const, id: n.id })),
      ];
      if (
        ops.length > 0 &&
        applyManual(ops, `Cut ${ops.length} object${ops.length > 1 ? "s" : ""}`)
      ) {
        setSelectedShapes(new Set());
        setSelectedNodes(new Set());
      }
    };
    const onCopy = (e: ClipboardEvent) => copy(e, false);
    const onCut = (e: ClipboardEvent) => copy(e, true);

    const onPaste = (e: ClipboardEvent) => {
      if (readOnly || inField(e.target) || !e.clipboardData) return;
      const dt = e.clipboardData;
      const at = pasteAt();

      const payload = parseClip(dt.getData(LUCENT_CLIP_MIME));
      if (payload) {
        e.preventDefault();
        const plan = planPaste(workspace, payload, at);
        if (!plan) {
          notify("That clipboard content couldn't be pasted — it isn't a valid Lucent selection.");
          return;
        }
        const count = plan.shapeIds.length + plan.nodeIds.length;
        if (applyManual(plan.ops, `Paste ${count} object${count > 1 ? "s" : ""}`)) {
          setSelectedShapes(new Set(plan.shapeIds));
          setSelectedNodes(new Set(plan.nodeIds));
          setSelected(plan.nodeIds.length === 1 ? plan.nodeIds[0]! : null);
        }
        return;
      }

      // An SVG as markup (from a design tool or a code editor) becomes an
      // editable vector (docs/26 §6.3); one too complex to edit still lands,
      // as an image, with the reason said.
      const svgText = dt.getData("image/svg+xml") || dt.getData("text/plain");
      const svg = svgTextToDataUrl(svgText);
      if (svg) {
        e.preventDefault();
        const asVector = svgToVectorOp(svgText, at, topZ());
        if (asVector.ok) {
          if (applyManual([asVector.op], "Paste SVG")) {
            setSelectedShapes(new Set([asVector.op.id]));
            if (asVector.dropped.length)
              notify(
                `Pasted as a vector. Skipped what can't be edited: ${asVector.dropped.join(", ")}.`,
              );
          }
          return;
        }
        notify(`${asVector.error} Pasted it as an image instead.`);
        const size = svgSize(svgText);
        applyManual(
          [
            {
              op: "CREATE_SHAPE",
              id: shapeId(),
              kind: "image",
              position: {
                x: Math.round(at.x - size.width / 2),
                y: Math.round(at.y - size.height / 2),
              },
              size,
              src: svg,
              z: topZ(),
            },
          ],
          "Paste SVG",
        );
        return;
      }

      const file = [...dt.items]
        .find((i) => i.kind === "file" && i.type.startsWith("image/"))
        ?.getAsFile();
      if (file) {
        e.preventDefault();
        // Downscaled (M0.5), then uploaded on a shared board so the op log
        // carries a reference, not megabytes (assets.ts).
        void placeImage(file, boardId).then((img) => {
          if (!img) {
            notify("That image could not be read.");
            return;
          }
          const k = Math.min(1, 320 / img.width);
          const size = { width: Math.round(img.width * k), height: Math.round(img.height * k) };
          applyManual(
            [
              {
                op: "CREATE_SHAPE",
                id: shapeId(),
                kind: "image",
                position: {
                  x: Math.round(at.x - size.width / 2),
                  y: Math.round(at.y - size.height / 2),
                },
                size,
                src: img.src,
                z: topZ(),
              },
            ],
            "Paste image",
          );
        });
        return;
      }

      // Mermaid text is a diagram, not a sticky (docs/27 D2): it lands as
      // semantic nodes — the whole board when empty, a region otherwise.
      const plain = dt.getData("text/plain");
      if (detectMermaid(plain)) {
        const plan = planMermaidImport(workspace, plain);
        if (plan.ok) {
          e.preventDefault();
          if (applyManual(plan.ops, "Import Mermaid")) {
            setSelectedShapes(new Set());
            setSelectedNodes(new Set(plan.nodeIds));
            notify(plan.message);
          }
          return;
        }
      }

      // A spreadsheet copy or CSV snippet is a table (docs/26 §6.1), not a
      // note full of tabs and commas. Only text that IS a grid qualifies — a
      // pasted sentence with a comma still becomes a note (sniffDelimited).
      const pastedTable = pastedTableOp(plain, at, topZ());
      if (pastedTable) {
        e.preventDefault();
        if (applyManual([pastedTable.op], "Paste table")) {
          setSelectedShapes(new Set([pastedTable.op.id]));
          if (pastedTable.truncated) notify(`Pasted as a table — ${TABLE_TRIM_NOTE}.`);
        }
        return;
      }

      const op = textPasteOp(plain, at, topZ());
      if (op) {
        e.preventDefault();
        if (applyManual([op], op.kind === "embed" ? "Paste link" : "Paste text")) {
          setSelectedShapes(new Set([op.id]));
        }
      }
    };

    document.addEventListener("copy", onCopy);
    document.addEventListener("cut", onCut);
    document.addEventListener("paste", onPaste);
    return () => {
      document.removeEventListener("copy", onCopy);
      document.removeEventListener("cut", onCut);
      document.removeEventListener("paste", onPaste);
    };
  }, [
    workspace,
    selectedShapes,
    selectedNodes,
    readOnly,
    viewportBox,
    applyManual,
    notify,
    boardId,
  ]);

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
    // ADR 0048: an answer's evidence, shown together — several ids select
    // them all and frame them; one id selects and centres it, as before.
    const ids = reveal.split(",").filter((id) => workspace.nodes[id]);
    if (ids.length > 1) {
      setSelectedShapes(new Set());
      setSelectedNodes(new Set(ids));
      setSelected(null);
      const boxes = ids.map((id) => {
        const n = workspace.nodes[id]!;
        return {
          x: n.position?.x ?? 0,
          y: n.position?.y ?? 0,
          width: n.size?.width ?? 160,
          height: n.size?.height ?? 64,
        };
      });
      const minX = Math.min(...boxes.map((b) => b.x));
      const minY = Math.min(...boxes.map((b) => b.y));
      const maxX = Math.max(...boxes.map((b) => b.x + b.width));
      const maxY = Math.max(...boxes.map((b) => b.y + b.height));
      controls.current?.fitBounds({ x: minX, y: minY, width: maxX - minX, height: maxY - minY });
      return;
    }
    const node = ids[0] ? workspace.nodes[ids[0]] : undefined;
    if (node) {
      selectNode(node.id, false);
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
          // Same path as paste: downscaled, and uploaded on a shared board.
          void placeImage(file, boardId).then((scaled) => {
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
                  src: scaled.src,
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
            if (kind === "svg") {
              // One editable vector where it was dropped (docs/26 §6.3).
              const r = svgToVectorOp(content, { x: dropX + 120, y: dropY + 90 }, nextZ(existing));
              if (!r.ok) {
                notify(`${file.name}: ${r.error}`);
                return;
              }
              if (applyManual([r.op], `Import ${file.name}`)) {
                setSelectedShapes(new Set([r.op.id]));
                notify(
                  r.dropped.length
                    ? `Imported ${file.name} as a vector. Skipped: ${r.dropped.join(", ")}.`
                    : `Imported ${file.name} as an editable vector.`,
                );
              }
              return;
            }
            if (kind === "csv") {
              // One table shape where it was dropped (docs/26 §6.1) — it used to
              // scatter one sticky per cell. A .tsv is split on tabs; a .csv
              // on whichever of tab/comma its header line uses.
              const tsv = file.name.toLowerCase().endsWith(".tsv");
              const r = delimitedToTableOp(
                content,
                { x: dropX, y: dropY },
                nextZ(existing),
                tsv ? "\t" : undefined,
              );
              if (!r) {
                notify(`Nothing importable found in ${file.name}.`);
                return;
              }
              if (applyManual([r.op], `Import ${file.name}`)) {
                setSelectedShapes(new Set([r.op.id]));
                notify(
                  r.truncated
                    ? `Imported ${file.name} as a table — ${TABLE_TRIM_NOTE}.`
                    : `Imported ${file.name} as a table.`,
                );
              }
              return;
            }
            const ops =
              kind === "pdf" ? pdfToOps(content, existing) : documentToOps(content, existing);
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
  }, [applyManual, workspace.shapes, notify, boardId]);

  const resizeShape = useCallback(
    (
      id: string,
      width: number,
      height: number,
      commit: boolean,
      position?: { x: number; y: number },
    ) => {
      if (commit)
        applyManual(
          [{ op: "UPDATE_SHAPE", id, size: { width, height }, ...(position ? { position } : {}) }],
          "Resize shape",
        );
    },
    [applyManual],
  );

  // Icons & vectors (docs/26 §6.3): a registry icon placed as an editable
  // vector at the centre of the view. Brand marks keep their colour; outline
  // icons take the shape's ink.
  const [vectorsOpen, setVectorsOpen] = useState(false);
  // The image-gen / embed toolbar buttons open this board-anchored input popover
  // instead of a native window.prompt (which the browser pins to the top of the
  // screen, detached from the board — the "different panel" the user hit).
  const [boardPrompt, setBoardPrompt] = useState<null | { kind: "image" | "embed" }>(null);
  const [vectorsPrompt, setVectorsPrompt] = useState<string | undefined>(undefined);
  // "More like this" from the inspector opens Generate with the vector's prompt.
  useEffect(() => {
    const onOpen = (e: Event) => {
      setVectorsPrompt((e as CustomEvent<{ prompt?: string }>).detail?.prompt);
      setVectorsOpen(true);
    };
    window.addEventListener(VECTORS_OPEN_EVENT, onOpen);
    return () => window.removeEventListener(VECTORS_OPEN_EVENT, onOpen);
  }, []);
  /** A generated variation, placed at the centre of the view, fitted to 200px. */
  const placeGeneratedVector = useCallback(
    (vector: import("@lucent/core").VectorData, width: number, height: number) => {
      const at = viewportBox
        ? { x: viewportBox.x + viewportBox.width / 2, y: viewportBox.y + viewportBox.height / 2 }
        : { x: 400, y: 300 };
      const op = vectorShapeOp(
        vector,
        at,
        fitSize(width, height, 200),
        nextZ(Object.values(workspace.shapes)),
      );
      if (applyManual([op], "Place generated vector")) setSelectedShapes(new Set([op.id]));
    },
    [applyManual, viewportBox, workspace.shapes],
  );
  const insertIconVector = useCallback(
    async (ref: string) => {
      const glyph = await loadIcon(ref);
      const vector = glyph ? vectorFromGlyph(glyph) : null;
      if (!vector) {
        notify("That icon couldn't be placed.");
        return;
      }
      const at = viewportBox
        ? { x: viewportBox.x + viewportBox.width / 2, y: viewportBox.y + viewportBox.height / 2 }
        : { x: 400, y: 300 };
      const op = vectorShapeOp(
        vector,
        at,
        { width: 72, height: 72 },
        nextZ(Object.values(workspace.shapes)),
      );
      if (applyManual([op], "Insert icon")) {
        setSelectedShapes(new Set([op.id]));
        setVectorsOpen(false);
      }
    },
    [applyManual, notify, viewportBox, workspace.shapes],
  );

  const rotateShape = useCallback(
    (id: string, rotation: number, commit: boolean) => {
      if (commit) applyManual([{ op: "UPDATE_SHAPE", id, rotation }], "Rotate shape");
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
  const objectCount = nodeCount + shapes.length;
  const prevCountRef = useRef(-1);
  // A fit that is owed survives the effect being torn down before its timer
  // fires. React's dev StrictMode mounts effects twice (mount → cleanup →
  // mount): the first pass recorded the count and scheduled the fit, the
  // cleanup cancelled it, and the second pass saw no change — so a reloaded
  // board opened unframed, half under the toolbar.
  const fitOwedRef = useRef(false);
  useEffect(() => {
    const had = prevCountRef.current;
    prevCountRef.current = objectCount;
    // -1 is the mount pass: fit whatever was restored. 0 -> N is the first
    // generation on an empty board. A jump of 3+ objects is an AI batch landing
    // on a board that already had content — without a refit those nodes can lay
    // outside the viewport and the user reads "nothing generated" though the ops
    // applied. A single manual add is +1, so it never refits and steals the
    // user's place.
    const batchAdded = had > 0 && objectCount - had >= 3;
    if (((had === -1 || had === 0) && objectCount > 0) || batchAdded) fitOwedRef.current = true;
    if (!fitOwedRef.current) return;
    const t = setTimeout(() => {
      // A camera command (the palette's "Go to frame", a citation) can cancel
      // the owed fit: the jump the user asked for outranks the automatic one.
      if (!fitOwedRef.current) return;
      fitOwedRef.current = false;
      fitRef.current();
    }, 260);
    return () => clearTimeout(t);
  }, [objectCount]);

  /** Frame a frame: its box fills the view, and it becomes the selection. */
  const zoomToFrame = useCallback(
    (id: string) => {
      const s = workspace.shapes[id];
      if (!s) return;
      rememberCamera();
      setSelectedShapes(new Set([id]));
      setSelectedNodes(new Set());
      setSelected(null);
      controls.current?.fitBounds({
        x: s.position.x,
        y: s.position.y,
        width: s.size.width,
        height: s.size.height,
      });
    },
    [workspace.shapes, rememberCamera],
  );

  // Commands from the palette (canvasCommands.ts). Declared after the owed-fit
  // effect so a command that arrived before mount cancels that fit.
  const commandRef = useRef<(cmd: CanvasCommand) => void>(() => {});
  commandRef.current = (cmd) => {
    fitOwedRef.current = false;
    switch (cmd.kind) {
      case "fit":
        rememberCamera();
        fitToContent();
        break;
      case "fitSelection":
        rememberCamera();
        fitToSelection();
        break;
      case "frame":
        zoomToFrame(cmd.id);
        break;
      case "back":
        cameraBack();
        break;
      case "forward":
        cameraForward();
        break;
      case "align":
      case "distribute": {
        const picked = [...selectedShapes]
          .map((id) => workspace.shapes[id])
          .filter((s): s is Shape => Boolean(s));
        const need = cmd.kind === "align" ? 2 : 3;
        if (picked.length < need) {
          notify(
            cmd.kind === "align"
              ? "Select two or more shapes to align."
              : "Select three or more shapes to distribute.",
          );
          break;
        }
        const pos =
          cmd.kind === "align"
            ? alignPositions(picked, cmd.mode)
            : distributePositions(picked, cmd.axis);
        const ops = Object.entries(pos).map(([id, p]) => ({
          op: "UPDATE_SHAPE" as const,
          id,
          position: p,
        }));
        if (ops.length)
          applyManual(ops, cmd.kind === "align" ? "Align shapes" : "Distribute shapes");
        break;
      }
      case "group":
        if ([...selectedShapes].filter((id) => workspace.shapes[id]).length < 2) {
          notify("Select two or more shapes to group.");
          break;
        }
        groupSelection();
        break;
      case "ungroup":
        ungroupSelection();
        break;
      case "convert":
        convertBoard(cmd.to);
        break;
    }
  };
  useEffect(() => onCanvasCommand((cmd) => commandRef.current(cmd)), []);

  // Export the current board (nodes + shapes) as a downloadable SVG snapshot.
  // Icons first: culled cards never loaded theirs, and the export is sync.
  const exportSvg = useCallback(async () => {
    await preloadExportData(workspace);
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
  const exportPng = useCallback(async () => {
    await preloadExportData(workspace);
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

  /**
   * Stickies → structure (docs/27 D2), always as a proposal. Sorting into
   * themes asks only for MEANING (themes of note indices, /api/themes) and
   * lays the frames out here; the diagram verbs go through the one generate
   * pipeline with the stickies as the selection, forced to review.
   */
  const [structuring, setStructuring] = useState(false);
  const structureStickies = useCallback(
    async (action: StructureAction) => {
      const stickies = sortableStickies(workspace, selectedShapes);
      if (stickies.length < 3) {
        notify("Select at least three sticky notes with text.");
        return;
      }
      setStructuring(true);
      try {
        if (action === "themes") {
          const answer = await sortIntoThemes(
            stickies.map((s) => s.text ?? ""),
            { boardId },
          );
          if ("error" in answer) {
            notify(answer.error);
            return;
          }
          const ops = planThemeLayout(stickies, answer, shapeId);
          const n = answer.themes.length;
          const proposed = await proposeOps(
            ops,
            `Sort ${stickies.length} sticky notes into themes`,
            `${n} theme${n === 1 ? "" : "s"}: ${answer.themes.map((t) => t.title).join(", ")} — ${sortedBy(answer)}`,
          );
          if (!proposed) notify("Those notes couldn't be sorted on this board.");
          return;
        }
        const ids = stickies.map((s) => s.id);
        const outcome = await send(STRUCTURE_PROMPTS[action], ids, { propose: true });
        if (outcome.outcome === "busy") notify("Lucent is still working on the last request.");
      } finally {
        setStructuring(false);
      }
    },
    [workspace, selectedShapes, boardId, proposeOps, send, notify],
  );

  /**
   * Import a Mermaid diagram copied from a repo or doc (docs/27 D2). Reads the
   * clipboard: the old single-line prompt dropped the newlines Mermaid needs.
   * Pasting Mermaid straight onto the canvas does the same (onPaste).
   */
  const importMermaid = useCallback(async () => {
    let text: string;
    try {
      text = await navigator.clipboard.readText();
    } catch {
      notify(
        "Clipboard access was blocked — paste the Mermaid onto the canvas with Ctrl/⌘ V instead.",
      );
      return;
    }
    const plan = planMermaidImport(workspace, text);
    if (!plan.ok) {
      notify(
        detectMermaid(text)
          ? plan.error
          : "Copy a Mermaid flowchart, stateDiagram or mindmap first — or paste it straight onto the canvas.",
      );
      return;
    }
    if (applyManual(plan.ops, "Import Mermaid")) {
      setSelectedShapes(new Set());
      setSelectedNodes(new Set(plan.nodeIds));
      notify(plan.message);
    } else {
      notify("That Mermaid diagram couldn't be added to this board.");
    }
  }, [workspace, applyManual, notify]);

  // Export to PDF by opening the board SVG in a print window (user picks
  // "Save as PDF"). No dependency; works in every browser's print dialog.
  //
  // M0.5: the previous implementation opened a fresh same-origin window and
  // called `win.document.write(...)`, which inherits *this* origin's
  // localStorage and any cookies. A `srcdoc` iframe rendered into a hidden
  // host element avoids the cross-origin script path entirely: the SVG lives in
  // a sandboxed document that the parent can't talk to, and the print dialog is
  // triggered programmatically on its `contentWindow`.
  const exportPdf = useCallback(async () => {
    await preloadExportData(workspace);
    const svg = buildBoardSvg(workspace);
    const host = document.createElement("div");
    host.style.position = "fixed";
    host.style.left = "-10000px";
    host.style.top = "0";
    host.setAttribute("aria-hidden", "true");
    const frame = document.createElement("iframe");
    // sandbox without allow-same-origin: the iframe document is opaque to us,
    // so it can't reach our localStorage, cookies, or postMessage handlers.
    // allow-modals is what lets it open the print dialog: without it Chrome
    // ignores print() in a sandboxed document, and the export did nothing.
    frame.setAttribute("sandbox", "allow-scripts allow-modals");
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

  // Slides as PDF (docs/26 §6.1): the same sandboxed print route, one page per
  // frame at the frame's own size, in slide order.
  const exportSlidesPdf = useCallback(async () => {
    if (slides.length === 0) {
      notify("Add frames to the board — each frame is a slide.");
      return;
    }
    await preloadExportData(workspace);
    const host = document.createElement("div");
    host.style.position = "fixed";
    host.style.left = "-10000px";
    host.style.top = "0";
    host.setAttribute("aria-hidden", "true");
    const frame = document.createElement("iframe");
    frame.setAttribute("sandbox", "allow-scripts allow-modals");
    frame.setAttribute("title", "print slides");
    host.appendChild(frame);
    document.body.appendChild(host);
    frame.srcdoc = buildSlidesDocument(workspace, slides, projectName);
    frame.addEventListener("load", () => {
      try {
        frame.contentWindow?.focus();
        frame.contentWindow?.print();
      } catch {
        // No programmatic print: the browser's own print menu still works.
      }
      setTimeout(() => host.remove(), 30_000);
    });
    notify(
      `Opening print dialog — ${slides.length} slide${slides.length === 1 ? "" : "s"}, choose “Save as PDF”.`,
    );
  }, [workspace, slides, projectName, notify]);

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

  const crumbs: Crumb[] = [
    { label: "Boards", view: "dashboard" },
    // The board's real name — a previous fix pinned the fallback to a
    // placeholder ("E-commerce platform") for every named board, which is
    // the same bug class the identical-project-names fix (02afaa5) covered.
    {
      label: projectName || "Untitled board",
      current: true,
      rename: true,
    },
  ];

  // What the board KNOWS, in the top bar: its kind, then the live count of
  // the statements that matter — decided, still open, at risk. It is the
  // one-glance answer to "where does this board stand?", and a door into
  // Intelligence. (It replaced an engineering-sheet stamp — "Sheet A-01 …
  // Scale 44.2035%" — that described nothing real.)
  const boardKnows = useMemo(() => {
    let decided = 0;
    let openQuestions = 0;
    let openRisks = 0;
    for (const n of Object.values(workspace.nodes)) {
      const st = n.statement;
      if (!st) continue;
      if (st.kind === "decision" && st.status === "resolved") decided++;
      else if (st.kind === "question" && st.status === "open") openQuestions++;
      else if (st.kind === "risk" && st.status === "open") openRisks++;
    }
    return { decided, openQuestions, openRisks };
  }, [workspace.nodes]);
  const meta = (
    <button
      className="meta-stamp board-knows"
      onClick={() => setView("intelligence")}
      title="What this board knows — open Intelligence"
      aria-label={`${DIAGRAM_LABELS[workspace.diagramKind]}: ${boardKnows.decided} decided, ${boardKnows.openQuestions} open questions, ${boardKnows.openRisks} open risks. Open Intelligence.`}
    >
      <span>{DIAGRAM_LABELS[workspace.diagramKind]}</span>
      {(boardKnows.decided > 0 || boardKnows.openQuestions > 0 || boardKnows.openRisks > 0) && (
        <span className="board-knows-sep" aria-hidden />
      )}
      {boardKnows.decided > 0 && (
        <span className="board-knows-item">
          <StatementGlyph kind="decision" size={10} />
          {boardKnows.decided} decided
        </span>
      )}
      {boardKnows.openQuestions > 0 && (
        <span className="board-knows-item">
          <StatementGlyph kind="question" size={10} />
          {boardKnows.openQuestions} open
        </span>
      )}
      {boardKnows.openRisks > 0 && (
        <span className="board-knows-item">
          <StatementGlyph kind="risk" size={10} />
          {boardKnows.openRisks} {boardKnows.openRisks === 1 ? "risk" : "risks"}
        </span>
      )}
    </button>
  );

  // UX-2: named phases replace the char counter as the status model.
  // The workspace owns the phase; the char count rides along as detail.
  const PHASE_LABEL: Record<string, string> = {
    understanding: "Reading your request…",
    constructing: "Building the model…",
    validating: "Checking every change…",
    applying: "Placing it on the board…",
  };
  // A live build preview: the node labels the model has written so far, so the
  // wait shows the diagram taking shape instead of an opaque character count.
  // Falls back to the character count before any label has streamed.
  const buildingPreview =
    streamNodes.length > 0
      ? `${streamNodes.length} node${streamNodes.length === 1 ? "" : "s"}: ${streamNodes
          .slice(-3)
          .join(" · ")}`
      : streamChars > 0
        ? `${streamChars} characters received`
        : null;
  const status =
    canvasPhase === "generating"
      ? {
          text:
            (aiPhase ? PHASE_LABEL[aiPhase] : "Constructing your diagram…") +
            (buildingPreview ? ` · ${buildingPreview}` : ""),
        }
      : canvasPhase === "proposing"
        ? { text: `Proposing ${proposal?.operations.length ?? 0} changes` }
        : null;
  const genPhase = aiPhase;
  const genProgress = canvasPhase === "generating" ? buildingPreview : null;

  // P1-RF-001: a failed first generation returns to this hero, and the error
  // + retry used to live only in the collapsed conversation — invisible, the
  // request looked lost. When the hero is up and the conversation's last
  // entry is that failure, surface it here; Try again puts the prompt back
  // in the box (retrying is one deliberate send, not an auto-fire, so the
  // user can fix the request first).
  // The same goes for a model that replied in words instead of drawing (an
  // opinion, an answer, a question back): on an empty board that reply is
  // the only result there is, so the hero shows it, and the person writes
  // back in the box (the conversation carries).
  const heroFailure =
    canvasPhase === "empty" && chat.length > 0
      ? (() => {
          const last = chat[chat.length - 1]!;
          if (last.role === "ai" && last.drewNothing) {
            return { text: last.reply || last.text, kind: "reply" as const };
          }
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

  // The first-run hero replaces the whole canvas, including the draw layer. If a
  // drawing tool is armed we must show the board instead, or picking a shape on a
  // fresh board silently does nothing — the drag lands on the hero.
  const drawingArmed = tool !== "select" && tool !== "hand";
  // A generation started from the hero applies its operations only at the end,
  // so the board is empty the whole time it runs. Staying on the hero (with a
  // working status) instead of flipping to a blank board and back is what
  // stops the "it showed the board, then glitched home" jump: the hero holds
  // until there is something to show — the diagram, or a reply in words.
  const boardEmpty =
    Object.keys(workspace.nodes).length === 0 &&
    Object.keys(workspace.shapes).length === 0 &&
    Object.keys(workspace.wireframes).length === 0;
  const heroGenerating = canvasPhase === "generating" && boardEmpty;
  const showHero =
    (canvasPhase === "empty" || heroGenerating) && !drawingArmed && !blankBoardStarted;

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
    <div style={{ position: "absolute", inset: 0 }} onContextMenu={onCanvasContextMenu}>
      {boardPrompt && canEdit && (
        <BoardPromptPopover
          kind={boardPrompt.kind}
          onSubmit={(text) => {
            if (boardPrompt.kind === "image") void generateImageShape(text);
            else addEmbed(text);
          }}
          onClose={() => setBoardPrompt(null)}
        />
      )}
      {showHero ? (
        <>
          <div style={{ position: "absolute", inset: 0 }}>
            <div className="canvas-grid" />
            <div className="canvas-vignette" />
          </div>
          {/* No "what the board knows" stamp yet: an empty board knows nothing. */}
          <TopBar crumbs={crumbs} onOpenSettings={onOpenSettings} />
          {vectorsOpen && canEdit && (
            <VectorsPanel
              boardId={boardId}
              initialPrompt={vectorsPrompt}
              onPlaceIcon={(ref) => void insertIconVector(ref)}
              onPlaceVector={placeGeneratedVector}
              onClose={() => setVectorsOpen(false)}
            />
          )}
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
            onSubmitWithAttachments={submitWithAttachments}
            onStartMeeting={() => setView("meeting")}
            onSpeak={toggleVoice}
            onStartVoiceCall={toggleVoiceAgent}
            voiceAgentActive={
              voiceAgentState !== "idle" &&
              voiceAgentState !== "disconnected" &&
              voiceAgentState !== "error"
            }
            listening={listening}
            voicePhase={voicePhase}
            onGenImage={() => setBoardPrompt({ kind: "image" })}
            onBlankBoard={() => setBlankBoardStarted(true)}
            failedAttempt={heroFailure}
            generating={heroGenerating}
            genStatus={
              status?.text ?? (genProgress ? `Working… · ${genProgress}` : "Reading your request…")
            }
            onCancel={busy ? () => cancelSend() : undefined}
          />
          {/* The tour overlays the hero: it is the first-minute surface, and
              it unmounts itself once seen (or dismissed) — no flag threading
              through the workspace state for something read once per browser. */}
          <Tour />
        </>
      ) : (
        <>
          {/* docs/28 S5: moving the view yourself takes over from whoever you follow. */}
          <div
            className="canvas-follow-watch"
            onWheelCapture={() => {
              if (followModes.following) followModes.takeOver();
            }}
            onPointerDownCapture={() => {
              if (followModes.following) followModes.takeOver();
            }}
            onPointerDown={onCanvasBackgroundPointerDown}
            onPointerMove={publishCursor}
            onPointerLeave={() => setPresence({ cursor: null })}
          >
            <CanvasViewport
              initialZoom={85}
              tool={tool === "hand" ? "hand" : "select"}
              // Connect (docs/26 §6.4) binds to nodes as well as shapes, so
              // nodes stay clickable while it's armed.
              className={
                drawingArmed ? `drawing-active${tool === "arrow" ? " connecting" : ""}` : undefined
              }
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
                expandedRegions={expandedRegions}
                onToggleExpand={toggleRegionExpand}
                sketchOrder={sketchOrder}
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
                    onRotate={rotateShape}
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
                    <div
                      className="frame-label"
                      style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}
                    >
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
              {(tool === "pen" || tool === "highlighter") && canEdit && (
                <PenLayer
                  // A fresh layer per tool, so each starts with its own colours.
                  key={tool}
                  scale={zoom / 100}
                  stroke="var(--ink-0)"
                  highlighter={tool === "highlighter"}
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
              {mode !== "present" && (
                <CommentPins workspace={workspace} onOpen={setCommentTarget} />
              )}
              {engagementTarget && canEdit && !voting && !drawingArmed && (
                <EngagementAnchor
                  workspace={workspace}
                  targetId={engagementTarget}
                  onApply={applyManual}
                />
              )}
              {/* Live collaborators' cursors and selections track content space. */}
              {peers.length > 0 && <PresenceCursors peers={peers} />}
            </CanvasViewport>
          </div>

          {menu && (
            <ContextMenu
              // Keyed by where it opened: a right-click while a menu is open
              // mounts a fresh one, rather than reusing the old one mid-exit
              // (whose close timer would then dismiss the new menu).
              key={`${menu.x}:${menu.y}:${menu.canvas ? "board" : "shape"}`}
              x={menu.x}
              y={menu.y}
              onClose={() => setMenu(null)}
              items={buildMenuItems()}
            />
          )}

          {(peers.length > 0 || spotlight || followModes.summoned) && (
            <div className="presence-bar-slot">
              <FollowBar
                following={followModes.following}
                spotlight={spotlight}
                meId={meId}
                steppedOut={followModes.steppedOut}
                summonedBy={followModes.summoned?.name ?? null}
                canLead={!readOnly && peers.length > 0}
                onStop={followModes.takeOver}
                onRejoin={followModes.rejoinSpotlight}
                onSpotlight={setSpotlight}
                onSummon={() => {
                  const here = followModes.here();
                  if (!here) return;
                  summon(here);
                  notify("Everyone else is looking where you are");
                }}
                onGoBack={followModes.goBack}
              >
                <PresenceBar
                  peers={peers}
                  followingId={followModes.following?.userId ?? null}
                  onFollow={(p) =>
                    followModes.following?.userId === p.userId
                      ? followModes.takeOver()
                      : followModes.follow(p)
                  }
                />
              </FollowBar>
            </div>
          )}

          {canvasPhase === "voice" && <VoiceOverlay transcript={message} />}

          {mode === "present" && canvasPhase === "main" && (
            <PresentMode
              workspace={workspace}
              slides={slides}
              controls={controls}
              step={presentStep}
              setStep={setPresentStep}
              onExit={() => {
                setMode("edit");
                controls.current?.reset();
              }}
              frameLabel={
                slides.length > 0 ? projectName || undefined : DIAGRAM_LABELS[workspace.diagramKind]
              }
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
              <span>
                {canComment
                  ? "You can comment on this board. Ask the owner for edit access to change it."
                  : "You're viewing this board. Ask the owner for edit access to change it."}
              </span>
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
                // Below the top tool row (y 68–110).
                top: 120,
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
                top: 152,
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
              onEmbed={() => setBoardPrompt({ kind: "embed" })}
              onGenImage={() => setBoardPrompt({ kind: "image" })}
              onVectors={() => setVectorsOpen((v) => !v)}
              orientation="top"
            />
          )}
          <LeftRail onOpenSettings={onOpenSettings} />

          {/* UX-1 L1/L2/L3: one Board-tools menu (L2) replaces the four-button
              right pileup (Polish/Templates/Timer/Vote). The comment bell
              stays separate — comments are attention, not tools. */}
          {/* Top-right consolidated Activity & Utilities Bar */}
          <div className="canvas-top-right">
            {(camDepth.back > 0 || camDepth.fwd > 0) && (
              <div className="camera-nav" role="group" aria-label="Camera history">
                <button
                  className="camera-nav-btn"
                  onClick={cameraBack}
                  disabled={camDepth.back === 0}
                  title="Back to where you were"
                >
                  ↩ Back
                </button>
                {camDepth.fwd > 0 && (
                  <button className="camera-nav-btn" onClick={cameraForward} title="Forward again">
                    ↪
                  </button>
                )}
              </div>
            )}
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
            {(rightClusterVisible || (canTalk && canvasPhase !== "proposing")) && (
              <div className="canvas-utility-bar">
                {rightClusterVisible && (
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
                )}

                {rightClusterVisible && attentionItems.length > 0 && (
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
                    aria-label={
                      openThreads ? `${openThreads} open comment threads` : "All comments"
                    }
                  >
                    All
                  </button>
                </div>
              </div>
            )}
          </div>
          {inboxOpen && canTalk && (
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
          {commentTarget && canTalk && (
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

          {canvasPhase === "proposing" && <ProposalPanel />}

          {/* The node inspector (Atelier): one selected node, what it IS —
              kind, lifecycle, the words behind it, its connections as
              sentences, the decisions it came from, the statement editor.
              Replaces the floating HUD, whose "Why?" popover mislabelled
              every AI-drawn node "Created by human" and whose Undo undid
              the board's last edit rather than anything about the node. */}
          {selected &&
            selectedNodes.size <= 1 &&
            selectedShapes.size === 0 &&
            canvasPhase === "main" &&
            mode !== "present" &&
            !drawingArmed &&
            !commentTarget &&
            workspace.nodes[selected] && (
              <NodeInspector
                key={selected}
                nodeId={selected}
                workspace={workspace}
                canEdit={canEdit}
                onApply={applyManual}
                onSelectNode={revealNode}
                onOpenMeeting={openMeetingAt}
                onExplain={(label) => void send(`Explain the "${label}" node and its role.`)}
                onExpand={(label) => void send(`Expand the "${label}" node into its sub-steps.`)}
                {...(canTalk ? { onComment: () => setCommentTarget(selected) } : {})}
                onClose={() => setSelected(null)}
              />
            )}

          {canEdit && canvasPhase !== "proposing" && selectedShapes.size > 0 && (
            <ShapeInspector
              shapes={workspace.shapes}
              selectedIds={selectedShapes}
              onApply={applyManual}
              onSelect={setSelectedShapes}
              onStructure={(a) => void structureStickies(a)}
              structuring={structuring}
              boardId={boardId}
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
            lines={voiceAgentLines}
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
              voicePhase={voicePhase}
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
            onFit={() => sendCanvasCommand({ kind: "fit" })}
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
              {slides.length > 0 && (
                <button
                  onClick={exportSlidesPdf}
                  title={`One page per frame — ${slides.length} slide${slides.length === 1 ? "" : "s"}`}
                >
                  Slides PDF
                </button>
              )}
              <button onClick={exportJson}>JSON</button>
              <button onClick={exportMarkdown}>Markdown</button>
              <button onClick={exportCsv}>CSV</button>
              <button onClick={exportMermaid}>Mermaid</button>
              <div className="export-sep" />
              <button onClick={() => void copyMermaid()}>Copy Mermaid</button>
              <button onClick={() => void importMermaid()}>Paste Mermaid…</button>
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
              {zoom < 70 && nodeCount > 0 ? " · overview" : ""}
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
