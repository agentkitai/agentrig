import { readSkillText } from "../../../test/skill-text.js";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import ts from "typescript";

// Conservative intra-file taint walk: follow skill path variables and generic
// wrapper parameters, including aliases and namespace fs readers. This checks
// actual read calls rather than banning unrelated fixture I/O in the same file.
function bypassesLoader(text: string): boolean {
  const source = ts.createSourceFile("test.ts", text, ts.ScriptTarget.Latest, true);
  const nodes: ts.Node[] = [];
  function visit(node: ts.Node) { nodes.push(node); ts.forEachChild(node, visit); }
  visit(source);
  const readers = new Set<string>();
  const namespaces = new Set<string>();
  for (const node of nodes) {
    if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier) || !/^(?:node:)?fs(?:\/promises)?$/.test(node.moduleSpecifier.text)) continue;
    const bindings = node.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const item of bindings.elements) if (/^readFile(?:Sync)?$/.test((item.propertyName ?? item.name).text)) readers.add(item.name.text);
    } else if (bindings && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text);
    if (node.importClause?.name) namespaces.add(node.importClause.name.text);
  }
  if (readers.size === 0 && namespaces.size === 0) return false;
  // Most test files never mention skills; avoid walking their expression graph.
  if (!text.includes("SKILL.md") && !text.includes(".agentrig/skills")) return false;
  const functions = nodes.filter(node => ts.isFunctionDeclaration(node) || (ts.isVariableDeclaration(node) && node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))));
  const tainted = new Set<string>();
  function skill(node: ts.Node): boolean {
    if (ts.isIdentifier(node) && tainted.has(node.text)) return true;
    if ((ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) && /SKILL\.md|\.agentrig[\/\\]skills/.test(node.text)) return true;
    return ts.forEachChild(node, child => skill(child) || undefined) ?? false;
  }
  let changed = true;
  while (changed) {
    const size = tainted.size;
    for (const node of nodes) {
      if (ts.isVariableDeclaration(node) && node.initializer && skill(node.initializer) && ts.isIdentifier(node.name)) tainted.add(node.name.text);
      if (ts.isCallExpression(node)) {
        for (const declaration of functions) {
          const fn = ts.isFunctionDeclaration(declaration) ? declaration
            : ts.isVariableDeclaration(declaration) && declaration.initializer && (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer)) ? declaration.initializer : undefined;
          const name = ts.isFunctionDeclaration(declaration) ? declaration.name?.getText(source) : ts.isVariableDeclaration(declaration) ? declaration.name.getText(source) : undefined;
          if (!fn || name !== node.expression.getText(source)) continue;
          node.arguments.forEach((arg, index) => {
            const parameter = fn.parameters[index];
            if (parameter && skill(arg) && ts.isIdentifier(parameter.name)) tainted.add(parameter.name.text);
          });
        }
      }
    }
    changed = tainted.size !== size;
  }
  return nodes.some(node => {
    if (!ts.isCallExpression(node)) return false;
    const expression = node.expression;
    const reader = readers.has(expression.getText(source)) || (ts.isPropertyAccessExpression(expression) && namespaces.has(expression.expression.getText(source)) && /^readFile(?:Sync)?$/.test(expression.name.text));
    return reader && node.arguments.some(skill);
  });
}

it("every repository skill instruction reader uses the shared skill-text loader", () => {
  const violations: string[] = [];
  for (const dir of ["../../../packages/core/test/", "../../../packages/cli/test/"]) {
    const base = new URL(dir, import.meta.url);
    for (const file of readdirSync(base, { recursive: true })) {
      if (!file.endsWith(".ts")) continue;
      const url = new URL(file, base);
      if (url.href === import.meta.url) continue;
      if (bypassesLoader(readSkillText(url, "utf8"))) violations.push(fileURLToPath(url));
    }
  }
  expect(violations).toEqual([]);
});

it.each([
  'import { readFile } from "node:fs/promises"; const read = p => readFile(p); read(".agentrig/skills/topic/SKILL.md");',
  'import { readFileSync as read } from "node:fs"; read(new URL(`../../../.agentrig/skills/${name}/SKILL.md`, import.meta.url));',
  'import * as fs from "node:fs"; fs.readFileSync(resolve(".agentrig/skills", name, "SKILL.md"));',
  'import { readFileSync } from "fs"; const path = join(".agentrig", "skills", "topic", "SKILL.md"); readFileSync(path);',
])("rejects bypass shape %s", text => expect(bypassesLoader(text)).toBe(true));

it("pins the builder/fixer pre-push CRLF proof beside the trio", () => {
  expect(readSkillText(".agentrig/skills/dogfood/SKILL.md")).toContain("Before every push, builders and fixers must rerun all touched instruction-contract and skill-text test files against a CRLF copy of the entire `.agentrig/skills` tree (normalize LF before converting to CRLF), point `AGENTRIG_TEST_SKILLS_ROOT` at that copy under the proof `TMPDIR` outside Git ancestry, and record start/end times, exact commands, exits and test counts next to the declared-check trio in the PR.");
});
