import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverSkills, parseSkill, skillTool, skillsInjection } from "@agentkitai/agentrig-core";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "agentrig-skills-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const ctx = { cwd: "/w", sessionId: "s", emit: () => {}, signal: new AbortController().signal };

async function skill(path: string, contents: string): Promise<void> {
  const full = join(dir, path);
  await mkdir(join(full, ".."), { recursive: true });
  await writeFile(full, contents, "utf8");
}

describe("parseSkill", () => {
  it("reads name and description from frontmatter", () => {
    const s = parseSkill('---\nname: deploy\ndescription: How to ship a release\n---\n\nStep one.', "/x/deploy.md");
    expect(s.name).toBe("deploy");
    expect(s.description).toBe("How to ship a release");
    expect(s.body).toBe("Step one.");
  });

  it("falls back to the filename and the first line of the body", () => {
    const s = parseSkill("# Reviewing a PR\n\nRead the diff first.", "/x/review.md");
    expect(s.name).toBe("review");
    // the model picks a skill on its description, so an empty one is nearly useless
    expect(s.description).toBe("Reviewing a PR");
  });

  it("says so plainly when there is nothing to describe it by", () => {
    expect(parseSkill("", "/x/empty.md").description).toBe("(no description)");
  });

  it("strips quotes and tolerates CRLF", () => {
    const s = parseSkill('---\r\nname: "quoted"\r\ndescription: \'single\'\r\n---\r\nbody', "/x/a.md");
    expect(s.name).toBe("quoted");
    expect(s.description).toBe("single");
  });

  it("treats a document with no frontmatter as all body", () => {
    expect(parseSkill("just prose", "/x/a.md").body).toBe("just prose");
  });
});

describe("discoverSkills", () => {
  it("finds both <name>.md and <name>/SKILL.md", async () => {
    await skill("flat.md", "---\ndescription: a flat one\n---\nbody");
    await skill("nested/SKILL.md", "---\ndescription: a nested one\n---\nbody");
    const found = await discoverSkills({ roots: [dir] });
    expect(found.map((s) => s.name).sort()).toEqual(["flat", "nested"]);
  });

  it("ignores non-markdown files", async () => {
    await skill("notes.txt", "not a skill");
    await skill("real.md", "---\ndescription: d\n---\nb");
    expect((await discoverSkills({ roots: [dir] })).map((s) => s.name)).toEqual(["real"]);
  });

  it("a directory that does not exist is not an error", async () => {
    expect(await discoverSkills({ roots: [join(dir, "nope")] })).toEqual([]);
  });

  it("the first root wins, so a project skill shadows a global one", async () => {
    const global = join(dir, "global");
    const project = join(dir, "project");
    await mkdir(global, { recursive: true });
    await mkdir(project, { recursive: true });
    await writeFile(join(global, "deploy.md"), "---\ndescription: the global one\n---\nglobal body", "utf8");
    await writeFile(join(project, "deploy.md"), "---\ndescription: the project one\n---\nproject body", "utf8");

    const found = await discoverSkills({ roots: [project, global] });
    expect(found).toHaveLength(1);
    expect(found[0]!.description).toBe("the project one");
  });

  it("skips a file too large to be a skill", async () => {
    await skill("huge.md", "x".repeat(2000));
    expect(await discoverSkills({ roots: [dir], maxBytes: 100 })).toEqual([]);
  });

  it("stops at maxSkills rather than reading a whole directory tree", async () => {
    for (let i = 0; i < 20; i += 1) await skill(`s${i}.md`, `---\ndescription: d${i}\n---\nb`);
    expect(await discoverSkills({ roots: [dir], maxSkills: 5 })).toHaveLength(5);
  });
});

describe("skillsInjection", () => {
  it("is one line per skill — the body is NOT in the prompt", async () => {
    await skill("a.md", "---\ndescription: does a thing\n---\n" + "BODY ".repeat(500));
    const found = await discoverSkills({ roots: [dir] });
    const text = skillsInjection(found);

    expect(text).toContain("- a: does a thing");
    // twenty skills of a thousand words each would cost more context than the task
    expect(text).not.toContain("BODY");
    expect(text.length).toBeLessThan(400);
  });

  it("is empty when there are no skills, so nothing is injected", () => {
    expect(skillsInjection([])).toBe("");
  });
});

describe("skillTool", () => {
  it("returns the body of the named skill", async () => {
    await skill("deploy.md", "---\ndescription: d\n---\nRun the release script.");
    const found = await discoverSkills({ roots: [dir] });
    const r = await skillTool(found).execute({ name: "deploy" }, ctx);
    expect(r.display).toBe("Run the release script.");
    expect(r.isError).toBeUndefined();
  });

  it("matches case-insensitively and ignores surrounding space", async () => {
    await skill("deploy.md", "---\ndescription: d\n---\nbody");
    const found = await discoverSkills({ roots: [dir] });
    expect((await skillTool(found).execute({ name: "  DEPLOY " }, ctx)).display).toBe("body");
  });

  it("lists what IS available when asked for something that is not", async () => {
    await skill("deploy.md", "---\ndescription: d\n---\nbody");
    const found = await discoverSkills({ roots: [dir] });
    const r = await skillTool(found).execute({ name: "nope" }, ctx);
    expect(r.isError).toBe(true);
    expect(r.display).toContain("Available: deploy");
  });

  it("reads only the skills already discovered, never a path the model supplies", async () => {
    await skill("a.md", "---\ndescription: d\n---\nbody");
    const found = await discoverSkills({ roots: [dir] });
    const tool = skillTool(found);
    // the name is a key into a fixed map, so there is no path here to traverse
    for (const attempt of ["../../etc/passwd", "/etc/passwd", "a/../../b"]) {
      expect((await tool.execute({ name: attempt }, ctx)).isError).toBe(true);
    }
    expect(tool.permission).toBe("read");
  });

  it("rejects an empty name", () => {
    expect(skillTool([]).inputSchema.safeParse({ name: "" }).success).toBe(false);
  });
});
