import { describe, expect, it } from "vitest";
import { applyOperations, createWorkspace, validateOperations } from "@lucent/core";
import { planBpmnImport } from "../src/board/bpmnInterop.js";
import {
  BPMN_LIMITS,
  escapeXml,
  parseBpmn,
  parseXml,
  XmlError,
} from "../src/diagram/bpmn/index.js";

/**
 * BPMN import reads untrusted files (docs/19, V4): no DTDs or entity
 * expansion, nothing fetched, bounded size / nodes / edges / labels, and every
 * bad input answered with a sentence — never a throw.
 */

const NS = `xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"`;
const doc = (body: string) =>
  `<bpmn:definitions ${NS} id="D"><bpmn:process id="P">${body}</bpmn:process></bpmn:definitions>`;

describe("no DTDs, no entities, nothing fetched", () => {
  it("refuses a billion-laughs document before expanding anything", () => {
    const laughs = `<?xml version="1.0"?>
<!DOCTYPE lolz [
  <!ENTITY lol "lol">
  <!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">
  <!ENTITY lol3 "&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;">
]>
${doc(`<bpmn:task id="t" name="&lol3;"/>`)}`;
    const plan = planBpmnImport(createWorkspace(), laughs);
    expect(plan).toEqual({
      ok: false,
      error:
        "That file declares a DOCTYPE or entities, which Lucent never reads (they can pull in outside content). Export it again without a DTD.",
    });
  });

  it("refuses an external entity (XXE)", () => {
    const xxe = `<!DOCTYPE d [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>${doc(`<bpmn:task id="t" name="&xxe;"/>`)}`;
    const plan = planBpmnImport(createWorkspace(), xxe);
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.error).toMatch(/DOCTYPE/);
  });

  it("the reader itself refuses DTD markup anywhere, not only in the prolog", () => {
    expect(() => parseXml(`<!DOCTYPE a><a/>`)).toThrow(XmlError);
    expect(() => parseXml(`<a><!ENTITY x "y"></a>`)).toThrow(/DOCTYPE and entity declarations/);
  });

  it("leaves unknown entities literal and decodes the predefined ones in one pass", () => {
    expect(parseXml(`<a>&nbsp;&copy;</a>`).text).toBe("&nbsp;&copy;");
    // One pass: "&#38;lt;" is the text "&lt;", not "<".
    expect(parseXml(`<a>&#38;lt;</a>`).text).toBe("&lt;");
    expect(parseXml(`<a t="&lt;&amp;&quot;&#x41;&#66;"/>`).attrs.t).toBe('<&"AB');
  });

  it("an import element is just an element: its location is never followed", () => {
    const xml = `<bpmn:definitions ${NS} id="D"><bpmn:import importType="http://www.omg.org/spec/BPMN/20100524/MODEL" location="https://attacker.example/x.bpmn" namespace="urn:x"/><bpmn:process id="P"><bpmn:task id="t" name="Only me"/></bpmn:process></bpmn:definitions>`;
    const parsed = parseBpmn(xml);
    if (!parsed.ok) throw new Error(parsed.error);
    expect(parsed.graph.nodes).toEqual([{ id: "t", nodeType: "task", label: "Only me" }]);
  });

  it("an attribute named __proto__ is data, not a prototype", () => {
    const el = parseXml(`<a __proto__="polluted" id="x"/>`);
    expect(el.attrs.__proto__).toBe("polluted");
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    // …and a BPMN id of "__proto__" can't reach a workspace's prototype.
    const plan = planBpmnImport(
      createWorkspace(),
      doc(`<bpmn:task id="__proto__" name="Sneaky"/>`),
      "p",
    );
    if (!plan.ok) throw new Error(plan.error);
    const ws = applyOperations(createWorkspace(), plan.ops);
    expect(ws.nodes["p-__proto__"]!.label).toBe("Sneaky");
    expect(Object.getPrototypeOf(ws.nodes)).toBe(Object.prototype);
  });

  it("reads CDATA literally", () => {
    expect(parseXml(`<a><![CDATA[<b>&amp;</b>]]></a>`).text).toBe("<b>&amp;</b>");
  });
});

describe("bounded work", () => {
  it("refuses input over the size cap before parsing", () => {
    const huge = doc(`<bpmn:task id="t" name="${"x".repeat(BPMN_LIMITS.size)}"/>`);
    expect(planBpmnImport(createWorkspace(), huge)).toEqual({
      ok: false,
      error: "That BPMN file is too large to import — the limit is 2 MB.",
    });
  });

  it("caps nodes, and says how many came in", () => {
    const tasks = Array.from({ length: 520 }, (_, i) => `<bpmn:task id="t${i}" name="Step ${i}"/>`);
    const flows = Array.from(
      { length: 519 },
      (_, i) => `<bpmn:sequenceFlow id="f${i}" sourceRef="t${i}" targetRef="t${i + 1}"/>`,
    );
    const plan = planBpmnImport(createWorkspace(), doc([...tasks, ...flows].join("")), "c");
    if (!plan.ok) throw new Error(plan.error);
    expect(plan.nodeIds.length).toBe(BPMN_LIMITS.nodes);
    expect(plan.message).toBe(
      "Imported a BPMN process — 500 nodes. Only the first 500 of 520 came in.",
    );
    // Flows to the dropped nodes are dropped with them; the rest validate.
    expect(plan.ops.filter((o) => o.op === "CONNECT_NODES").length).toBe(499);
    expect(validateOperations(createWorkspace(), plan.ops)).toEqual([]);
  });

  it("caps edges", () => {
    const n = 50;
    const tasks = Array.from({ length: n }, (_, i) => `<bpmn:task id="t${i}"/>`);
    const flows: string[] = [];
    for (let a = 0; a < n; a++) {
      for (let b = a + 1; b < n; b++) {
        flows.push(`<bpmn:sequenceFlow id="f${a}_${b}" sourceRef="t${a}" targetRef="t${b}"/>`);
      }
    }
    const plan = planBpmnImport(createWorkspace(), doc([...tasks, ...flows].join("")), "e");
    if (!plan.ok) throw new Error(plan.error);
    expect(plan.ops.filter((o) => o.op === "CONNECT_NODES").length).toBe(BPMN_LIMITS.edges);
    expect(plan.message).toContain(`Only the first 1000 of ${(n * (n - 1)) / 2} flows came in.`);
  });

  it("trims labels to one line and caps them", () => {
    const name = `  Review\n\n  the&#10;order ${"a".repeat(400)}`;
    const parsed = parseBpmn(doc(`<bpmn:task id="t" name="${name}"/>`));
    if (!parsed.ok) throw new Error(parsed.error);
    const label = parsed.graph.nodes[0]!.label;
    expect(label.length).toBe(BPMN_LIMITS.label);
    expect(label.startsWith("Review the order aaa")).toBe(true);
  });

  it("stays linear on a large document (tens of thousands of elements)", () => {
    const tasks = Array.from({ length: 30_000 }, (_, i) => `<bpmn:task id="t${i}"/>`).join("");
    const parsed = parseBpmn(doc(tasks));
    if (!parsed.ok) throw new Error(parsed.error);
    expect(parsed.graph.nodes.length).toBe(BPMN_LIMITS.nodes);
    expect(parsed.graph.total.nodes).toBe(30_000);
  });

  it("caps nesting depth and element count in the reader", () => {
    const deep = `${"<a>".repeat(150)}${"</a>".repeat(150)}`;
    expect(() => parseXml(deep)).toThrow(/nested deeper than 100 levels/);
    expect(() => parseXml(`<a>${"<b/>".repeat(20)}</a>`, { maxElements: 10 })).toThrow(
      /more than 10 elements/,
    );
    const plan = planBpmnImport(
      createWorkspace(),
      `<bpmn:definitions ${NS}>${deep}</bpmn:definitions>`,
    );
    expect(plan).toEqual({
      ok: false,
      error: expect.stringMatching(/^That isn't XML Lucent can read: elements nested deeper/),
    });
  });
});

describe("invalid input is a sentence, never a throw", () => {
  const cases: Array<[string, RegExp]> = [
    ["", /empty/],
    ["   ", /empty/],
    ["just some notes", /isn't XML/],
    ["<", /isn't XML Lucent can read/],
    ["<a b=>", /isn't XML Lucent can read/],
    ["<a></b>", /mismatched close/],
    ["<a>&#xFFFFFFF;</a>", /invalid character reference/],
    ["<a>&#0;</a>", /invalid character reference/],
    ["<a/><b/>", /trailing content/],
    ["<a><![CDATA[never closed</a>", /unterminated CDATA/],
    ["<a><!-- never closed</a>", /unterminated comment/],
    [`<svg xmlns="http://www.w3.org/2000/svg"/>`, /isn't a BPMN 2.0 diagram/],
    [`<bpmn:definitions ${NS}/>`, /no process to import/],
    [
      doc(`<bpmn:sequenceFlow id="f" sourceRef="a" targetRef="b"/>`),
      /no events, tasks or gateways/,
    ],
  ];
  for (const [input, error] of cases) {
    it(`${JSON.stringify(input.slice(0, 40))}`, () => {
      const plan = planBpmnImport(createWorkspace(), input);
      expect(plan.ok).toBe(false);
      if (!plan.ok) expect(plan.error).toMatch(error);
    });
  }
});

describe("escapeXml", () => {
  it("round-trips line breaks through an attribute and drops what XML can't carry", () => {
    const label = "Line one\nLine\ttwo \u0007bell <&>";
    const el = parseXml(`<a name="${escapeXml(label)}"/>`);
    expect(el.attrs.name).toBe("Line one\nLine\ttwo bell <&>");
  });

  it("keeps a surrogate pair (an emoji) and drops a lone surrogate", () => {
    const rocket = String.fromCodePoint(0x1f680);
    const lone = String.fromCharCode(0xd800);
    expect(escapeXml(`Launch ${rocket}${lone}!`)).toBe(`Launch ${rocket}!`);
  });

  it("reads non-ASCII element and attribute names", () => {
    const el = parseXml(`<prüfung größe="1"><schritt/></prüfung>`);
    expect(el.name).toBe("prüfung");
    expect(el.attrs["größe"]).toBe("1");
    expect(el.children[0]!.name).toBe("schritt");
  });
});
