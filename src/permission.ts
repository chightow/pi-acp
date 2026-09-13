/**
 * Permission gate: every pi tool call blocks here until KiroCrew answers
 * ACP `session/request_permission`.
 *
 * Contract (matches codex/opencode onboarding):
 * - Default is ask-everything. Nothing is pre-approved.
 * - `allowedTools`/auto vocab is NEVER forwarded to pi — consumed Crew-side.
 * - `allow_always` is cached per (toolName + stable args) in-process only;
 *   a new ACP session starts empty. Deny is never cached.
 * - Cancelled / error / unknown optionId => deny (fail-safe).
 */

export type RequestPermissionFn = (params: {
  sessionId: string;
  toolCallId: string;
  title: string;
  kind: string;
  rawInput: Record<string, any>;
}) => Promise<"once" | "always" | "reject">;

export class PermissionGate {
  private allowAlways = new Set<string>();
  constructor(private request: RequestPermissionFn) {}

  private cacheKey(toolName: string, input: Record<string, any>): string {
    let stable = "";
    try {
      stable = JSON.stringify(input ?? {});
    } catch {
      stable = String(Date.now());
    }
    return `${toolName}::${stable}`;
  }

  async check(
    sessionId: string,
    toolCallId: string,
    toolName: string,
    input: Record<string, any>,
    kind: string,
  ): Promise<{ allowed: boolean; reason?: string }> {
    const key = this.cacheKey(toolName, input);
    if (this.allowAlways.has(key)) return { allowed: true };

    let verdict: "once" | "always" | "reject";
    try {
      verdict = await this.request({
        sessionId,
        toolCallId,
        title: toolName,
        kind,
        rawInput: input,
      });
    } catch {
      return { allowed: false, reason: "permission request failed — denied fail-safe" };
    }

    if (verdict === "once") return { allowed: true };
    if (verdict === "always") {
      this.allowAlways.add(key);
      return { allowed: true };
    }
    return { allowed: false, reason: "Denied by operator" };
  }

  reset() {
    this.allowAlways.clear();
  }
}

/**
 * Classify a pi tool into ACP tool-call `kind` vocabulary.
 *
 * Bridged Crew tools (`mcp__server__tool`) are opaque third-party tools, not
 * shell: they must NOT read `execute`, or the host gate would take the shell
 * branch and deny them as commands it cannot recover. Checked first, because a
 * bridged name can contain `bash`/`read` as a substring (`mcp__srv__bash`).
 */
export function kindForTool(toolName: string): string {
  const n = toolName.toLowerCase();
  if (n.startsWith("mcp__")) return "other";
  if (n.includes("read") || n.includes("ls") || n.includes("grep") || n.includes("find")) {
    return "read";
  }
  if (n.includes("edit") || n.includes("write")) return "edit";
  if (n.includes("bash") || n.includes("shell") || n.includes("powershell")) return "execute";
  return "execute";
}
