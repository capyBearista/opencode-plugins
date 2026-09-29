import { describe, expect, test } from "bun:test";
import type {
  AdvisorConsultationInput,
  AdvisorConsultationResult,
  AdvisorService,
} from "./advisor-service.js";
import type { AdvisorConfig, RoutingConfig } from "./config.js";
import type { ModelReference, SessionID } from "./messages.js";
import { acceptsConsultation, createRoutingDomain, isPrimaryDispatch } from "./routing.js";
import type {
  AdvisorRouter,
  DispatchKind,
  RouterAssessment,
  RoutingOpportunity,
  RoutingState,
  RoutingStateCapture,
} from "./routing-types.js";
import type { SerializedEntry } from "./serialize.js";
import type { AssistantBlock } from "./serialize-assistant.js";

const USER = (text: string): SerializedEntry => ({ role: "user", text });

const ASSISTANT = (inFlight: boolean, blocks: readonly AssistantBlock[]): SerializedEntry => ({
  role: "assistant",
  agent: "build",
  model: "opencode/jev-1.13",
  inFlight,
  blocks,
});

const RESULT = (value: string): AssistantBlock => ({
  type: "tool-result",
  id: "call_read",
  name: "read",
  text: value,
});

function routingConfig(overrides: Partial<RoutingConfig> = {}): RoutingConfig {
  return {
    mode: "observe",
    models: ["jev-1.13"],
    advisorWouldHelpThreshold: 0.7,
    consequenceThreshold: 3,
    maxConsultationsPerTurn: 1,
    ...overrides,
  };
}

function configWith(overrides: Partial<RoutingConfig> = {}): AdvisorConfig {
  return { advisor: {}, routing: routingConfig(overrides) };
}

function stateWith(
  entries: readonly SerializedEntry[],
  lastUserMessageID = "msg-user-1",
  executorModel?: ModelReference,
): RoutingStateCapture {
  return { entries, lastUserMessageID, ...(executorModel ? { executorModel } : {}) };
}

function opportunity(
  capture: RoutingStateCapture,
  options: { readonly kind?: DispatchKind; readonly sessionID?: SessionID } = {},
) {
  const counts = { captures: 0 };
  const value: RoutingOpportunity = {
    sessionID: options.sessionID ?? ("ses_1" as SessionID),
    ...(options.kind ? { kind: options.kind } : {}),
    capture: async () => {
      counts.captures += 1;
      return capture;
    },
  };
  return { value, counts };
}

function scripted(answers: readonly (RouterAssessment | Error)[]) {
  const calls: RoutingState[] = [];
  const router: AdvisorRouter = {
    evaluate: async (state) => {
      calls.push(state);
      const answer = answers[Math.min(calls.length - 1, answers.length - 1)];
      if (answer instanceof Error) throw answer;
      if (!answer) throw new Error("scripted router has no answers");
      return answer;
    },
  };
  return { router, calls };
}

function countingService(result: AdvisorConsultationResult | Error = { advice: "check it" }) {
  const calls: AdvisorConsultationInput[] = [];
  const service: AdvisorService = {
    consult: async (input) => {
      calls.push(input);
      if (result instanceof Error) throw result;
      return result;
    },
  };
  return { service, calls };
}

function domain(options: {
  readonly config?: AdvisorConfig | Error;
  readonly router: AdvisorRouter;
  readonly service?: AdvisorService;
}) {
  return createRoutingDomain({
    loadConfig: async () => {
      if (options.config instanceof Error) throw options.config;
      return options.config ?? configWith();
    },
    router: options.router,
    service: options.service ?? { consult: async () => ({ advice: "advice" }) },
  });
}

describe("routing modes", () => {
  test("off skips without evaluating or capturing", async () => {
    const router = scripted([{ advisorWouldHelp: 1, consequence: 4 }]);
    const advisor = countingService();
    const { value, counts } = opportunity(stateWith([USER("hi")]));

    const decision = await domain({
      config: configWith({ mode: "off" }),
      router: router.router,
      service: advisor.service,
    }).observe(value);

    expect(decision).toEqual({ action: "skip", mode: "off" });
    expect(router.calls).toHaveLength(0);
    expect(advisor.calls).toHaveLength(0);
    expect(counts.captures).toBe(0);
  });

  test("observe evaluates and applies policy without consulting the advisor", async () => {
    const router = scripted([{ advisorWouldHelp: 0.8, consequence: 3 }]);
    const advisor = countingService();
    const { value, counts } = opportunity(stateWith([USER("hi")]));

    const decision = await domain({
      config: configWith({ mode: "observe" }),
      router: router.router,
      service: advisor.service,
    }).observe(value);

    expect(decision.action).toBe("accept");
    expect(decision.mode).toBe("observe");
    expect(decision.assessment).toEqual({ advisorWouldHelp: 0.8, consequence: 3 });
    expect(decision.fingerprint).toBeString();
    expect(router.calls).toHaveLength(1);
    expect(advisor.calls).toHaveLength(0);
    expect(counts.captures).toBe(1);
  });

  test("active consults the advisor with the canonical transcript on accept", async () => {
    const router = scripted([{ advisorWouldHelp: 0.9, consequence: 4 }]);
    const advisor = countingService({ advice: "Beware the migration." });
    const { value } = opportunity(stateWith([USER("migrate the schema")]));

    const decision = await domain({
      config: configWith({ mode: "active" }),
      router: router.router,
      service: advisor.service,
    }).observe(value);

    expect(decision.action).toBe("accept");
    expect(decision.mode).toBe("active");
    expect(decision.advice).toBe("Beware the migration.");
    expect(advisor.calls).toHaveLength(1);
    expect(advisor.calls[0]?.transcript).toContain("migrate the schema");
  });
});

describe("opportunity gating", () => {
  test("evaluates primary dispatches, including payloads without kind", async () => {
    const router = scripted([{ advisorWouldHelp: 0.9, consequence: 3 }]);
    const routing = domain({ config: configWith(), router: router.router });

    const withKind = await routing.observe(
      opportunity(stateWith([USER("hi")]), { kind: "primary" }).value,
    );
    const withoutKind = await routing.observe(
      opportunity(stateWith([USER("hi")]), { sessionID: "ses_2" as SessionID }).value,
    );

    expect(withKind.action).toBe("accept");
    expect(withoutKind.action).toBe("accept");
    expect(router.calls).toHaveLength(2);
  });

  test("treats a dispatch without kind as primary", () => {
    expect(isPrimaryDispatch(undefined)).toBe(true);
    expect(isPrimaryDispatch("primary")).toBe(true);
  });

  for (const kind of ["compaction", "title", "generate"] as const) {
    test(`never evaluates ${kind} dispatches`, async () => {
      const router = scripted([{ advisorWouldHelp: 1, consequence: 4 }]);
      const { value, counts } = opportunity(stateWith([USER("hi")]), { kind });

      const decision = await domain({
        config: configWith({ mode: "active" }),
        router: router.router,
      }).observe(value);

      expect(decision.action).toBe("skip");
      expect(decision.mode).toBe("active");
      expect(router.calls).toHaveLength(0);
      expect(counts.captures).toBe(0);
      expect(isPrimaryDispatch(kind)).toBe(false);
    });
  }
});

describe("fingerprint suppression", () => {
  test("suppresses an identical opportunity after one evaluation", async () => {
    const router = scripted([{ advisorWouldHelp: 0.9, consequence: 3 }]);
    const routing = domain({ config: configWith(), router: router.router });
    const first = opportunity(stateWith([USER("hi")]));
    const second = opportunity(stateWith([USER("hi")]));

    const accepted = await routing.observe(first.value);
    const suppressed = await routing.observe(second.value);

    expect(accepted.action).toBe("accept");
    expect(suppressed.action).toBe("suppress");
    expect(suppressed.fingerprint).toBe(accepted.fingerprint);
    expect(router.calls).toHaveLength(1);
    expect(second.counts.captures).toBe(1);
  });

  test("evaluates again when a tool result materially changes", async () => {
    const router = scripted([{ advisorWouldHelp: 0.9, consequence: 3 }]);
    const routing = domain({
      config: configWith({ maxConsultationsPerTurn: 2 }),
      router: router.router,
    });

    const before = await routing.observe(
      opportunity(stateWith([USER("hi"), ASSISTANT(false, [RESULT("old")])])).value,
    );
    const after = await routing.observe(
      opportunity(stateWith([USER("hi"), ASSISTANT(false, [RESULT("new")])])).value,
    );

    expect(before.action).toBe("accept");
    expect(after.action).toBe("accept");
    expect(after.fingerprint).not.toBe(before.fingerprint);
    expect(router.calls).toHaveLength(2);
  });

  test("origin advisor entries do not create a new opportunity", async () => {
    const material = [USER("hi"), ASSISTANT(false, [RESULT("old")])];
    const injected: SerializedEntry[] = [
      ...material,
      { role: "system", text: "automatic advice", origin: "advisor" },
    ];
    const router = scripted([{ advisorWouldHelp: 0.9, consequence: 3 }]);
    const routing = domain({ config: configWith(), router: router.router });

    const before = await routing.observe(opportunity(stateWith(material)).value);
    const after = await routing.observe(opportunity(stateWith(injected)).value);

    expect(before.action).toBe("accept");
    expect(after.action).toBe("suppress");
    expect(router.calls).toHaveLength(1);
  });
});

describe("policy", () => {
  test("uses the configured thresholds, not hard-coded values", () => {
    const strict = routingConfig();
    expect(acceptsConsultation(strict, { advisorWouldHelp: 0.7, consequence: 3 })).toBe(true);
    expect(acceptsConsultation(strict, { advisorWouldHelp: 0.6999, consequence: 3 })).toBe(false);
    expect(acceptsConsultation(strict, { advisorWouldHelp: 1, consequence: 2 })).toBe(false);

    const relaxed = routingConfig({ advisorWouldHelpThreshold: 0.5, consequenceThreshold: 2 });
    expect(acceptsConsultation(relaxed, { advisorWouldHelp: 0.6, consequence: 2 })).toBe(true);
  });

  test("reads thresholds from live configuration for every opportunity", async () => {
    const configs = [
      configWith(),
      configWith({ advisorWouldHelpThreshold: 0.5, consequenceThreshold: 2 }),
    ];
    let loads = 0;
    const router = scripted([{ advisorWouldHelp: 0.6, consequence: 2 }]);
    const routing = createRoutingDomain({
      loadConfig: async () => configs[Math.min(loads++, configs.length - 1)] as AdvisorConfig,
      router: router.router,
      service: { consult: async () => ({ advice: "x" }) },
    });

    const strict = await routing.observe(opportunity(stateWith([USER("first")])).value);
    const relaxed = await routing.observe(
      opportunity(stateWith([USER("second")], "msg-user-2")).value,
    );

    expect(strict.action).toBe("reject");
    expect(relaxed.action).toBe("accept");
  });
});

describe("router result normalization", () => {
  test("clamps out-of-range probabilities before policy", async () => {
    const high = scripted([{ advisorWouldHelp: 1.5, consequence: 3 }]);
    const accepted = await domain({
      config: configWith({ mode: "active" }),
      router: high.router,
    }).observe(opportunity(stateWith([USER("hi")])).value);
    expect(accepted.action).toBe("accept");
    expect(accepted.assessment?.advisorWouldHelp).toBe(1);

    const low = scripted([{ advisorWouldHelp: -0.5, consequence: 4 }]);
    const rejected = await domain({
      config: configWith({ mode: "active" }),
      router: low.router,
    }).observe(opportunity(stateWith([USER("hi")])).value);
    expect(rejected.action).toBe("reject");
    expect(rejected.assessment?.advisorWouldHelp).toBe(0);
  });

  test("rejects invalid consequences as a router error and fails open", async () => {
    for (const consequence of [2.5, -1, 5]) {
      const router = scripted([{ advisorWouldHelp: 0.9, consequence }]);
      const advisor = countingService();
      const decision = await domain({
        config: configWith({ mode: "active" }),
        router: router.router,
        service: advisor.service,
      }).observe(opportunity(stateWith([USER("hi")])).value);

      expect(decision.action).toBe("fail");
      expect(decision.error).toBeString();
      expect(advisor.calls).toHaveLength(0);
    }
  });

  test("fails open on non-numeric probabilities without consuming the attempt", async () => {
    const router = scripted([
      { advisorWouldHelp: Number.NaN, consequence: 3 },
      { advisorWouldHelp: 0.9, consequence: 4 },
    ]);
    const advisor = countingService();
    const routing = domain({
      config: configWith({ mode: "active" }),
      router: router.router,
      service: advisor.service,
    });

    const failed = await routing.observe(opportunity(stateWith([USER("hi")])).value);
    expect(failed.action).toBe("fail");

    const retried = await routing.observe(
      opportunity(stateWith([USER("hi"), ASSISTANT(false, [RESULT("done")])])).value,
    );
    expect(retried.action).toBe("accept");
    expect(advisor.calls).toHaveLength(1);
  });

  test("suppresses a retry of the same state after a router error", async () => {
    const router = scripted([new Error("router unavailable")]);
    const routing = domain({ config: configWith(), router: router.router });

    const failed = await routing.observe(opportunity(stateWith([USER("hi")])).value);
    const again = await routing.observe(opportunity(stateWith([USER("hi")])).value);

    expect(failed.action).toBe("fail");
    expect(failed.error).toContain("router unavailable");
    expect(again.action).toBe("suppress");
    expect(router.calls).toHaveLength(1);
  });
});

describe("automatic consultation budget", () => {
  test("consumes one attempt per turn and denies the next accepted opportunity", async () => {
    const router = scripted([
      { advisorWouldHelp: 0.9, consequence: 4 },
      { advisorWouldHelp: 0.9, consequence: 4 },
    ]);
    const advisor = countingService();
    const routing = domain({
      config: configWith({ mode: "active" }),
      router: router.router,
      service: advisor.service,
    });

    const first = await routing.observe(
      opportunity(stateWith([USER("hi"), ASSISTANT(false, [RESULT("one")])])).value,
    );
    const second = await routing.observe(
      opportunity(stateWith([USER("hi"), ASSISTANT(false, [RESULT("two")])])).value,
    );

    expect(first.action).toBe("accept");
    expect(second.action).toBe("deny");
    expect(second.assessment).toEqual({ advisorWouldHelp: 0.9, consequence: 4 });
    expect(advisor.calls).toHaveLength(1);
    expect(router.calls).toHaveLength(2);
  });

  test("consumes the attempt even when the automatic consultation fails", async () => {
    const router = scripted([
      { advisorWouldHelp: 0.9, consequence: 4 },
      { advisorWouldHelp: 0.9, consequence: 4 },
    ]);
    const advisor = countingService(new Error("provider exploded"));
    const routing = domain({
      config: configWith({ mode: "active" }),
      router: router.router,
      service: advisor.service,
    });

    const failed = await routing.observe(
      opportunity(stateWith([USER("hi"), ASSISTANT(false, [RESULT("one")])])).value,
    );
    const denied = await routing.observe(
      opportunity(stateWith([USER("hi"), ASSISTANT(false, [RESULT("two")])])).value,
    );

    expect(failed.action).toBe("fail");
    expect(failed.error).toContain("provider exploded");
    expect(denied.action).toBe("deny");
    expect(advisor.calls).toHaveLength(1);
  });

  test("applies the budget hypothetically in observe mode", async () => {
    const router = scripted([
      { advisorWouldHelp: 0.9, consequence: 4 },
      { advisorWouldHelp: 0.9, consequence: 4 },
    ]);
    const advisor = countingService();
    const routing = domain({
      config: configWith({ mode: "observe" }),
      router: router.router,
      service: advisor.service,
    });

    const first = await routing.observe(
      opportunity(stateWith([USER("hi"), ASSISTANT(false, [RESULT("one")])])).value,
    );
    const second = await routing.observe(
      opportunity(stateWith([USER("hi"), ASSISTANT(false, [RESULT("two")])])).value,
    );

    expect(first.action).toBe("accept");
    expect(second.action).toBe("deny");
    expect(advisor.calls).toHaveLength(0);
  });

  test("tracks budget independently per session", async () => {
    const router = scripted([{ advisorWouldHelp: 0.9, consequence: 4 }]);
    const advisor = countingService();
    const routing = domain({
      config: configWith({ mode: "active" }),
      router: router.router,
      service: advisor.service,
    });

    const first = await routing.observe(opportunity(stateWith([USER("hi")])).value);
    const other = await routing.observe(
      opportunity(stateWith([USER("hi")]), { sessionID: "ses_2" as SessionID }).value,
    );

    expect(first.action).toBe("accept");
    expect(other.action).toBe("accept");
    expect(advisor.calls).toHaveLength(2);
  });
});

describe("turn identity", () => {
  test("keeps one turn across tool-driven continuations of the same user message", async () => {
    const router = scripted([
      { advisorWouldHelp: 0.9, consequence: 4 },
      { advisorWouldHelp: 0.9, consequence: 4 },
    ]);
    const advisor = countingService();
    const routing = domain({
      config: configWith({ mode: "active" }),
      router: router.router,
      service: advisor.service,
    });

    const first = await routing.observe(opportunity(stateWith([USER("hi")])).value);
    const continuation = await routing.observe(
      opportunity(stateWith([USER("hi"), ASSISTANT(false, [RESULT("tool done")])])).value,
    );
    const newTurn = await routing.observe(
      opportunity(stateWith([USER("again")], "msg-user-2")).value,
    );

    expect(first.action).toBe("accept");
    expect(continuation.action).toBe("deny");
    expect(newTurn.action).toBe("accept");
    expect(advisor.calls).toHaveLength(2);
  });
});

describe("fail-open behavior", () => {
  test("capture failures fail open without consuming the budget", async () => {
    const router = scripted([{ advisorWouldHelp: 0.9, consequence: 4 }]);
    const advisor = countingService();
    const routing = domain({
      config: configWith({ mode: "active" }),
      router: router.router,
      service: advisor.service,
    });

    const broken: RoutingOpportunity = {
      sessionID: "ses_1" as SessionID,
      capture: async () => {
        throw new Error("session read failed");
      },
    };

    const failed = await routing.observe(broken);
    expect(failed.action).toBe("fail");
    expect(failed.error).toContain("session read failed");
    expect(router.calls).toHaveLength(0);

    const recovered = await routing.observe(opportunity(stateWith([USER("hi")])).value);
    expect(recovered.action).toBe("accept");
    expect(advisor.calls).toHaveLength(1);
  });

  test("configuration failures fail open without capturing", async () => {
    const router = scripted([{ advisorWouldHelp: 0.9, consequence: 4 }]);
    const { value, counts } = opportunity(stateWith([USER("hi")]));

    const decision = await domain({
      config: new Error("configuration unreadable"),
      router: router.router,
    }).observe(value);

    expect(decision.action).toBe("fail");
    expect(decision.mode).toBeUndefined();
    expect(decision.error).toContain("configuration unreadable");
    expect(router.calls).toHaveLength(0);
    expect(counts.captures).toBe(0);
  });
});
