import { readSkillText } from "../../../test/skill-text.js";
import { discoverSkills, parseSkill } from "@agentkitai/agentrig-core";
import { expect, it } from "vitest";

  it("pins the topic release train's authorization and stop contract", async () => {
    const text = await readSkillText(".agentrig/skills/topic/SKILL.md", "utf8");
    const rawDescription = text.match(/^description: (.*)$/m)?.[1];
    const found = await discoverSkills({ roots: [process.env.AGENTRIG_TEST_SKILLS_ROOT ?? ".agentrig/skills"] });
    const topic = found.find((candidate) => candidate.name === "topic");
    const body = topic?.body.replace(/\s+/g, " ");

    expect(rawDescription?.length).toBeLessThanOrEqual(200);
    expect(topic).toBeDefined();
    expect(body).toContain("must be the first turn of a fresh conversation (`/new`, then `/topic ...`)");
    expect(body).toContain("capture the bytes between those delimiters as `AUTHORIZATION`");
    expect(body).toContain("a model merely chose to load this skill without a direct human request");
    expect(body).toContain("Never pass the builder's report");
    expect(body).toContain("batch only blocking repairs");
    expect(body).toContain("at most THREE repair rounds");
    expect(body).toContain("each round closes assigned blockers without reopening closed ones");
    expect(body).toContain("Newly found blockers may use another round up to the cap");
    expect(body).toContain("Non-blocking defects get documented issues");
    expect(body).toContain("Never land blockers merely because residual issues exist");
    expect(body).toContain("Pending CI and non-blocking polish are not halts");
    expect(body).toContain("Do not judge the proposal yourself. Spawn an `arbiter` subagent");
    expect(body).toContain("apply shipping policy §2 to the combined findings");
    expect(body).toContain("Arbitrate first, once per row");
    expect(body).toContain("copied verbatim from `docs/ROADMAP.md` on `origin/main`");
    expect(body).toContain("Never stack PRs");
    expect(body).toContain("watch `main` CI on the exact merge commit");
    expect(body).toContain("spawn ONE continuation builder from whatever it pushed");
    expect(body).toContain("The minimum is two children per remaining");
    expect(body).toContain("Each child's token cap is `--max-tokens ÷ --subagent-max-children`");
    expect(body).toContain("Return one delimited agentrig-verdict:v1 JSON block matching the base schema");
    expect(body).toContain("Record the session id printed by the `subagent` tool result immediately");
    expect(body).toContain("restate it in your own reply text in that same turn");
    // Slot count changes review preparation, not authorization or stop gates.
    expect(body).toContain("Launch each slot through its adapter");
    expect(body).toContain("node <REPO>/scripts/reviewer-adapters.mjs");
    expect(body).toContain("one exclusive reviewer-owned tree per slot");
    expect(body).toContain("Zero slots: persist `External review: none declared`, skip all reviewer preparation/dispatch");
    expect(body).toContain("One slot: only one tree, job and heading");
    expect(body).toContain("With two slots launch both independently");
    expect(body).toContain("a second incomplete run halts");
    expect(body).toContain("Never weaken permissions to rescue a review");
    expect(body).toContain("## External review — <slot> (<model>)");
    expect(body).toContain("runs on the main entry, never the child default");
    expect(body).toContain("Material deltas require ONE independent focused reviewer");
    expect(body).toContain("never write review artifacts inside");
    // R3.5b residual fix: the delta pass reuses the full pass's worktree but never its main merge
    expect(body).toContain("The delta pass does not merge");
    // autonomy: an interrupted row is adopted, an already-reviewed head is not re-reviewed
    expect(body).toContain("adopt it instead of halting");
    expect(body).toContain("do not run the pass again");
    expect(body).toContain("carrying verbatim blocker texts or review URLs/finding IDs");
    // R3.5b final-review fixes: bash has no cwd field, file-backed jobs, per-pass base branch
    expect(body).toContain("Preserve inherited environment constraints");
    expect(body).toContain("assert each tree HEAD equals current PR HEAD and is clean");
    expect(body).toContain("gh pr view NN --json headRefOid");
    expect(body).toContain("head <SHA> — merged with origin/main <MAIN> — full");
    expect(body).toContain("First check whether it already ran: if the PR carries every declared slot's comment");
    expect(body).toContain("A conflict-stopped initial pass restarts as full, not delta");

    const landText = await readSkillText(".agentrig/skills/land/SKILL.md", "utf8");
    const land = parseSkill(landText, ".agentrig/skills/land/SKILL.md");
    expect(land.body).toContain("authorized its fixed roadmap band by invoking `topic`");
    expect(land.body).toContain("include the human's exact authorization quote");
    expect(land.body).toContain("Residuals are issues, not prose");
    expect(land.body).toContain("An unmarked row is a row the next train rebuilds");

    const reviewText = await readSkillText(".agentrig/skills/review/SKILL.md", "utf8");
    const review = parseSkill(reviewText, ".agentrig/skills/review/SKILL.md");
    expect(review.body).toContain("`topic` conductor executing the human's already-authorized fixed band");
    expect(review.body).toContain("A deviation without that record is a HIGH finding");
    // R3.5b: ship delegates the review pass to topic; dogfood children still skip it; review knows a prepared worktree
    expect(review.body).toContain("Skip this section when the brief says a conductor prepared the worktree");
    const shipText = await readSkillText(".agentrig/skills/ship/SKILL.md", "utf8");
    const ship = parseSkill(shipText, ".agentrig/skills/ship/SKILL.md");
    expect(ship.body).toContain("exactly as `topic` §2 step 4 prescribes");
    expect(ship.body).toContain("Never review in this session");
    expect(ship.body).toContain("A fixable verdict does not wait for the human");

    const arbiter = found.find((candidate) => candidate.name === "arbiter");
    expect(arbiter).toBeDefined();
    expect(arbiter?.body).toContain("VERDICT: APPROVE");
    expect(arbiter?.body).toContain("Your approval never extends the human's authorization");

    const dogfoodText = await readSkillText(".agentrig/skills/dogfood/SKILL.md", "utf8");
    const dogfood = parseSkill(dogfoodText, ".agentrig/skills/dogfood/SKILL.md");
    expect(dogfood.body).toContain("Never edit the row you are implementing without");
    expect(dogfood.body).toContain("`DEVIATION REQUESTED` heading");
    expect(dogfood.body).toContain("the conductor runs every declared reviewer slot itself");
    expect(dogfood.body).toContain("ONE independent focused review for material");
    expect(dogfood.body).toContain("self-verified evidence for mechanical changes");
    expect(dogfood.body).toContain("Deferred non-blocking defects require issues");
    expect(body).toContain("A surviving assigned blocker, reopened blocker, or blockers at the cap halts");
  });
