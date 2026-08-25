export function isVercelRuntime(environment: NodeJS.ProcessEnv = process.env) {
  return environment.VERCEL === "1";
}
