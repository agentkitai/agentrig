#!/usr/bin/env node
import { Command } from "commander";
import { SessionStore } from "@agentkitai/agentrig-core";
import { renderEvent } from "./render.js";

const program = new Command();
program.name("agentrig").description("AgentRig — agentic harness with a built-in supervisor loop and LLM Wiki memory");

const sessions = program.command("sessions").description("Inspect session event logs");

sessions
  .command("ls")
  .option("-r, --root <dir>", "sessions directory", ".agentrig/sessions")
  .action(async (opts: { root: string }) => {
    const store = new SessionStore({ root: opts.root });
    const refs = await store.list();
    if (refs.length === 0) {
      console.log(`no sessions under ${opts.root}`);
      return;
    }
    for (const r of refs) {
      console.log(`${r.id}\t${new Date(r.updatedAt).toISOString()}\t${r.bytes} B`);
    }
  });

sessions
  .command("show <id>")
  .option("-r, --root <dir>", "sessions directory", ".agentrig/sessions")
  .option("--json", "raw JSONL instead of a timeline")
  .action(async (id: string, opts: { root: string; json?: boolean }) => {
    const store = new SessionStore({ root: opts.root });
    for await (const e of store.read(id)) {
      console.log(opts.json ? JSON.stringify(e) : renderEvent(e));
    }
  });

program.parseAsync(process.argv);
