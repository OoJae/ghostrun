declare module "*.wasm" {
  const module: WebAssembly.Module;
  export default module;
}
declare module "*?raw" {
  const text: string;
  export default text;
}
