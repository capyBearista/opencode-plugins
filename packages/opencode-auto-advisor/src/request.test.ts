import { describe, expect, test } from "bun:test";
import type { SessionContext } from "@opencode/plugin/promise/session";
import { routingFingerprint } from "./fingerprint.js";
import { captureAssembledRequest, turnKeyForHistory } from "./request.js";

type Message = SessionContext["messages"][number];

function request(overrides: Partial<SessionContext> = {}): SessionContext {
  return {
    sessionID: "ses_1",
    model: { providerID: "opencode", id: "jev-1.13" },
    system: [],
    messages: [],
    options: {},
    agent: "build",
    tools: {},
    ...overrides,
  } as SessionContext;
}

function text(value: string) {
  return { type: "text", text: value };
}

function assistant(content: unknown[], id = "msg-assistant"): Message {
  return { id, role: "assistant", content } as Message;
}

function user(content: unknown[], id = "msg-user"): Message {
  return { id, role: "user", content } as Message;
}

function anonymousUser(content: unknown[]): Message {
  return { role: "user", content } as unknown as Message;
}

describe("captureAssembledRequest", () => {
  test("serializes system parts as canonical system entries", () => {
    const captured = captureAssembledRequest(
      request({ system: [{ type: "text", text: "You are a helpful agent" }] as never }),
    );

    expect(captured.entries).toEqual([{ role: "system", text: "You are a helpful agent" }]);
  });

  test("serializes the assembled messages, including tool calls, results and tool messages", () => {
    const captured = captureAssembledRequest(
      request({
        messages: [
          user([text("Fix the bug")]),
          assistant([
            text("Looking at it"),
            { type: "tool-call", id: "call_1", name: "read", input: { path: "src/a.ts" } },
          ]),
          {
            id: "msg-tool",
            role: "tool",
            content: [
              {
                type: "tool-result",
                id: "call_1",
                name: "read",
                result: { type: "text", value: "file body" },
              },
            ],
          } as Message,
        ] as never,
      }),
    );

    expect(captured.entries).toEqual([
      { role: "user", text: "Fix the bug" },
      {
        role: "assistant",
        agent: "build",
        model: "opencode/jev-1.13",
        inFlight: false,
        blocks: [
          { type: "text", text: "Looking at it" },
          {
            type: "tool-call",
            id: "call_1",
            name: "read",
            status: "running",
            input: { path: "src/a.ts" },
          },
        ],
      },
      {
        role: "tool",
        blocks: [{ type: "tool-result", id: "call_1", name: "read", text: "file body" }],
      },
    ]);
  });

  test("preserves unknown assembled parts as type-only markers and changes the fingerprint", () => {
    const unknown = { type: "future-part", payload: "SECRET-PAYLOAD" };
    const changed = captureAssembledRequest(
      request({
        messages: [user([text("look"), unknown]), assistant([text("ok"), unknown])] as never,
      }),
    );
    const known = captureAssembledRequest(
      request({ messages: [user([text("look")]), assistant([text("ok")])] as never }),
    );
    const other = captureAssembledRequest(
      request({
        messages: [user([text("look")]), assistant([text("ok"), { type: "other-part" }])] as never,
      }),
    );

    expect(changed.entries).toEqual([
      { role: "user", text: "look" },
      { role: "marker", type: "unknown", detail: "future-part" },
      {
        role: "assistant",
        agent: "build",
        model: "opencode/jev-1.13",
        inFlight: false,
        blocks: [
          { type: "text", text: "ok" },
          { type: "marker", marker: "unknown", detail: "future-part" },
        ],
      },
    ]);
    expect(JSON.stringify(changed.entries)).not.toContain("SECRET-PAYLOAD");
    expect(routingFingerprint(changed.entries)).not.toBe(routingFingerprint(known.entries));
    expect(routingFingerprint(changed.entries)).not.toBe(routingFingerprint(other.entries));
    expect(known.entries).toEqual([
      { role: "user", text: "look" },
      {
        role: "assistant",
        agent: "build",
        model: "opencode/jev-1.13",
        inFlight: false,
        blocks: [{ type: "text", text: "ok" }],
      },
    ]);
  });

  test("hook-event mutations change the captured state and its fingerprint", () => {
    const persisted = request({
      system: [{ type: "text", text: "base system" }] as never,
      messages: [user([text("Fix the bug")])] as never,
    });
    const mutated = request({
      system: [{ type: "text", text: "hook-time system mutation" }] as never,
      messages: [
        user([text("Fix the bug")]),
        assistant([text("hook-time assistant mutation")]),
      ] as never,
    });

    const base = captureAssembledRequest(persisted);
    const changed = captureAssembledRequest(mutated);

    expect(changed.entries).not.toEqual(base.entries);
    expect(routingFingerprint(changed.entries)).not.toBe(routingFingerprint(base.entries));
    expect(JSON.stringify(changed.entries)).toContain("hook-time system mutation");
    expect(JSON.stringify(changed.entries)).toContain("hook-time assistant mutation");
  });

  test("keys the turn from the last user message id, falling back to content identity", () => {
    const identified = captureAssembledRequest(
      request({
        messages: [user([text("first")], "msg-a"), user([text("second")], "msg-b")] as never,
      }),
    );
    const unidentified = captureAssembledRequest(
      request({ messages: [anonymousUser([text("second")])] as never }),
    );
    const repeated = captureAssembledRequest(
      request({ messages: [anonymousUser([text("second")])] as never }),
    );

    expect(identified.turnKey).toBe("msg-b");
    expect(unidentified.turnKey).toBe(repeated.turnKey);
    expect(unidentified.turnKey).not.toBe("msg-b");
    expect(unidentified.turnKey.startsWith("content:")).toBe(true);
  });

  test("disambiguates identical id-less user turns by message position", () => {
    const first = captureAssembledRequest(
      request({ messages: [anonymousUser([text("same")])] as never }),
    );
    const second = captureAssembledRequest(
      request({
        messages: [
          anonymousUser([text("same")]),
          assistant([text("ok")]),
          anonymousUser([text("same")]),
        ] as never,
      }),
    );
    const continuation = captureAssembledRequest(
      request({
        messages: [anonymousUser([text("same")]), assistant([text("partial")])] as never,
      }),
    );

    expect(first.turnKey).not.toBe(second.turnKey);
    expect(continuation.turnKey).toBe(first.turnKey);
  });

  test("keys durable history with the same identity namespaces as the assembled request", () => {
    const identified = captureAssembledRequest(
      request({ messages: [user([text("hi")], "msg-1")] as never }),
    );
    const idless = captureAssembledRequest(
      request({ messages: [anonymousUser([text("hi")])] as never }),
    );
    const preUser = captureAssembledRequest(request());

    expect(
      turnKeyForHistory({
        entries: [{ role: "user", text: "hi" }],
        messageIDs: ["msg-1"],
        transcript: "",
      }),
    ).toBe(identified.turnKey);
    expect(
      turnKeyForHistory({
        entries: [{ role: "user", text: "hi" }],
        messageIDs: [""],
        transcript: "",
      }),
    ).toBe(idless.turnKey);
    expect(turnKeyForHistory({ entries: [], messageIDs: [], transcript: "" })).toBe(
      preUser.turnKey,
    );
  });

  test("carries the assembled request model and sanitizes request media", () => {
    const captured = captureAssembledRequest(
      request({
        model: { providerID: "opencode", id: "jev-1.14", variant: "fast" } as never,
        messages: [
          user([
            text("see attached"),
            {
              type: "media",
              media: {
                source: {
                  type: "url",
                  url: "https://cdn.example.com/a/signed.png?token=SECRET#frag",
                },
                mediaType: "image/png",
              },
              filename: "signed.png",
            },
          ]),
        ] as never,
      }),
    );

    expect(captured.executorModel).toEqual({
      providerID: "opencode",
      id: "jev-1.14",
      variant: "fast",
    });
    expect(captured.entries).toEqual([
      {
        role: "user",
        text: "see attached",
        media: [
          {
            kind: "image",
            mime: "image/png",
            name: "signed.png",
            source: { type: "uri", uri: "https://cdn.example.com/a/signed.png" },
            inspected: false,
          },
        ],
      },
    ]);
    expect(JSON.stringify(captured.entries)).not.toContain("SECRET");
  });

  test("reduces a path-like request media filename to its leaf", () => {
    const captured = captureAssembledRequest(
      request({
        messages: [
          user([
            text("see attached"),
            {
              type: "media",
              media: {
                source: { type: "base64", data: "aGVsbG8=", mediaType: "application/pdf" },
                mediaType: "application/pdf",
              },
              filename: "/home/user/secret-project/report.pdf",
            },
          ]),
        ] as never,
      }),
    );

    const media = (captured.entries[0] as { media?: Array<{ name?: string }> }).media;
    expect(media?.[0]?.name).toBe("report.pdf");
    expect(JSON.stringify(captured.entries)).not.toContain("secret-project");
  });

  test("never serializes inline base64 request media", () => {
    const payload = "aGVsbG8tc2VjcmV0LXBheWxvYWQ=";
    const captured = captureAssembledRequest(
      request({
        messages: [
          user([
            text("see inline"),
            {
              type: "media",
              media: {
                source: { type: "base64", data: payload, mediaType: "image/png" },
                mediaType: "image/png",
              },
              filename: "inline.png",
            },
          ]),
        ] as never,
      }),
    );

    expect(captured.entries[0]).toEqual({
      role: "user",
      text: "see inline",
      media: [
        {
          kind: "image",
          mime: "image/png",
          name: "inline.png",
          source: { type: "inline" },
          inspected: false,
        },
      ],
    });
    expect(JSON.stringify(captured.entries)).not.toContain(payload);
  });

  test("keys a pre-user request by its serialized content instead of an empty key", () => {
    const one = captureAssembledRequest(request({ messages: [assistant([text("hi")])] as never }));
    const same = captureAssembledRequest(request({ messages: [assistant([text("hi")])] as never }));
    const other = captureAssembledRequest(
      request({ messages: [assistant([text("different")])] as never }),
    );

    expect(one.turnKey).not.toBe("");
    expect(one.turnKey.startsWith("content:no-user:")).toBe(true);
    expect(one.turnKey).toBe(same.turnKey);
    expect(one.turnKey).not.toBe(other.turnKey);
  });
});
