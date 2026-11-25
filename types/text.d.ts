// SQL, TOML and CSS files are imported as text: by esbuild's text loader in the builds, by a plugin in vitest.config.ts.
declare module "*.sql" {
  const text: string;
  export default text;
}

declare module "*.toml" {
  const text: string;
  export default text;
}

declare module "*.css" {
  const text: string;
  export default text;
}
