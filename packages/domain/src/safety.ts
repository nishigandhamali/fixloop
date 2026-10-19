export type Hazard = "FIRE_SMOKE" | "ELECTRICAL" | "GAS_FUMES" | "ACTIVE_FLOODING" | "STRUCTURAL" | "UNKNOWN";
export type RiskLevel = "LOW" | "MODERATE" | "HIGH" | "EMERGENCY" | "UNKNOWN";

export const SAFETY_RULE_VERSION = "2026.10-r1";

export interface SafetyAnswers {
  nearElectricalOutlet?: boolean;
  smokeOrBurningSmell?: boolean;
  gasSmell?: boolean;
  waterSpreadingQuickly?: boolean;
  /** Free text from the user; scanned deterministically. */
  freeText?: string;
}

export interface SafetyAssessmentResult {
  riskLevel: RiskLevel;
  hazards: Hazard[];
  escalationRequired: boolean;
  safeResponse: string;
  allowedNextActions: string[];
  ruleVersion: string;
}

const PATTERNS: { hazard: Hazard; re: RegExp }[] = [
  { hazard: "FIRE_SMOKE", re: /\b(fire|flames?|smok(e|ing)|burning|sparks?|sparking)\b/i },
  { hazard: "GAS_FUMES", re: /\b(gas|rotten egg|fumes?|carbon monoxide)\b/i },
  { hazard: "ELECTRICAL", re: /\b(outlet|socket|wir(e|es|ing)|electrocut\w*|shock(ed)?|breaker|live)\b.*\b(water|wet|leak\w*|puddle|dripp\w*)\b|\b(water|wet|leak\w*|puddle)\b.*\b(outlet|socket|wir(e|es|ing)|electrocut\w*|shock(ed)?|breaker)\b/i },
  { hazard: "STRUCTURAL", re: /\b(ceiling (is )?(sagging|collaps\w*)|floor (is )?(sagging|collaps\w*)|collaps\w*)\b/i },
  { hazard: "ACTIVE_FLOODING", re: /\b(flood(ing|ed)?|gushing|spraying|burst pipe|won'?t stop)\b/i },
];

const EMERGENCY_TEMPLATE =
  "This may be dangerous. Move away from the area now. If there is fire, smoke, a gas smell, or water near electrical equipment, " +
  "leave and call your local emergency number from a safe place. Do not touch the appliance, outlets or wiring, and do not try to repair it. " +
  "I am an informational assistant, not an emergency service, and I have not contacted anyone for you.";

/**
 * Deterministic, conservative classifier. Runs BEFORE any generated troubleshooting.
 * Injection-resistant: it only reads user-provided answers/text; escalation cannot be
 * downgraded by later input within the same assessment (callers must take max of history).
 */
export function assessSafety(answers: SafetyAnswers): SafetyAssessmentResult {
  const hazards = new Set<Hazard>();
  if (answers.smokeOrBurningSmell) hazards.add("FIRE_SMOKE");
  if (answers.gasSmell) hazards.add("GAS_FUMES");
  if (answers.nearElectricalOutlet) hazards.add("ELECTRICAL");
  if (answers.waterSpreadingQuickly) hazards.add("ACTIVE_FLOODING");
  for (const { hazard, re } of PATTERNS) if (answers.freeText && re.test(answers.freeText)) hazards.add(hazard);

  const answered =
    answers.nearElectricalOutlet !== undefined &&
    answers.smokeOrBurningSmell !== undefined &&
    answers.gasSmell !== undefined &&
    answers.waterSpreadingQuickly !== undefined;

  const emergency = hazards.has("FIRE_SMOKE") || hazards.has("GAS_FUMES") || hazards.has("ELECTRICAL") || hazards.has("STRUCTURAL");
  if (emergency) {
    return { riskLevel: "EMERGENCY", hazards: [...hazards], escalationRequired: true, safeResponse: EMERGENCY_TEMPLATE,
      allowedNextActions: ["SHOW_EMERGENCY_GUIDANCE", "RECORD_OUTCOME"], ruleVersion: SAFETY_RULE_VERSION };
  }
  if (hazards.has("ACTIVE_FLOODING")) {
    return { riskLevel: "HIGH", hazards: [...hazards], escalationRequired: true,
      safeResponse: "Water is spreading. Only if it is safe and the area around it is dry and away from electrical items, shutting off the water supply valve to the appliance may help. If you are unsure, stay clear and contact a licensed plumber or your local emergency number. I have not contacted anyone for you.",
      allowedNextActions: ["SHOW_EMERGENCY_GUIDANCE", "RECORD_OUTCOME"], ruleVersion: SAFETY_RULE_VERSION };
  }
  if (!answered) {
    // Abstain: treat missing answers conservatively. No ordinary workflow yet.
    return { riskLevel: "UNKNOWN", hazards: ["UNKNOWN"], escalationRequired: false,
      safeResponse: "Before anything else: is any water near an electrical outlet or cord, do you smell gas or smoke, and is water spreading quickly?",
      allowedNextActions: ["ANSWER_SAFETY_QUESTIONS"], ruleVersion: SAFETY_RULE_VERSION };
  }
  return { riskLevel: "LOW", hazards: [], escalationRequired: false,
    safeResponse: "No immediate hazard was reported. Avoid running the appliance until it is checked, and wipe up water only if the floor around it is dry of electrical items.",
    allowedNextActions: ["GATHER_EVIDENCE", "DRAFT_REPAIR_REQUEST"], ruleVersion: SAFETY_RULE_VERSION };
}

const RANK: Record<RiskLevel, number> = { LOW: 0, UNKNOWN: 1, MODERATE: 2, HIGH: 3, EMERGENCY: 4 };
/** Escalation is sticky: a later benign answer can never lower a recorded risk. */
export function maxRisk(a: RiskLevel, b: RiskLevel): RiskLevel {
  return RANK[a] >= RANK[b] ? a : b;
}
