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
  // Bind local identifiers so an unrelated fixture's `result` cannot inherit
  // taint from another test's same-named local.
  const host = ts.createCompilerHost({ noLib: true });
  host.getSourceFile = name => name === "test.ts" ? source : undefined;
  const checker = ts.createProgram(["test.ts"], { noLib: true }, host).getTypeChecker();
  // Properties assigned onto `{}` have no checker symbol. Key those by their
  // scoped receiver plus property name, never by a shared `undefined` key.
  const propertyKeys = new Map<ts.Symbol | ts.Node, Map<string, ts.Node>>();
  function symbol(node: ts.Node): ts.Symbol | ts.Node {
    const bound = checker.getSymbolAtLocation(node);
    if (bound) return bound;
    if (ts.isPropertyAccessExpression(node)) {
      const receiver = symbol(node.expression);
      let properties = propertyKeys.get(receiver);
      if (!properties) propertyKeys.set(receiver, properties = new Map());
      const name = node.name.text;
      let key = properties.get(name);
      if (!key) properties.set(name, key = node);
      return key;
    }
    return node;
  }
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
  const tainted = new Set<ts.Symbol | ts.Node>();
  // Root evidence is separate from full skill taint: .agentrig/config.json and
  // generated SKILL.md fixtures are not repository instruction reads.
  const roots = new Set<ts.Symbol | ts.Node>();
  function pathPart(node: ts.Node, part: RegExp, identifiers?: Set<ts.Symbol | ts.Node>): boolean {
    if ((ts.isIdentifier(node) || ts.isPropertyAccessExpression(node)) && identifiers?.has(symbol(node))) return true;
    if ((ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) && part.test(node.text)) return true;
    return ts.forEachChild(node, child => pathPart(child, part, identifiers) || undefined) ?? false;
  }
  const rooted = (node: ts.Node) => pathPart(node, /(?:^|[\/\\])\.agentrig(?:[\/\\]|$)/, roots);
  function skill(node: ts.Node): boolean {
    if ((ts.isIdentifier(node) || ts.isPropertyAccessExpression(node)) && tainted.has(symbol(node))) return true;
    if ((ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) && /\.agentrig[\/\\]skills/.test(node.text)) return true;
    if (ts.isCallExpression(node) && rooted(node) && pathPart(node, /(?:^|[\/\\])skills(?:[\/\\]|$)/)) return true;
    return ts.forEachChild(node, child => skill(child) || undefined) ?? false;
  }
  let changed = true;
  while (changed) {
    const size = tainted.size + roots.size;
    for (const node of nodes) {
      const target = (ts.isVariableDeclaration(node) || ts.isPropertyAssignment(node)) ? node.name
        : ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken ? node.left : undefined;
      const value = (ts.isVariableDeclaration(node) || ts.isPropertyAssignment(node)) ? node.initializer
        : ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken ? node.right : undefined;
      if (target && value && (ts.isIdentifier(target) || ts.isPropertyAccessExpression(target))) {
        if (rooted(value)) roots.add(symbol(target));
        if (skill(value)) tainted.add(symbol(target));
      }
      if (ts.isFunctionDeclaration(node) && node.name && node.body) {
        const returns: ts.Expression[] = [];
        const collect = (child: ts.Node) => {
          if (ts.isFunctionLike(child)) return;
          if (ts.isReturnStatement(child) && child.expression) returns.push(child.expression);
          ts.forEachChild(child, collect);
        };
        collect(node.body);
        if (returns.some(skill)) tainted.add(symbol(node.name));
      }
      if (ts.isCallExpression(node)) {
        for (const declaration of functions) {
          const fn = ts.isFunctionDeclaration(declaration) ? declaration
            : ts.isVariableDeclaration(declaration) && declaration.initializer && (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer)) ? declaration.initializer : undefined;
          const name = ts.isFunctionDeclaration(declaration) ? declaration.name?.getText(source) : ts.isVariableDeclaration(declaration) ? declaration.name.getText(source) : undefined;
          if (!fn || name !== node.expression.getText(source)) continue;
          node.arguments.forEach((arg, index) => {
            const parameter = fn.parameters[index];
            if (parameter && skill(arg) && ts.isIdentifier(parameter.name)) tainted.add(symbol(parameter.name));
          });
        }
      }
    }
    changed = tainted.size + roots.size !== size;
  }
  return nodes.some(node => {
    if (!ts.isCallExpression(node)) return false;
    const expression = node.expression;
    const reader = readers.has(expression.getText(source)) || (ts.isPropertyAccessExpression(expression) && (namespaces.has(expression.expression.getText(source)) || (ts.isPropertyAccessExpression(expression.expression) && expression.expression.name.text === "promises" && namespaces.has(expression.expression.expression.getText(source)))) && /^readFile(?:Sync)?$/.test(expression.name.text));
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
}, 30_000);

it.each([
  'import { readFile } from "node:fs/promises"; const read = p => readFile(p); read(".agentrig/skills/topic/SKILL.md");',
  'import { readFileSync as read } from "node:fs"; read(new URL(`../../../.agentrig/skills/${name}/SKILL.md`, import.meta.url));',
  'import * as fs from "node:fs"; fs.readFileSync(resolve(".agentrig/skills", name, "SKILL.md"));',
  'import { readFileSync } from "fs"; const path = join(".agentrig", "skills", "topic", "SKILL.md"); readFileSync(path);',
  'import { readFileSync } from "node:fs"; function skillPath() { return new URL("../../../.agentrig/skills/topic/SKILL.md", import.meta.url); } readFileSync(skillPath());',
  'import { readFileSync } from "node:fs"; function skillPath() { const path = new URL("../../../.agentrig/skills/topic/SKILL.md", import.meta.url); return path; } readFileSync(skillPath());',
  'import { readFileSync } from "node:fs"; function identity(p) { return p; } readFileSync(identity(".agentrig/skills/topic/SKILL.md"));',
  'import * as fs from "node:fs"; fs.promises.readFile(".agentrig/skills/topic/SKILL.md");',
  'import { readFileSync } from "node:fs"; readFileSync(join(root, ".agentrig", "skills/ship/SKILL.md"));',
  'import { readFileSync } from "node:fs"; const dir = join(root, ".agentrig"); readFileSync(join(dir, "skills", "ship", "SKILL.md"));',
  'import { readFileSync } from "node:fs"; readFileSync(join(root, ".agentrig", "skills", "dogfood", "SKILL.md"));',
  'import { readFileSync } from "node:fs"; let dir; dir = join(root, ".agentrig"); readFileSync(join(dir, "skills", "dogfood", "SKILL.md"));',
  'import { readFileSync } from "node:fs"; const cfg = {}; cfg.dir = join(process.cwd(), ".agentrig"); readFileSync(join(cfg.dir, "skills", "dogfood", "SKILL.md"), "utf8");',
  'import { readFileSync } from "node:fs"; const cfg = { dir: "" }; cfg.dir = join(root, ".agentrig"); readFileSync(join(cfg.dir, "skills", "dogfood", "SKILL.md"));',
  'import { readFileSync } from "node:fs"; const cfg = { dir: join(root, ".agentrig") }; readFileSync(join(cfg.dir, "skills", "dogfood", "SKILL.md"));',
  'import { readFileSync } from "node:fs"; const cfg = { path: "" }; cfg.path = join(root, ".agentrig", "skills", "dogfood", "SKILL.md"); readFileSync(cfg.path);',
])("rejects bypass shape %s", text => expect(bypassesLoader(text)).toBe(true));

it("pins the builder/fixer pre-push CRLF proof beside declared check receipts", () => {
  expect(readSkillText(".agentrig/skills/dogfood/SKILL.md")).toContain("Zero, one or many named steps");
  expect(readSkillText(".agentrig/skills/dogfood/SKILL.md")).toContain("Before every push, builders and fixers must rerun all touched instruction-contract and skill-text test files against a CRLF copy of the entire `.agentrig/skills` tree (normalize LF before converting to CRLF), point `AGENTRIG_TEST_SKILLS_ROOT` at that copy under the proof `TMPDIR` outside Git ancestry, and record start/end times, exact commands, exits and test counts next to the declared check receipts in the PR.");
});

it.each([
  'import { readFileSync } from "node:fs"; const path = join(temp, "generated", "SKILL.md"); readFileSync(path);',
  'import * as fs from "node:fs"; function unrelated() { const example = ".agentrig/skills/topic/SKILL.md"; return "fixture.md"; } fs.promises.readFile(unrelated());',
  'import { readFileSync } from "node:fs"; function skillPath() { const path = ".agentrig/skills/topic/SKILL.md"; return path; } function fixture() { const path = "generated/SKILL.md"; readFileSync(path); }',
  'import { readFileSync } from "node:fs"; const dir = join(temp, "generated"); readFileSync(join(dir, "skills", "SKILL.md"));',
  'import { readFileSync } from "node:fs"; const dir = join(root, ".agentrig"); readFileSync(join(temp, "generated", "SKILL.md"));',
  'import { readFileSync } from "node:fs"; const dir = join(root, ".agentrig"); readFileSync(join(dir, "config.json"));',
  'import { readFileSync } from "node:fs"; const cfg = { dir: join(temp, "generated") }; readFileSync(join(cfg.dir, "skills", "SKILL.md"));',
  'import { readFileSync } from "node:fs"; const cfg = { dir: join(root, ".agentrig") }; readFileSync(join(cfg.dir, "config.json"));',
  'import { readFileSync } from "node:fs"; const cfg = {}; cfg.dir = join(root, ".agentrig"); const fixture = {}; fixture.dir = join(temp, "generated"); readFileSync(join(fixture.dir, "skills", "SKILL.md"));',
  'import { readFileSync } from "node:fs"; const cfg = {}; cfg.dir = join(root, ".agentrig"); cfg.fixture = join(temp, "generated"); readFileSync(join(cfg.fixture, "skills", "SKILL.md"));',
  'import { readFileSync } from "node:fs"; function repo() { const cfg = { dir: join(root, ".agentrig") }; } function fixture() { const cfg = { dir: join(temp, "generated") }; readFileSync(join(cfg.dir, "skills", "SKILL.md")); }',
])("allows non-repository fixture reads %s", text => expect(bypassesLoader(text)).toBe(false));
