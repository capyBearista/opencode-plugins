import type { ModelReference } from "./messages.js";

export const ADVISOR_RESERVE_FRACTION = 0.25;

export interface ModelLimitEntry {
  readonly id?: string;
  readonly providerID: string;
  readonly modelID: string;
  readonly limit: {
    readonly context: number;
    readonly input?: number;
    readonly output: number;
  };
}

export interface ModelLimits {
  readonly context: number;
  readonly input?: number;
  readonly output: number;
}

export interface ModelCatalog {
  readonly list: () => Promise<{ readonly data?: readonly ModelLimitEntry[] }>;
}

export type ModelLimitResolver = (model: ModelReference) => Promise<ModelLimits | undefined>;

export function createModelLimitResolver(catalog?: ModelCatalog): ModelLimitResolver {
  return async (model) => {
    if (catalog === undefined) return undefined;
    try {
      const result = await catalog.list();
      if (!Array.isArray(result?.data)) return undefined;
      return findModelLimits(result.data, model);
    } catch {
      return undefined;
    }
  };
}

export function findModelLimits(
  entries: readonly ModelLimitEntry[],
  model: ModelReference,
): ModelLimits | undefined {
  const entry = entries.find(
    (candidate) =>
      candidate !== undefined &&
      candidate !== null &&
      candidate.providerID === model.providerID &&
      (candidate.modelID === model.id || candidate.id === model.id),
  );
  const limit = entry?.limit;
  if (limit === undefined || limit === null) return undefined;
  if (!isPositiveInt(limit.context) || !isPositiveInt(limit.output)) return undefined;
  if (limit.input !== undefined && !isPositiveInt(limit.input)) return undefined;
  return {
    context: limit.context,
    ...(limit.input !== undefined ? { input: limit.input } : {}),
    output: limit.output,
  };
}

export function computeInputBudget(limits: ModelLimits): number | undefined {
  const reserve = Math.max(Math.floor(limits.context * ADVISOR_RESERVE_FRACTION), limits.output);
  const room = limits.context - reserve;
  const budget = limits.input === undefined ? room : Math.min(limits.input, room);
  return budget > 0 ? budget : undefined;
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}
