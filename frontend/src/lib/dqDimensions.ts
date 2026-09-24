/** Map a DQ rule_type to one of the standard data-quality dimensions. */
export interface DQDimension {
  key: string;
  label: string;
  color: string;
}

export const DQ_DIMENSIONS: Record<string, DQDimension> = {
  completeness: { key: "completeness", label: "Completeness", color: "#38bdf8" },
  uniqueness: { key: "uniqueness", label: "Uniqueness", color: "#a78bfa" },
  validity: { key: "validity", label: "Validity", color: "#34d399" },
  consistency: { key: "consistency", label: "Consistency", color: "#fbbf24" },
};

export function dimensionForRuleType(ruleType: string): DQDimension {
  switch ((ruleType || "").toUpperCase()) {
    case "NOT_NULL":
      return DQ_DIMENSIONS.completeness;
    case "UNIQUE":
      return DQ_DIMENSIONS.uniqueness;
    case "RANGE":
    case "REGEX":
      return DQ_DIMENSIONS.validity;
    default:
      return DQ_DIMENSIONS.consistency; // CUSTOM and anything else
  }
}
