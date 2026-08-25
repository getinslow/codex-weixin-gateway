import path from "node:path";
import readline from "node:readline";

const input = readline.createInterface({ input: process.stdin });
let nextThread = 1;
let nextTurn = 1;

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

input.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({
      id: message.id,
      result: {
        userAgent: "fake-app-server",
        codexHome: process.cwd(),
        platformFamily: process.platform,
        platformOs: process.platform,
      },
    });
    return;
  }
  if (message.method === "initialized") return;
  if (message.method === "thread/start") {
    const threadId = `thread-${nextThread++}`;
    send({ id: message.id, result: { thread: { id: threadId } } });
    send({ method: "thread/started", params: { thread: { id: threadId } } });
    return;
  }
  if (message.method === "thread/resume") {
    if (Object.hasOwn(message.params ?? {}, "excludeTurns")) {
      send({
        id: message.id,
        error: { code: -32602, message: "thread/resume.excludeTurns requires experimentalApi" },
      });
      return;
    }
    send({ id: message.id, result: { thread: { id: message.params.threadId } } });
    return;
  }
  if (message.method === "turn/start") {
    const turnId = `turn-${nextTurn++}`;
    const threadId = message.params.threadId;
    const answer = `fake reply ${turnId} thread=${threadId} cwd=${message.params.cwd} sandbox=${JSON.stringify(message.params.sandboxPolicy ?? null)}`;
    const wantsImage = JSON.stringify(message.params.input ?? []).includes("generate image");
    const imageItem = wantsImage
      ? {
          type: "imageGeneration",
          id: `image-${turnId}`,
          status: "completed",
          revisedPrompt: null,
          result: "",
          failure: null,
          savedPath: path.join(message.params.cwd, "fake-generated.png"),
        }
      : undefined;
    send({
      id: message.id,
      result: { turn: { id: turnId, status: "inProgress", items: [] } },
    });
    setTimeout(() => {
      if (imageItem) {
        send({
          method: "item/completed",
          params: { threadId, turnId, completedAtMs: Date.now(), item: imageItem },
        });
      }
      send({
        method: "item/agentMessage/delta",
        params: { threadId, turnId, itemId: `item-${turnId}`, delta: answer },
      });
      send({
        method: "item/completed",
        params: {
          threadId,
          turnId,
          completedAtMs: Date.now(),
          item: {
            type: "agentMessage",
            id: `item-${turnId}`,
            text: answer,
            phase: "final_answer",
            memoryCitation: null,
          },
        },
      });
      send({
        method: "turn/completed",
        params: {
          threadId,
          turn: {
            id: turnId,
            status: "completed",
            items: imageItem ? [imageItem] : [],
            error: null,
          },
        },
      });
    }, turnId.endsWith("1") ? 30 : 5);
    return;
  }
  if (message.method === "turn/interrupt") {
    send({ id: message.id, result: {} });
    return;
  }
  if (message.id !== undefined) {
    send({ id: message.id, error: { code: -32601, message: "unsupported fake method" } });
  }
});
