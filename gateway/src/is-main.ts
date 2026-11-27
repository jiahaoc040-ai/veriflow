/**
 * Is this module the script Node was started with? `import.meta.url === \`file://${process.argv[1]}\`` is false on Windows
 * (file:///D:/x vs D:\x) and for any path with a space or other character a URL encodes, so the CLI silently did nothing.
 * Reported by an outside tester on Windows 11.
 */
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function isMain(moduleUrl: string, argv1: string | undefined = process.argv[1]): boolean {
  if (!argv1) return false;
  const candidates = [argv1];
  try { candidates.push(realpathSync(argv1)); } catch { /* not on disk: compare as given */ }
  return candidates.some((p) => pathToFileURL(p).href === moduleUrl);
}
