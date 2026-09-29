export type AuthenticatedRouteUser = {
  role?: "user" | "admin" | null;
  platformRole?: "platform_owner" | "platform_admin" | "finance_admin" | "platform_support" | null;
};

export function authenticatedHomePath(user: AuthenticatedRouteUser | null | undefined) {
  if (user?.role !== "admin") return "/workspace";
  if (user.platformRole === "finance_admin") return "/finance-admin";
  return "/admin";
}
