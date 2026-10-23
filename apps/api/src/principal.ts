/** Server-derived identity. Never accepted from the agent or request body. */
export interface Principal {
  userId: string;
  householdId: string;
  role: "OWNER" | "MEMBER" | "VIEWER";
  scope?: "user" | "agent";
  correlationId: string;
}
