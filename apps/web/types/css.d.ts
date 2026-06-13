// Allow importing CSS files as side-effect modules.
// Next.js handles CSS bundling via its webpack/turbopack pipeline;
// TypeScript just needs to know these imports are valid.
declare module '*.css' {
  const content: Record<string, string>;
  export default content;
}
