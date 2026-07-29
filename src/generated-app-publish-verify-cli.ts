import { verifyGeneratedAppPublishPackage } from "./generated-app-publish-verify.js";

const publishRoot = process.argv[2];
if (!publishRoot) {
  process.stderr.write(
    "Usage: npm run verify:generated-app-publish -- <generated-app-publish-directory>\n",
  );
  process.exitCode = 2;
} else {
  const result = await verifyGeneratedAppPublishPackage(publishRoot);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.status !== "pass") process.exitCode = 1;
}
