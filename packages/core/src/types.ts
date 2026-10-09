/**
 * The canonical domain model lives in `domain/types.ts`.
 * This file re-exports it so existing imports keep working.
 */
export type {
  AdapterResult,
  AdapterSource,
  AffectedTraffic,
  CallEvent,
  Category,
  CompactionRecord,
  CostCalculation,
  Dataset,
  Evidence,
  EvidenceClass,
  Impact,
  OptimizationFinding,
  Organization,
  Project,
  Provider,
  ProviderAdapter,
  Recommendation,
  RecommendationAction,
  RecommendationStatus,
  SavingsEstimate,
  ToolCall,
  UsageEvent,
  VerifyCandidate,
  Window,
  WorkloadCategory,
} from "./domain/types.js";
