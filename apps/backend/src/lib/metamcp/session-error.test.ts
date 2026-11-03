import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";

import {
  isBackendSessionLostError,
  isBackendTransportLostError,
  isRecoverableBackendError,
} from "./session-error";

describe("isBackendSessionLostError", () => {
  it("matches the HTTP 404 + JSON-RPC -32600 envelope the SDK produces", () => {
    const error = new Error(
      'Error POSTing to endpoint (HTTP 404): {"jsonrpc":"2.0","id":"server-error","error":{"code":-32600,"message":"Session not found"}}',
    );
    expect(isBackendSessionLostError(error)).toBe(true);
  });

  it("matches the HTTP 404 + JSON-RPC -32001 variant some servers return", () => {
    const error = new Error(
      'Error POSTing to endpoint (HTTP 404): {"error":{"code":-32001,"message":"Session not found"},"id":"","jsonrpc":"2.0"}',
    );
    expect(isBackendSessionLostError(error)).toBe(true);
  });

  it("does not match unrelated 404s", () => {
    const error = new Error("Error POSTing to endpoint (HTTP 404): Not Found");
    expect(isBackendSessionLostError(error)).toBe(false);
  });

  it("does not match transport disconnects (transport-lost detector handles those)", () => {
    const error = new Error("Not connected");
    expect(isBackendSessionLostError(error)).toBe(false);
  });

  it("returns false for null / undefined", () => {
    expect(isBackendSessionLostError(undefined)).toBe(false);
    expect(isBackendSessionLostError(null)).toBe(false);
  });

  it("returns false for unrelated strings", () => {
    expect(isBackendSessionLostError("Session not found")).toBe(false);
    expect(isBackendSessionLostError("HTTP 404")).toBe(false);
    expect(isBackendSessionLostError("random text")).toBe(false);
  });

  it("matches a string throwable carrying the full envelope", () => {
    const message =
      'Error POSTing to endpoint (HTTP 404): {"jsonrpc":"2.0","error":{"code":-32600,"message":"Session not found"}}';
    expect(isBackendSessionLostError(message)).toBe(true);
  });

  it("matches when the session-lost error is wrapped via .cause", () => {
    const inner = new Error(
      'Error POSTing to endpoint (HTTP 404): {"jsonrpc":"2.0","error":{"code":-32600,"message":"Session not found"}}',
    );
    const outer = new Error("Failed to dispatch tool call", { cause: inner });
    expect(isBackendSessionLostError(outer)).toBe(true);
  });

  it("matches when wrapped two layers deep via .cause", () => {
    const innermost = new Error(
      'Error POSTing to endpoint (HTTP 404): {"jsonrpc":"2.0","error":{"code":-32001,"message":"Session not found"}}',
    );
    const mid = new Error("Transport rejection", { cause: innermost });
    const outer = new Error("Outer wrap", { cause: mid });
    expect(isBackendSessionLostError(outer)).toBe(true);
  });

  it("matches a JSON-RPC error envelope passed as a plain object", () => {
    // Some rejection paths surface the parsed RPC error envelope directly
    // rather than the SDK's wrapped Error. The detector inspects the
    // structured payload as well as the rendered message.
    const envelope = {
      jsonrpc: "2.0",
      id: "server-error",
      error: { code: -32600, message: "Session not found" },
    };
    expect(isBackendSessionLostError(envelope)).toBe(true);
  });

  it("matches an Error whose .code carries -32001 even when the message is sparse", () => {
    const error = Object.assign(new Error("Session not found"), {
      code: -32001,
    });
    expect(isBackendSessionLostError(error)).toBe(true);
  });

  it("falls back to String(error) for objects with only toString()", () => {
    class CustomThrowable {
      toString() {
        return 'Error POSTing to endpoint (HTTP 404): {"error":{"code":-32600,"message":"Session not found"}}';
      }
    }
    expect(isBackendSessionLostError(new CustomThrowable())).toBe(true);
  });

  it("does not match objects with unrelated -32600 contexts", () => {
    // -32600 alone (without 'Session not found') is the JSON-RPC "Invalid
    // Request" code and means many things. Don't false-positive on it.
    const error = new Error("MCP error -32600: Invalid Request");
    expect(isBackendSessionLostError(error)).toBe(false);
  });

  it("handles circular cause chains without infinite-looping", () => {
    const a = new Error("Wrapper a") as Error & { cause?: unknown };
    const b = new Error("Wrapper b") as Error & { cause?: unknown };
    a.cause = b;
    b.cause = a;
    expect(isBackendSessionLostError(a)).toBe(false);
  });
});

describe("isBackendTransportLostError", () => {
  it("matches the bare SDK 'Not connected' Error", () => {
    // Protocol.request() in the MCP TS SDK rejects with exactly this
    // message when the underlying transport has been torn down.
    const error = new Error("Not connected");
    expect(isBackendTransportLostError(error)).toBe(true);
  });

  it("matches a 'Not connected' string throwable", () => {
    expect(isBackendTransportLostError("Not connected")).toBe(true);
  });

  it("matches the consumer-side -32603 envelope MetaMCP returns to Claude.ai / n8n", () => {
    // Production observation 2026-05-14: consumer-side connectors see
    // the tRPC bridge's wrapped envelope rather than the raw SDK Error.
    const envelope = {
      jsonrpc: "2.0",
      id: "server-error",
      error: { code: -32603, message: "Not connected" },
    };
    expect(isBackendTransportLostError(envelope)).toBe(true);
  });

  it("matches when the transport-lost error is wrapped via .cause", () => {
    const inner = new Error("Not connected");
    const outer = new Error("Tool dispatch rejected", { cause: inner });
    expect(isBackendTransportLostError(outer)).toBe(true);
  });

  it("matches when wrapped two layers deep via .cause", () => {
    const innermost = new Error("Not connected");
    const mid = new Error("Transport adapter rejection", { cause: innermost });
    const outer = new Error("Outer wrap", { cause: mid });
    expect(isBackendTransportLostError(outer)).toBe(true);
  });

  it("matches Error with .code -32603 + 'Not connected' message", () => {
    const error = Object.assign(new Error("Not connected"), { code: -32603 });
    expect(isBackendTransportLostError(error)).toBe(true);
  });

  it("does not false-positive on unrelated -32603 'Internal error' envelopes", () => {
    // Bare -32603 is JSON-RPC "Internal error" and covers many flows.
    // Detector only fires when paired with the 'Not connected' marker.
    const envelope = {
      jsonrpc: "2.0",
      id: "x",
      error: { code: -32603, message: "Internal error" },
    };
    expect(isBackendTransportLostError(envelope)).toBe(false);
  });

  it("does not match session-not-found envelopes (those go to the session-lost detector)", () => {
    const error = new Error(
      'Error POSTing to endpoint (HTTP 404): {"jsonrpc":"2.0","error":{"code":-32600,"message":"Session not found"}}',
    );
    expect(isBackendTransportLostError(error)).toBe(false);
  });

  it("returns false for null / undefined / unrelated strings", () => {
    expect(isBackendTransportLostError(undefined)).toBe(false);
    expect(isBackendTransportLostError(null)).toBe(false);
    expect(isBackendTransportLostError("just some text")).toBe(false);
    expect(isBackendTransportLostError(new Error("Timeout"))).toBe(false);
  });

  it("handles circular .cause chains without infinite-looping", () => {
    const a = new Error("Wrapper a") as Error & { cause?: unknown };
    const b = new Error("Wrapper b") as Error & { cause?: unknown };
    a.cause = b;
    b.cause = a;
    expect(isBackendTransportLostError(a)).toBe(false);
  });

  it("falls back to String(error) for custom throwables", () => {
    class CustomTransportError {
      toString() {
        return "Not connected";
      }
    }
    expect(isBackendTransportLostError(new CustomTransportError())).toBe(true);
  });
});

describe("isRecoverableBackendError", () => {
  it("fires on session-not-found envelopes", () => {
    const error = new Error(
      'Error POSTing to endpoint (HTTP 404): {"jsonrpc":"2.0","error":{"code":-32600,"message":"Session not found"}}',
    );
    expect(isRecoverableBackendError(error)).toBe(true);
  });

  it("fires on transport-disconnect envelopes", () => {
    expect(isRecoverableBackendError(new Error("Not connected"))).toBe(true);
  });

  it("fires on the consumer-side -32603 envelope (2026-05-14 production case)", () => {
    const envelope = {
      jsonrpc: "2.0",
      id: "server-error",
      error: { code: -32603, message: "Not connected" },
    };
    expect(isRecoverableBackendError(envelope)).toBe(true);
  });

  it("does not false-positive on unrelated errors", () => {
    expect(isRecoverableBackendError(new Error("Timeout"))).toBe(false);
    expect(isRecoverableBackendError(undefined)).toBe(false);
    expect(
      isRecoverableBackendError({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal error" },
      }),
    ).toBe(false);
  });
});

// INFRA-36: a timed-out call may still be running on the backend, so it must
// not invalidate the pool or get replayed.
describe("SDK request timeouts", () => {
  async function realTimeoutError(): Promise<unknown> {
    const server = new Server(
      { name: "hanging", version: "1.0.0" },
      { capabilities: { tools: {} } },
    );
    server.setRequestHandler(
      CallToolRequestSchema,
      () => new Promise(() => {}),
    );
    const client = new Client({ name: "test", version: "1.0.0" });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    try {
      return await client
        .callTool({ name: "send", arguments: {} }, undefined, { timeout: 5 })
        .then(
          () => undefined,
          (error: unknown) => error,
        );
    } finally {
      await client.close();
    }
  }

  it("does not treat a timeout raised by a real SDK client as recoverable", async () => {
    const error = await realTimeoutError();
    expect((error as McpError).code).toBe(ErrorCode.RequestTimeout);
    expect(isBackendSessionLostError(error)).toBe(false);
    expect(isRecoverableBackendError(error)).toBe(false);
  });

  it("does not treat the maximum total timeout as recoverable", () => {
    const error = new McpError(
      ErrorCode.RequestTimeout,
      "Maximum total timeout exceeded",
      { maxTotalTimeout: 60000, totalElapsed: 60001 },
    );
    expect(isRecoverableBackendError(error)).toBe(false);
  });

  it("does not match a timeout wrapped via .cause", () => {
    const inner = new McpError(ErrorCode.RequestTimeout, "Request timed out", {
      timeout: 60000,
    });
    const outer = new Error("Tool call failed", { cause: inner });
    expect(isRecoverableBackendError(outer)).toBe(false);
  });

  it("does not match a timeout passed as a plain object", () => {
    expect(
      isRecoverableBackendError({ code: -32001, message: "Request timed out" }),
    ).toBe(false);
    expect(
      isRecoverableBackendError({ code: "-32001", data: { timeout: 60000 } }),
    ).toBe(false);
  });

  it("still treats a session-not-found -32001 as session loss", () => {
    const error = new McpError(-32001, "Session not found");
    expect(isRecoverableBackendError(error)).toBe(true);
    expect(isRecoverableBackendError({ code: -32001 })).toBe(true);
  });

  it("does not replay a call whose connection closed mid-flight", () => {
    const error = new McpError(ErrorCode.ConnectionClosed, "Connection closed");
    expect(isRecoverableBackendError(error)).toBe(false);
  });
});
