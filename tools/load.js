// tools/load.js — load an app, resolve every reference, report the result.
//
//   node tools/load.js <path/to/app.xml> [--dump-tree]
//
// Exit 0: loaded and every reference bound. Prints a summary; with
// --dump-tree, prints the instantiated tree with each reference site's
// resolved target path.
// Exit 1: load error (parse failure, reserved name, unresolved or ambiguous
// reference). The error names the reference site.

import { loadApp, ApskelLoadError } from "../runtime/loader.js";
import { resolveReferences } from "../runtime/pathResolver.js";

const args = process.argv.slice(2);
const dump = args.includes("--dump-tree");
const file = args.find((a) => !a.startsWith("--"));

if (!file) {
  console.error("usage: node tools/load.js <path/to/app.xml> [--dump-tree]");
  process.exit(2);
}

try {
  const root = loadApp(file);
  resolveReferences(root);
  console.log(
    `Loaded OK: ${countInstances(root)} component instances, ` +
      `${root.allRefs.length} reference sites bound.`
  );
  if (dump) {
    console.log("");
    dumpTree(root, "");
  }
} catch (e) {
  if (e instanceof ApskelLoadError) {
    console.error(`LOAD ERROR: ${e.message}`);
    process.exit(1);
  }
  throw e;
}

function countInstances(node) {
  return 1 + node.children.reduce((n, c) => n + countInstances(c), 0);
}

function describeBinding(binding) {
  if (binding.kind === "function") {
    const argText = binding.args
      .map((a) => (a.kind === "literal" ? a.value : describeBinding(a.binding)))
      .join(", ");
    return `function ${binding.name}(${argText})`;
  }
  const field = binding.field ? ` field '${binding.field}'` : "";
  const table = binding.table ? ` (table '${binding.table}')` : "";
  return `${binding.targetPath}${field}${table}`;
}

function dumpTree(node, indent) {
  const kind = node.isRoot
    ? "app root"
    : node.isComposite
      ? `composite '${node.type}'`
      : `leaf '${node.type}'`;
  console.log(`${indent}${node.name}  [${kind}]  path=${node.path}`);
  for (const site of node.refSites) {
    console.log(
      `${indent}    ${site.raw}  [${site.form}]  ->  ${describeBinding(site.binding)}`
    );
  }
  for (const child of node.children) {
    dumpTree(child, indent + "    ");
  }
}
