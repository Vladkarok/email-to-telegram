export function allowRuleIcon(rule: {
  matchType: string;
  authRequirement?: string | null;
}): string {
  if (rule.authRequirement === "authenticated") return "🔐";
  return rule.matchType === "domain" ? "🌐" : "📧";
}
