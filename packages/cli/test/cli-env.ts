/** Real CLI fixtures must not select operator profiles or isolated tool homes. */
export function cliEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...source };
  for (const key of ["AGENTRIG_CHILD_PROFILE", "CODEX_HOME", "CLAUDE_CONFIG_DIR"]) delete env[key];
  return env;
}
