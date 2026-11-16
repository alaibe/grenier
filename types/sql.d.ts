// SQL files are imported as text: by esbuild's text loader in the CLI build, by a plugin in vitest.config.ts.
declare module "*.sql" {
  const sql: string;
  export default sql;
}
