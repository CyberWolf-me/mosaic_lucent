import { MockProvider, summarizeWorkspace } from "@lucent/ai";
import {
  createWorkspace,
  applyOperations,
  validateOperations,
  computeLayout,
  applyLayout,
  type Workspace,
} from "@lucent/core";

const provider = new MockProvider();
let ws: Workspace = createWorkspace();

for (const msg of ["build an e-commerce store", "add authentication", "use google oauth"]) {
  const { operations, explanation } = await provider.generateOperations({
    message: msg,
    summary: summarizeWorkspace(ws),
  });
  const errs = validateOperations(ws, operations);
  if (errs.length) {
    console.error("VALIDATION FAILED", errs);
    process.exit(1);
  }
  const applied = applyOperations(ws, operations);
  ws = applyLayout(applied, computeLayout(applied));
  console.log(`"${msg}" -> ${operations.length} ops | ${explanation}`);
}

console.log(`\nFinal: nodes=${Object.keys(ws.nodes).length} edges=${Object.keys(ws.edges).length}`);
console.log("auth label:", ws.nodes.auth?.label);
console.log("checkout position:", JSON.stringify(ws.nodes.checkout?.position));
console.log(
  "all nodes positioned:",
  Object.values(ws.nodes).every((n) => n.position),
);
