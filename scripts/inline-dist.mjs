import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distDir = resolve(rootDir, "dist");
const htmlPath = resolve(distDir, "index.html");
const inlinedAssetPaths = [];

let html = await readFile(htmlPath, "utf8");

html = await inlineStylesheet(html);
html = await inlineModuleScript(html);

await writeFile(htmlPath, html, "utf8");
await Promise.all(inlinedAssetPaths.map((assetPath) => unlink(assetPath)));

const serverDir = resolve(distDir, "server");
await mkdir(serverDir, { recursive: true });
await writeFile(
  resolve(serverDir, "index.js"),
  `export default {
  async fetch(request, env) {
    return env.ASSETS.fetch(request);
  }
};
`,
  "utf8"
);

async function inlineStylesheet(source) {
  return replaceAsync(
    source,
    /<link rel="stylesheet" crossorigin href="(?<href>\.\/assets\/[^"]+\.css)">/,
    async (_match, href) => {
      const assetPath = resolve(distDir, href);
      const css = await readFile(assetPath, "utf8");
      inlinedAssetPaths.push(assetPath);
      return `<style>\n${css}\n</style>`;
    }
  );
}

async function inlineModuleScript(source) {
  return replaceAsync(
    source,
    /<script type="module" crossorigin src="(?<src>\.\/assets\/[^"]+\.js)"><\/script>/,
    async (_match, src) => {
      const assetPath = resolve(distDir, src);
      const js = await readFile(assetPath, "utf8");
      inlinedAssetPaths.push(assetPath);
      const script = `<script>\n${js.replaceAll("</script", "<\\/script")}\n</script>`;
      return {
        inline: "",
        afterReplace: (nextSource) => nextSource.replace("</body>", `    ${script}\n  </body>`)
      };
    }
  );
}

async function replaceAsync(source, pattern, replacer) {
  const match = source.match(pattern);

  if (!match?.groups) {
    throw new Error(`Expected pattern was not found in ${htmlPath}`);
  }

  const replacement = await replacer(match[0], ...Object.values(match.groups));

  if (typeof replacement === "string") {
    return source.replace(pattern, replacement);
  }

  return replacement.afterReplace(source.replace(pattern, replacement.inline));
}
