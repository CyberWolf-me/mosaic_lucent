import type { Operation } from "@lucent/core";

/**
 * Templates are named batches of operations (docs/14 §9). Because the whole app
 * is operation-driven, a template applies exactly like an AI response — it
 * commits through the reducer + history and is fully undoable.
 *
 * Ids are generated per insert. Fixed ids meant the second insert of a template
 * collided with the first ("shape already exists"), the batch failed validation,
 * and the click silently did nothing.
 */

export interface Template {
  id: string;
  name: string;
  kind: string;
  /** Built fresh on each insert so ids never collide with existing shapes. */
  build: () => Operation[];
}

// A shape fill is board DATA, checked by the schema's colour grammar (core
// schemaPrimitives CSS_COLOR). These were switched to hex when that grammar
// refused oklch; it accepts oklch now (docs/26 F7), and hex stays because it
// is the most portable form for exports. Same colours: oklch(0.90 0.11 92),
// (0.86 0.08 235), (0.87 0.09 145), (0.86 0.10 10).
const AMBER = "#f8dc86";
const BLUE = "#9ddafe";
const GREEN = "#afe4b0";
const PINK = "#ffb6c2";

/** Per-insert id prefix, short enough to stay readable in exports. */
function runId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
}

function frame(id: string, x: number, y: number, w: number, h: number, text: string): Operation {
  return {
    op: "CREATE_SHAPE",
    id,
    kind: "frame",
    position: { x, y },
    size: { width: w, height: h },
    text,
    z: 0,
  };
}

function sticky(id: string, x: number, y: number, text: string, fill: string): Operation {
  return {
    op: "CREATE_SHAPE",
    id,
    kind: "sticky",
    position: { x, y },
    size: { width: 150, height: 110 },
    text,
    style: { fill },
    z: 1,
  };
}

/** Columns of frames with one seed sticky each — the shape of most workshops. */
function columnBoard(
  columns: Array<{ title: string; seed: string; fill: string }>,
  opts: { x?: number; y?: number; width?: number; height?: number } = {},
): Operation[] {
  const run = runId();
  const x0 = opts.x ?? 40;
  const y0 = opts.y ?? 40;
  const w = opts.width ?? 260;
  const h = opts.height ?? 400;
  const gap = 20;
  return columns.flatMap((c, i) => {
    const cx = x0 + i * (w + gap);
    return [
      frame(`${run}-f${i}`, cx, y0, w, h, c.title),
      sticky(`${run}-s${i}`, cx + 30, y0 + 50, c.seed, c.fill),
    ];
  });
}

export const TEMPLATES: Template[] = [
  {
    id: "swot",
    name: "SWOT Analysis",
    kind: "Business",
    build: () => {
      const run = runId();
      const cells: Array<[string, string, string, number, number]> = [
        ["Strengths", "Add a strength", GREEN, 40, 40],
        ["Weaknesses", "Add a weakness", PINK, 360, 40],
        ["Opportunities", "Add an opportunity", BLUE, 40, 280],
        ["Threats", "Add a threat", AMBER, 360, 280],
      ];
      return cells.flatMap(([title, seed, fill, x, y], i) => [
        frame(`${run}-f${i}`, x, y, 300, 220, title),
        sticky(`${run}-s${i}`, x + 30, y + 50, seed, fill),
      ]);
    },
  },
  {
    id: "retro",
    name: "Retrospective",
    kind: "Meetings",
    build: () =>
      columnBoard([
        { title: "Went well", seed: "What worked?", fill: GREEN },
        { title: "To improve", seed: "What to change?", fill: AMBER },
        { title: "Action items", seed: "Next step", fill: BLUE },
      ]),
  },
  {
    id: "kanban",
    name: "Kanban Board",
    kind: "Product",
    build: () =>
      columnBoard(
        [
          { title: "To do", seed: "First task", fill: AMBER },
          { title: "In progress", seed: "In flight", fill: BLUE },
          { title: "Done", seed: "Shipped", fill: GREEN },
        ],
        { width: 240, height: 420 },
      ),
  },
  {
    id: "mindmap-seed",
    name: "Mind Map",
    kind: "Brainstorm",
    build: () => {
      const run = runId();
      const core = `${run}-core`;
      const branches = ["Branch A", "Branch B", "Branch C"];
      return [
        { op: "CREATE_DIAGRAM", kind: "mindmap" },
        { op: "CREATE_NODE", id: core, nodeType: "idea", label: "Central idea" },
        ...branches.flatMap((label, i): Operation[] => [
          { op: "CREATE_NODE", id: `${run}-b${i}`, nodeType: "idea", label },
          { op: "CONNECT_NODES", source: core, target: `${run}-b${i}`, relationship: "branch" },
        ]),
      ];
    },
  },
  // docs/27 D1: the new families as starters — semantic boards, so the AI
  // can keep building on them ("add three more quick wins", "move launch a
  // week later"), not shape arrangements.
  {
    id: "impact-effort",
    name: "Impact × effort",
    kind: "Business",
    build: () => {
      const run = runId();
      const cells: Array<[string, string]> = [
        ["Quick wins · high impact, low effort", "Do these first"],
        ["Big bets · high impact, high effort", "Plan these"],
        ["Fill-ins · low impact, low effort", "When there's time"],
        ["Money pits · low impact, high effort", "Avoid"],
      ];
      return [
        { op: "CREATE_DIAGRAM", kind: "matrix" },
        ...cells.flatMap(([label, seed], i): Operation[] => [
          { op: "CREATE_GROUP", id: `${run}-c${i}`, label, children: [] },
          {
            op: "CREATE_NODE",
            id: `${run}-n${i}`,
            nodeType: "idea",
            label: seed,
            groupId: `${run}-c${i}`,
          },
        ]),
      ];
    },
  },
  {
    id: "roadmap",
    name: "Roadmap",
    kind: "Product",
    build: () => {
      const run = runId();
      const day = (offset: number) => {
        const d = new Date();
        d.setDate(d.getDate() + offset);
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      };
      const items: Array<[string, string, string, number]> = [
        ["product", "Discovery interviews", "task", 10],
        ["product", "Beta launch", "milestone", 45],
        ["eng", "Prototype", "task", 20],
        ["eng", "Hardening", "task", 60],
        ["eng", "General availability", "milestone", 90],
      ];
      return [
        { op: "CREATE_DIAGRAM", kind: "timeline" },
        { op: "CREATE_GROUP", id: `${run}-product`, label: "Product", children: [] },
        { op: "CREATE_GROUP", id: `${run}-eng`, label: "Engineering", children: [] },
        ...items.flatMap(([lane, label, type, offset], i): Operation[] => [
          {
            op: "CREATE_NODE",
            id: `${run}-i${i}`,
            nodeType: type,
            label,
            groupId: `${run}-${lane}`,
          },
          {
            op: "SET_ISSUE",
            id: `${run}-i${i}`,
            issue: { type: "task", status: "open", dueDate: day(offset) },
          },
        ]),
      ];
    },
  },
  {
    id: "state-machine",
    name: "State machine",
    kind: "Engineering",
    build: () => {
      const run = runId();
      const states: Array<[string, string, string]> = [
        ["start", "start", "Start"],
        ["draft", "state", "Draft"],
        ["review", "state", "In review"],
        ["published", "state", "Published"],
        ["archived", "state", "Archived"],
        ["end", "end", "End"],
      ];
      const moves: Array<[string, string, string]> = [
        ["start", "draft", "create"],
        ["draft", "review", "submit"],
        ["review", "draft", "request changes"],
        ["review", "published", "approve"],
        ["published", "archived", "archive"],
        ["archived", "end", "delete"],
      ];
      return [
        { op: "CREATE_DIAGRAM", kind: "statemachine" },
        ...states.map(
          ([id, nodeType, label]): Operation => ({
            op: "CREATE_NODE",
            id: `${run}-${id}`,
            nodeType,
            label,
          }),
        ),
        ...moves.map(
          ([a, b, event]): Operation => ({
            op: "CONNECT_NODES",
            source: `${run}-${a}`,
            target: `${run}-${b}`,
            relationship: event,
          }),
        ),
      ];
    },
  },
];
