/**
 * Runtime version / observability info surfaced via GET /health.
 *
 * Railway auto-injects RAILWAY_GIT_COMMIT_SHA for services deployed from
 * GitHub, so production reports exactly which commit is live without anyone
 * having to hit the Railway GraphQL deployments API. Locally (where the var is
 * absent) we report "unknown".
 */
export function getVersionInfo(): { commit: string; uptimeSeconds: number } {
  const sha = process.env.RAILWAY_GIT_COMMIT_SHA;
  return {
    commit: sha && sha.length > 0 ? sha.slice(0, 7) : "unknown",
    uptimeSeconds: Math.floor(process.uptime()),
  };
}
