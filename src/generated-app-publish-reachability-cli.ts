import { verifyGeneratedAppReachability } from "./generated-app-publish-reachability.js";

const publishRoot = process.argv[2];
const origin = process.argv[3];
if (!publishRoot || !origin) {
  process.stderr.write(
    "Usage: npm run verify:generated-app-reachability -- <publish-directory> <final-origin>\n",
  );
  process.exitCode = 2;
} else {
  try {
    const result = await verifyGeneratedAppReachability(publishRoot, origin);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (result.status !== "pass") process.exitCode = 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Reachability verification failed.";
    process.stderr.write(`Reachability verification could not start: ${message.slice(0, 1024)}\n`);
    process.exitCode = 1;
  }
}
