// tsup bundles `*.md` imports as text (--loader .md=text); this declares the default-string shape.
declare module "*.md" {
  const content: string;
  export default content;
}
