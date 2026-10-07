function sanitizeWireframeElement(raw) {
  if (!raw || typeof raw !== "object") {
    return { kind: "text", label: String(raw ?? "") };
  }
  const el = { ...raw };

  if (typeof el.kind !== "string" || !el.kind.trim()) {
    el.kind = typeof el.type === "string" && el.type.trim() ? el.type.trim() : "card";
  } else {
    el.kind = el.kind.trim();
  }

  if (typeof el.label !== "string") {
    const candidate = el.text ?? el.title ?? el.name ?? el.value ?? el.heading ?? el.caption;
    if (candidate !== undefined && candidate !== null) {
      el.label = String(candidate);
    }
  }

  if (el.placeholder !== undefined && el.placeholder !== null && typeof el.placeholder !== "string") {
    el.placeholder = String(el.placeholder);
  }

  if (el.variant !== undefined && el.variant !== null) {
    const v = String(el.variant).toLowerCase().trim();
    if (v === "primary" || v === "secondary" || v === "ghost") {
      el.variant = v;
    } else if (v === "outline" || v === "muted" || v === "subtle") {
      el.variant = "secondary";
    } else if (v === "solid" || v === "default" || v === "accent" || v === "brand") {
      el.variant = "primary";
    } else if (v === "text" || v === "link") {
      el.variant = "ghost";
    } else {
      delete el.variant;
    }
  }

  if (el.direction !== undefined && el.direction !== null) {
    const d = String(el.direction).toLowerCase().trim();
    if (d === "row" || d === "horizontal" || d === "inline") {
      el.direction = "row";
    } else if (d === "column" || d === "vertical" || d === "stack") {
      el.direction = "column";
    } else {
      delete el.direction;
    }
  }

  if (el.weight !== undefined && el.weight !== null) {
    const num = typeof el.weight === "number" ? el.weight : parseFloat(String(el.weight));
    if (Number.isFinite(num) && num > 0) {
      el.weight = num;
    } else {
      delete el.weight;
    }
  }

  const rawChildren = Array.isArray(el.children)
    ? el.children
    : Array.isArray(el.elements)
      ? el.elements
      : Array.isArray(el.items)
        ? el.items
        : undefined;

  if (rawChildren) {
    el.children = rawChildren.map((c) => sanitizeWireframeElement(c));
  } else {
    delete el.children;
  }

  return el;
}

function sanitizeOp(copy) {
  if (copy.op === "UPDATE_WIREFRAME") copy.op = "CREATE_WIREFRAME";
  if (copy.op === "CREATE_WIREFRAME") {
    if (!copy.id || typeof copy.id !== "string" || !copy.id.trim()) {
      copy.id = `wf_${Math.random().toString(36).slice(2, 9)}`;
    } else {
      copy.id = copy.id.trim();
    }
    if (typeof copy.title !== "string" || !copy.title.trim()) {
      const candidate = copy.name ?? copy.label ?? copy.title ?? "Wireframe";
      copy.title = String(candidate).trim() || "Wireframe";
    } else {
      copy.title = copy.title.trim();
    }
    if (copy.viewport !== "desktop" && copy.viewport !== "tablet" && copy.viewport !== "mobile") {
      const vp = String(copy.viewport ?? "").toLowerCase().trim();
      if (vp === "mobile" || vp === "phone" || vp === "mobile-first" || vp === "smartphone") {
        copy.viewport = "mobile";
      } else if (vp === "tablet" || vp === "ipad") {
        copy.viewport = "tablet";
      } else {
        copy.viewport = "desktop";
      }
    }
    if (!copy.root || typeof copy.root !== "object") {
      const rawChildren = Array.isArray(copy.children)
        ? copy.children
        : Array.isArray(copy.elements)
          ? copy.elements
          : [];
      copy.root = {
        kind: "screen",
        children: rawChildren.map(sanitizeWireframeElement),
      };
    } else {
      copy.root = sanitizeWireframeElement(copy.root);
    }
  }
  return copy;
}

import { safeParseOperations } from "../packages/core/src/operations.js";

const samples = [
  {
    name: "name instead of title, text instead of label, vertical direction, outline variant",
    raw: [
      {
        op: "CREATE_WIREFRAME",
        id: "wf-1",
        name: "Homepage",
        viewport: "desktop",
        root: {
          kind: "screen",
          direction: "vertical",
          children: [
            { kind: "header", text: "Listing header" },
            { kind: "button", text: "Click me", variant: "outline" }
          ]
        }
      }
    ]
  },
  {
    name: "missing id, title present, horizontal direction",
    raw: [
      {
        op: "CREATE_WIREFRAME",
        title: "Homepage",
        root: {
          kind: "screen",
          direction: "horizontal",
          children: []
        }
      }
    ]
  },
  {
    name: "root is screen directly without root wrapper, e.g. children directly",
    raw: [
      {
        op: "CREATE_WIREFRAME",
        id: "wf-2",
        title: "Homepage",
        children: [
          { kind: "nav", label: "Navigation" }
        ]
      }
    ]
  },
  {
    name: "UPDATE_WIREFRAME alias/op",
    raw: [
      {
        op: "UPDATE_WIREFRAME",
        id: "wf-1",
        title: "Homepage Updated",
        root: {
          kind: "screen",
          children: []
        }
      }
    ]
  }
];

for (const s of samples) {
  console.log("--- Testing: " + s.name);
  const sanitized = s.raw.map(sanitizeOp);
  const parsed = safeParseOperations(sanitized);
  console.log("Success:", parsed.success);
  if (!parsed.success) {
    console.log("Issues:", parsed.error.issues.map(i => `${i.path.join(".")}: ${i.message}`));
  }
}
