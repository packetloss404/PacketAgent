import { validateFileTree, type GeneratedFile } from "./validate.js";

const fixture: GeneratedFile[] = [
  {
    path: "package.json",
    content: `${JSON.stringify(
      {
        name: "packetagent-codegen-validation-fixture",
        private: true,
        type: "module",
      },
      null,
      2,
    )}\n`,
  },
  {
    path: "index.html",
    content:
      '<!doctype html><html><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>\n',
  },
  {
    path: "tsconfig.json",
    content: `${JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "bundler",
          strict: true,
          skipLibCheck: true,
          jsx: "react-jsx",
          noEmit: true,
        },
        include: ["src", "vite.config.ts"],
      },
      null,
      2,
    )}\n`,
  },
  {
    path: "vite.config.ts",
    content:
      'import { defineConfig } from "vite";\nimport react from "@vitejs/plugin-react";\nexport default defineConfig({ plugins: [react()] });\n',
  },
  {
    path: "src/main.tsx",
    content:
      'import React from "react";\nimport { createRoot } from "react-dom/client";\ncreateRoot(document.getElementById("root")!).render(<main>PacketAgent sandbox validation</main>);\n',
  },
];

const result = await validateFileTree(fixture);
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (!result.ok || result.source !== "real") process.exitCode = 1;
