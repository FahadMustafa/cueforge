/** Type declarations for the Claude plugin build (see build-plugin.mjs). */
export interface PluginFile {
  /** Path relative to the plugin root, `/`-separated. */
  path: string;
  bytes: number;
}
export const LIMITS: {
  fileBytes: number;
  files: number;
  readmeWords: number;
  descriptionChars: number;
  skillBodyLines: number;
  scriptLineChars: number;
  iconBytes: number;
  iconMinPx: number;
  iconMaxPx: number;
};
/** `source` is the hand-written plugin folder; when it equals `outDir` only scripts/ is rebuilt. */
export function buildPlugin(options?: { outDir?: string; source?: string }): Promise<PluginFile[]>;
export function checkPlugin(dir: string): Promise<PluginFile[]>;
/** Width and height of a complete PNG, or null. */
export function pngSize(bytes: Uint8Array): { width: number; height: number } | null;
/** The CLI's `VERSION` constant from src/cli/cli.ts. */
export function cliVersion(): Promise<string>;
export function proseWords(markdown: string): number;
