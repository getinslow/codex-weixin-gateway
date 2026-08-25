import http from "node:http";

export type GatewayStatus = {
  ready: boolean;
  accountId?: string;
  backend?: string;
  startedAt?: number;
  lastInboundAt?: number;
  lastEnqueuedAt?: number;
  lastDequeuedAt?: number;
  lastThreadReadyAt?: number;
  lastAgentStartedAt?: number;
  lastFirstDeltaAt?: number;
  lastAgentCompletedAt?: number;
  lastOutboundAt?: number;
  lastQueueLatencyMs?: number;
  lastAgentDurationMs?: number;
  lastEndToEndMs?: number;
  queueDepth?: number;
  activeWorkers?: number;
  retryCount?: number;
  lastStage?: string;
  lastError?: string;
  [key: string]: unknown;
};

export class HealthServer {
  readonly #host: string;
  readonly #port: number;
  readonly #getStatus: () => GatewayStatus;
  #server?: http.Server;

  constructor(host: string, port: number, getStatus: () => GatewayStatus) {
    this.#host = host;
    this.#port = port;
    this.#getStatus = getStatus;
  }

  async start(): Promise<void> {
    this.#server = http.createServer((request, response) => {
      const status = this.#getStatus();
      if (request.url === "/healthz") {
        response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
        response.end("ok\n");
        return;
      }
      if (request.url === "/readyz") {
        response.writeHead(status.ready ? 200 : 503, {
          "content-type": "text/plain; charset=utf-8",
        });
        response.end(status.ready ? "ready\n" : "not ready\n");
        return;
      }
      if (request.url === "/status") {
        response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        response.end(JSON.stringify(status));
        return;
      }
      response.writeHead(404).end();
    });
    await new Promise<void>((resolve, reject) => {
      this.#server!.once("error", reject);
      this.#server!.listen(this.#port, this.#host, resolve);
    });
  }

  async stop(): Promise<void> {
    if (!this.#server) return;
    await new Promise<void>((resolve, reject) => {
      this.#server!.close((error) => (error ? reject(error) : resolve()));
    });
    this.#server = undefined;
  }

  port(): number | undefined {
    const address = this.#server?.address();
    return address && typeof address === "object" ? address.port : undefined;
  }
}
