import { createComponent, createTextNode } from "@opentui/solid";
import { Plugin } from "@opencode/plugin/tui";
import { createMemo, createSignal, Show } from "solid-js";
import { VibeWallDefinition, type VibeWallSnapshot } from "./rpc.ts";
import { parseWallChanged, parseWallSnapshot } from "./wall.ts";

type SlotInput = { sessionID?: unknown };

type VisibleSnapshot = VibeWallSnapshot & { state: "ok" };

function renderSnapshot(snapshot: VisibleSnapshot): string {
  const rows = (snapshot.workers ?? []).map((worker) => {
    const tool = worker.currentTool ? `tool=${worker.currentTool}` : "tool=unknown";
    const intent = worker.lastIntent ? `intent=${worker.lastIntent}` : "intent=unknown";
    const access = `access=${worker.accessState}`;
    const rate = worker.tokensPerSecond === undefined ? "" : ` · tok/s=${Math.round(worker.tokensPerSecond)}`;
    return `  ${worker.id} [${worker.cli}] ${worker.state} · ${access} · ${tool} · ${intent}${rate}`;
  });
  return [snapshot.text, ...rows].join("\n");
}

export default Plugin.define({
  id: "vibe-station-tui",
  setup(context) {
    const wall = context.client.rpc(VibeWallDefinition);
    const [currentSessionID, setCurrentSessionID] = createSignal("");
    const [snapshot, setSnapshot] = createSignal<VisibleSnapshot>();
    let latestRevision = -1;

    const refresh = async (sessionID: string): Promise<void> => {
      try {
        const value = parseWallSnapshot(await wall.snapshot({ sessionID }), sessionID);
        if (currentSessionID() !== sessionID) return;
        if (!value || value.revision < latestRevision) return;
        latestRevision = value.revision;
        setSnapshot(value.state === "ok" ? value : undefined);
      } catch {
        if (currentSessionID() === sessionID) setSnapshot(undefined);
      }
    };

    const location = context.location?.directory;
    const unsubscribe = wall.events.on("changed", (event: unknown) => {
      const envelope = typeof event === "object" && event !== null ? (event as { data?: unknown; location?: { directory?: unknown } }) : undefined;
      const changed = parseWallChanged(envelope?.data);
      if (!changed || changed.sessionID !== currentSessionID() || changed.revision < latestRevision) return;
      if (location && typeof envelope?.location?.directory === "string" && envelope.location.directory !== location) return;
      void refresh(changed.sessionID);
    });

    const unregister = context.ui.slot({
      append: "prompt.footer.status",
      render(input: SlotInput) {
        const sessionID = typeof input?.sessionID === "string" ? input.sessionID : "";
        if (!sessionID) return null;
        if (currentSessionID() !== sessionID) {
          latestRevision = -1;
          setCurrentSessionID(sessionID);
          void refresh(sessionID);
        }
        const text = createMemo(() => {
          const value = snapshot();
          return value?.sessionID === sessionID ? renderSnapshot(value) : undefined;
        });
        return createComponent(Show, {
          get when() {
            return text() !== undefined;
          },
          get children() {
            const value = text();
            return value ? createTextNode(value) : null;
          },
        });
      },
    });

    return () => {
      unsubscribe();
      unregister();
    };
  },
});
