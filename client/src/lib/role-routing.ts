export type AuthenticatedRouteUser = {
  role?: "user" | "admin" | null;
  platformRole?: "platform_owner" | "platform_admin" | "finance_admin" | null;
};

export function authenticatedHomePath(user: AuthenticatedRouteUser | null | undefined) {
  if (user?.role !== "admin") return "/";
  return user.platformRole === "finance_admin" ? "/finance-admin" : "/admin";
}
